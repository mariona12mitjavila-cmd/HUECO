(function(){
  'use strict';

  var CFG = window.PLAZAS_CONFIG || {};
  var REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  var GRACE = 10*60000;          // un aviso sigue visible 10 min después de la hora prevista
  var POLL = 20000;              // refresco de avisos del servidor
  var CACHE_KEY = 'plazas-calles-v1';
  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  var COLORS = {ok:'#1e9e55', warn:'#d98e12', none:'#8a969d'};
  var ETAS = [{l:'Ahora',m:0},{l:'5 min',m:5},{l:'10 min',m:10},{l:'15 min',m:15},{l:'30 min',m:30}];
  var STAYS = [{l:'30 min',m:30},{l:'1 h',m:60},{l:'2 h',m:120},{l:'4 h',m:240},{l:'No lo sé',m:null}];

  /* ---------- utilidades ---------- */
  function $(id){ return document.getElementById(id); }
  function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function norm(t){ return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim(); }
  function setHTML(el,h){ if(el._h!==h){ el.innerHTML=h; el._h=h; } }
  function uuid(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var s='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return s.replace(/[xy]/g,function(c){ var r=Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); });
  }
  function hhmm(ms){ var d=new Date(ms); return (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

  var DEVICE = lsGet('plazas-device');
  if(!DEVICE){ DEVICE = uuid(); lsSet('plazas-device',DEVICE); }

  var S = {
    streets:[], byKey:{}, reports:[], pos:null, posAt:0,
    view:'list', filter:'avisos', text:'', selected:null,
    form:null, mine:null, watch:null, seen:{}, notice:'', loading:true, error:''
  };
  var map=null, polys={}, pins={}, posMarker=null;

  /* ---------- geometría ---------- */
  function metersFrom(lat0,lon0,lat,lon){
    return [(lon-lon0)*111320*Math.cos(lat0*Math.PI/180), (lat-lat0)*110540];
  }
  function segDist(p,a,b){
    var vx=b[0]-a[0], vy=b[1]-a[1], l2=vx*vx+vy*vy, t=l2?((p[0]-a[0])*vx+(p[1]-a[1])*vy)/l2:0;
    t=Math.max(0,Math.min(1,t));
    var dx=p[0]-(a[0]+vx*t), dy=p[1]-(a[1]+vy*t);
    return Math.sqrt(dx*dx+dy*dy);
  }
  function distToStreet(st,pos){
    var best=Infinity;
    st.segs.forEach(function(seg){
      var pts=seg.map(function(q){ return metersFrom(pos[0],pos[1],q[0],q[1]); });
      for(var i=1;i<pts.length;i++) best=Math.min(best,segDist([0,0],pts[i-1],pts[i]));
    });
    return best;
  }
  function distLabel(d){ return d<1000?(Math.round(d/10)*10)+' m':(d/1000).toFixed(1)+' km'; }

  /* ---------- calles reales (OpenStreetMap) ---------- */
  function buildStreets(osm){
    var by={};
    (osm.elements||[]).forEach(function(w){
      if(w.type!=='way'||!w.geometry||!w.tags||!w.tags.name) return;
      var pts=w.geometry.map(function(g){ return [g.lat,g.lon]; });
      if(pts.length<2) return;
      var k=norm(w.tags.name);
      var s=by[k]||(by[k]={key:k,name:w.tags.name,segs:[]});
      s.segs.push(pts);
    });
    return Object.keys(by).map(function(k){ return by[k]; });
  }
  function fetchOverpass(i,errs){
    errs=errs||[];
    if(i>=ENDPOINTS.length) return Promise.reject(new Error(errs.join(' · ')||'sin respuesta'));
    var b=CFG.BBOX||[41.484,2.358,41.545,2.425];
    var q='[out:json][timeout:40];way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"]["name"]('+b.join(',')+');out geom;';
    var ctl=(typeof AbortController!=='undefined')?new AbortController():null;
    var timer=ctl?setTimeout(function(){ ctl.abort(); },30000):null;
    var opts={method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'data='+encodeURIComponent(q)};
    if(ctl) opts.signal=ctl.signal;
    return fetch(ENDPOINTS[i],opts)
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(j){ if(timer) clearTimeout(timer); if(!j||!j.elements||!j.elements.length) throw new Error('sin datos'); return j; })
      .catch(function(e){ if(timer) clearTimeout(timer); errs.push(ENDPOINTS[i].split('/')[2]+': '+(e&&e.name==='AbortError'?'tardó demasiado':(e&&e.message)||'error')); return fetchOverpass(i+1,errs); });
  }
  function loadStreets(){
    var c=lsGet(CACHE_KEY);
    if(c){ try{ var d=JSON.parse(c); if(d&&d.length>10) return Promise.resolve(d); }catch(e){} }
    return fetchOverpass(0).then(function(osm){
      var d=buildStreets(osm);
      if(d.length<5) throw new Error('muy pocas calles');
      lsSet(CACHE_KEY,JSON.stringify(d));
      return d;
    });
  }

  /* ---------- servidor de avisos (Supabase) o modo demo (solo este navegador) ---------- */
  function api(path,opt){
    opt=opt||{};
    var h={apikey:CFG.SUPABASE_ANON_KEY,'Content-Type':'application/json'};
    // Las claves antiguas (anon) son JWT y se envían también como Bearer; las nuevas (sb_publishable_…) solo en «apikey».
    if(/^eyJ/.test(CFG.SUPABASE_ANON_KEY)) h.Authorization='Bearer '+CFG.SUPABASE_ANON_KEY;
    return fetch(CFG.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/'+path,{method:opt.method||'GET',headers:h,body:opt.body?JSON.stringify(opt.body):undefined})
      .then(function(r){
        if(!r.ok&&r.status!==409) throw new Error('HTTP '+r.status);
        return r.text().then(function(t){ return t?JSON.parse(t):null; });
      });
  }
  var backend;
  if(REMOTE){
    backend={
      list:function(){ return api('reports_public?select=*&order=created_at.desc&limit=600'); },
      add:function(r){ return api('reports',{method:'POST',body:{id:r.id,street:r.street,street_name:r.street_name,event:r.event,eta_min:r.eta_min,device:DEVICE}}); },
      vote:function(id,v){ return api('votes',{method:'POST',body:{report_id:id,device:DEVICE,vote:v}}); },
      cancel:function(id){ return api('rpc/cancel_report',{method:'POST',body:{p_id:id,p_device:DEVICE}}); }
    };
  }else{
    var local=function(){ try{ return JSON.parse(lsGet('plazas-demo')||'[]'); }catch(e){ return []; } };
    var save=function(a){ lsSet('plazas-demo',JSON.stringify(a.slice(-200))); };
    backend={
      list:function(){ return Promise.resolve(local().filter(function(r){ return !r.cancelled; })); },
      add:function(r){ var a=local(); a.push({id:r.id,street:r.street,street_name:r.street_name,event:r.event,eta_min:r.eta_min,created_at:new Date().toISOString(),confirms:0,denies:0}); save(a); return Promise.resolve(); },
      vote:function(id,v){ var a=local(); a.forEach(function(r){ if(r.id===id){ if(v>0) r.confirms++; else r.denies++; } }); save(a); return Promise.resolve(); },
      cancel:function(id){ var a=local(); a.forEach(function(r){ if(r.id===id) r.cancelled=true; }); save(a); return Promise.resolve(); }
    };
  }
  function seedDemo(){
    // Avisos de prueba para ver la app viva en modo demo.
    var a=[]; try{ a=JSON.parse(lsGet('plazas-demo')||'[]'); }catch(e){}
    var recent=a.filter(function(r){ return Date.now()-Date.parse(r.created_at)<20*60000; }).length;
    if(recent>=4||!S.streets.length) return;
    for(var i=recent;i<5;i++){
      var st=S.streets[Math.floor(Math.random()*S.streets.length)];
      a.push({id:uuid(),street:st.key,street_name:st.name,event:'leaving',eta_min:[0,3,5,8,12,20][Math.floor(Math.random()*6)],
              created_at:new Date(Date.now()-Math.floor(Math.random()*4)*60000).toISOString(),confirms:Math.floor(Math.random()*3),denies:0,demo:true});
    }
    lsSet('plazas-demo',JSON.stringify(a.slice(-200)));
  }

  /* ---------- avisos activos ---------- */
  function normReport(r){
    var created=Date.parse(r.created_at);
    return {id:r.id,street:r.street,name:r.street_name,event:r.event,createdAt:created,
            etaAt:created+(r.eta_min||0)*60000,eta_min:r.eta_min,conf:r.confirms||0,deny:r.denies||0};
  }
  function activeAlerts(key){
    var now=Date.now();
    return S.reports.filter(function(r){
      return r.event==='leaving' && (!key||r.street===key) && now<=r.etaAt+GRACE && (1+r.conf-1.5*r.deny)>0;
    }).sort(function(a,b){ return a.etaAt-b.etaAt; });
  }
  function statusOf(key){
    var al=activeAlerts(key), now=Date.now();
    if(!al.length) return 'none';
    return al.some(function(r){ return r.etaAt-now<=15*60000; })?'ok':'warn';
  }
  function etaText(r){
    var d=Math.round((r.etaAt-Date.now())/60000);
    if(d>1) return 'sale en '+d+' min';
    if(d>=0) return 'se va ahora';
    return 'se fue hace '+(-d)+' min';
  }
  function refresh(){
    return backend.list().then(function(rows){
      S.reports=(rows||[]).map(normReport);
      S.error='';
      checkWatch();
    }).catch(function(e){ S.error='No se pudieron cargar los avisos ('+e.message+'). Se reintentará.'; });
  }
  function checkWatch(){
    var now=Date.now(), fresh=[];
    activeAlerts().forEach(function(r){
      if(S.seen[r.id]) return;
      S.seen[r.id]=true;
      if(r.createdAt<now-60000 && S.firstLoadDone) return;
      if(S.mine&&S.mine.id===r.id) return;
      var hit=false, st=S.byKey[r.street];
      if(S.watch&&S.watch.type==='street'&&S.watch.key===r.street) hit=true;
      if(S.watch&&S.watch.type==='near'&&S.pos&&st&&distToStreet(st,S.pos)<=500) hit=true;
      if(hit) fresh.push(r);
    });
    S.firstLoadDone=true;
    if(fresh.length){
      S.notice='Plaza que se libera: '+fresh[0].name+' ('+etaText(fresh[0])+').';
      try{ if(navigator.vibrate) navigator.vibrate([200,100,200]); }catch(e){}
    }
  }

  /* ---------- ubicación ---------- */
  function locate(cb){
    if(!navigator.geolocation){ S.notice='Tu navegador no da la ubicación. Elige la calle a mano.'; if(cb) cb(false); return; }
    navigator.geolocation.getCurrentPosition(function(p){
      S.pos=[p.coords.latitude,p.coords.longitude]; S.posAt=Date.now();
      if(cb) cb(true);
    },function(){
      S.notice='No he podido ver tu ubicación. Revisa el permiso o elige la calle a mano.'; if(cb) cb(false);
    },{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
  }
  function nearest(n){
    if(!S.pos) return [];
    return S.streets.map(function(s){ return {s:s,d:distToStreet(s,S.pos)}; })
      .sort(function(a,b){ return a.d-b.d; }).slice(0,n);
  }

  /* ---------- mapa ---------- */
  function initMap(){
    map=L.map('map',{zoomControl:false,attributionControl:false});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
    var all=[];
    S.streets.forEach(function(st){
      var p=L.polyline(st.segs,{weight:4,opacity:.55,color:COLORS.none,lineCap:'round'}).addTo(map);
      p.on('click',function(){ openStreet(st.key,false); });
      polys[st.key]=p; st.segs.forEach(function(s){ all=all.concat(s); });
    });
    map.fitBounds(L.latLngBounds(all),{padding:[20,20]});
  }
  function renderMap(){
    if(!map) return;
    var counts={};
    activeAlerts().forEach(function(r){ counts[r.street]=(counts[r.street]||0)+1; });
    S.streets.forEach(function(st){
      var status=statusOf(st.key), sel=S.selected===st.key, sig=status+'|'+(sel?1:0);
      var p=polys[st.key];
      if(p._sig!==sig){
        p._sig=sig;
        p.setStyle({color:COLORS[status],weight:status==='none'?(sel?8:4):(sel?10:7),opacity:status==='none'?(sel?.95:.55):.95});
        if(status!=='none'||sel) p.bringToFront();
      }
    });
    Object.keys(pins).forEach(function(k){ if(!counts[k]){ map.removeLayer(pins[k]); delete pins[k]; } });
    Object.keys(counts).forEach(function(k){
      var st=S.byKey[k]; if(!st) return;
      var m=st.segs[0][Math.floor(st.segs[0].length/2)];
      var html='<div class="pin '+statusOf(k)+'">'+counts[k]+'</div>';
      if(!pins[k]){
        pins[k]=L.marker(m,{icon:L.divIcon({className:'pinwrap',html:html,iconSize:[28,28]}),keyboard:false}).addTo(map);
        pins[k].on('click',function(){ openStreet(k,false); });
        pins[k]._html=html;
      }else if(pins[k]._html!==html){
        pins[k].setIcon(L.divIcon({className:'pinwrap',html:html,iconSize:[28,28]})); pins[k]._html=html;
      }
    });
    if(S.pos){
      if(posMarker) map.removeLayer(posMarker);
      posMarker=L.circleMarker(S.pos,{radius:8,color:'#fff',weight:3,fillColor:'#4285f4',fillOpacity:1,interactive:false}).addTo(map);
    }
  }
  function openStreet(key,fit){
    S.selected=key; S.view='street'; S.form=null;
    $('app').className='full';
    var p=polys[key];
    if(fit&&map&&p) map.fitBounds(p.getBounds(),{maxZoom:18,padding:[60,60]});
    render();
  }

  /* ---------- hoja inferior ---------- */
  function alertRow(r,withVotes){
    var h='<div class="ann"><div><div class="t">'+(withVotes?'':esc(r.name)+' · ')+etaText(r)+'</div><div class="s">'+hhmm(r.etaAt)+' · '+r.conf+' confirmaciones'+(r.deny?' · '+r.deny+' dudas':'')+'</div></div>';
    if(withVotes){
      var voted=S.voted&&S.voted[r.id];
      h+='<div class="mini"><button type="button" data-act="vote" data-id="'+r.id+'" data-v="1"'+(voted?' disabled':'')+'>'+(voted?'Gracias':'Sigue ahí')+'</button>';
      if(!voted) h+='<button type="button" data-act="vote" data-id="'+r.id+'" data-v="-1">Ya no está</button>';
      h+='</div>';
    }
    return h+'</div>';
  }
  function listHTML(){
    var h='';
    if(!REMOTE) h+='<p class="demo">Modo demo: los avisos son de prueba y solo existen en tu navegador. Para que los vecinos compartan avisos hay que conectar el servidor (ver la guía).</p>';
    if(S.error) h+='<p class="demo" style="color:var(--bad)">'+esc(S.error)+'</p>';
    if(S.mine){
      var m=S.mine;
      h+='<div class="mycar"><b>'+(m.event==='leaving'?'Tu aviso: te vas de ':'Has aparcado en ')+esc(m.name)+'</b>';
      if(m.event==='leaving') h+='<p class="note" style="margin-top:2px">'+(m.etaAt>Date.now()?'Sobre las '+hhmm(m.etaAt):'Aviso activo ahora')+'. Caduca 10 min después.</p>';
      h+='<div class="actions"><button type="button" class="btn" data-act="mine-done">'+(m.event==='leaving'?'Cancelar aviso':'Quitar')+'</button>';
      if(m.event==='parked') h+='<button type="button" class="btn primary" data-act="leave-from-mine">Me voy ya</button>';
      h+='</div></div>';
    }
    h+='<div class="row"><h2 style="font-size:16px">'+(S.filter==='avisos'?'Plazas que se liberan':'Todas las calles')+'</h2>';
    h+='<button type="button" class="btn" data-act="watch-near" aria-pressed="'+(S.watch&&S.watch.type==='near')+'">'+(S.watch&&S.watch.type==='near'?'Avisándote ✓':'Avisarme cerca de mí')+'</button></div>';
    var q=norm(S.text), rows;
    if(S.filter==='avisos'&&!q){
      var by={};
      activeAlerts().forEach(function(r){ if(!by[r.street]) by[r.street]={key:r.street,name:r.name,first:r,n:0}; by[r.street].n++; });
      rows=Object.keys(by).map(function(k){ return by[k]; });
      rows.forEach(function(x){ var st=S.byKey[x.key]; x.d=(S.pos&&st)?distToStreet(st,S.pos):null; });
      rows.sort(function(a,b){ if(a.d!==null&&b.d!==null) return a.d-b.d; return a.first.etaAt-b.first.etaAt; });
      rows.slice(0,30).forEach(function(x){
        h+='<button type="button" class="srow" data-act="street" data-key="'+esc(x.key)+'"><span><span class="sname">'+esc(x.name)+'</span><span class="ssub">'+(x.d!==null?distLabel(x.d)+' · ':'')+etaText(x.first)+'</span></span><span class="pill '+statusOf(x.key)+'">'+x.n+' aviso'+(x.n===1?'':'s')+'</span></button>';
      });
      if(!rows.length) h+='<p class="note">Ahora mismo no hay avisos de salida. Cuando alguien se vaya y pulse «Me voy», aparecerá aquí. Sé el primero.</p>';
    }else{
      var list=S.streets.filter(function(s){ return !q||s.key.indexOf(q)>=0; });
      list.slice(0,30).forEach(function(s){
        var n=activeAlerts(s.key).length;
        h+='<button type="button" class="srow" data-act="street" data-key="'+esc(s.key)+'"><span><span class="sname">'+esc(s.name)+'</span></span>'+(n?'<span class="pill '+statusOf(s.key)+'">'+n+' aviso'+(n===1?'':'s')+'</span>':'<span class="pill">Sin avisos</span>')+'</button>';
      });
      if(!list.length) h+='<p class="note">Ninguna calle coincide.</p>';
    }
    h+='<p class="note">Los avisos son orientativos y no garantizan que haya plaza. Anónimo: sin registro y sin guardar tu recorrido. Mapa © colaboradores de OpenStreetMap.</p>';
    return h;
  }
  function streetHTML(){
    var st=S.byKey[S.selected]; if(!st) return listHTML();
    var al=activeAlerts(st.key), watching=S.watch&&S.watch.type==='street'&&S.watch.key===st.key;
    var h='<button type="button" class="back" data-act="back">← Volver</button>';
    h+='<div class="row"><h2 style="font-size:18px">'+esc(st.name)+'</h2><span class="pill '+statusOf(st.key)+'">'+(al.length?al.length+' aviso'+(al.length===1?'':'s'):'Sin avisos')+'</span></div>';
    h+='<div class="actions"><button type="button" class="btn primary" data-act="form" data-kind="leaving" data-key="'+esc(st.key)+'">Me voy de aquí</button>';
    h+='<button type="button" class="btn" data-act="form" data-kind="parked" data-key="'+esc(st.key)+'">He aparcado aquí</button>';
    h+='<button type="button" class="btn" data-act="watch-street" data-key="'+esc(st.key)+'">'+(watching?'Avisándote ✓':'Avísame de esta calle')+'</button></div>';
    h+='<h3 style="font-size:14px;margin-top:16px">Salidas avisadas</h3>';
    if(!al.length) h+='<p class="note">Nadie ha avisado de su salida en esta calle ahora mismo.</p>';
    al.forEach(function(r){ h+=alertRow(r,true); });
    return h;
  }
  function formHTML(){
    var f=S.form, h='<button type="button" class="back" data-act="back">← Cancelar</button>';
    h+='<h2 style="font-size:18px">'+(f.kind==='leaving'?'Me voy y dejo la plaza':'He aparcado')+'</h2>';
    h+='<p class="note" style="color:var(--ink);font-weight:600;margin-top:10px">¿En qué calle?</p><div class="chips2">';
    var cands=nearest(4);
    if(f.key&&!cands.some(function(c){ return c.s.key===f.key; })&&S.byKey[f.key]) cands.unshift({s:S.byKey[f.key],d:S.pos?distToStreet(S.byKey[f.key],S.pos):null});
    cands.forEach(function(c){
      h+='<button type="button" class="chip'+(f.key===c.s.key?' on':'')+'" data-act="pick" data-key="'+esc(c.s.key)+'">'+esc(c.s.name)+(c.d!==null?' · '+distLabel(c.d):'')+'</button>';
    });
    if(!S.pos) h+='<button type="button" class="btn" data-act="locate-form">Usar mi ubicación</button>';
    h+='</div><input id="fq" class="inp" type="search" placeholder="Buscar otra calle…" value="'+esc(f.q||'')+'" autocomplete="off">';
    if(f.q){
      var q=norm(f.q);
      h+='<div class="chips2">';
      S.streets.filter(function(s){ return s.key.indexOf(q)>=0; }).slice(0,6).forEach(function(s){
        h+='<button type="button" class="chip" data-act="pick" data-key="'+esc(s.key)+'">'+esc(s.name)+'</button>';
      });
      h+='</div>';
    }
    h+='<p class="note" style="color:var(--ink);font-weight:600;margin-top:14px">'+(f.kind==='leaving'?'¿Cuándo te vas?':'¿Cuánto tiempo estarás?')+'</p><div class="chips2">';
    (f.kind==='leaving'?ETAS:STAYS).forEach(function(e,i){
      h+='<button type="button" class="chip'+(f.eta===e.m?' on':'')+'" data-act="eta" data-i="'+i+'">'+e.l+'</button>';
    });
    h+='</div><div class="actions"><button type="button" class="btn primary" data-act="send"'+(f.key?'':' disabled')+'>'+(f.kind==='leaving'?'Enviar aviso':'Guardar')+'</button></div>';
    if(f.kind==='leaving') h+='<p class="note">El aviso caduca 10 minutos después de la hora indicada. Solo se envía la calle y la hora, nunca tu ubicación exacta.</p>';
    return h;
  }
  function render(){
    var chips=document.querySelectorAll('[data-act="filter"]');
    for(var i=0;i<chips.length;i++) chips[i].setAttribute('aria-pressed',String(chips[i].getAttribute('data-f')===S.filter));
    var t='';
    if(S.notice) t='<div class="banner ok"><span>'+esc(S.notice)+'</span><button type="button" data-act="dismiss" aria-label="Cerrar">×</button></div>';
    setHTML($('toast'),t);
    var body = S.view==='form'&&S.form ? formHTML() : (S.view==='street' ? streetHTML() : listHTML());
    // El campo de búsqueda del formulario conserva el foco: solo se repinta si cambia el HTML.
    if($('sheetbody')._h!==body){
      var keep=document.activeElement&&document.activeElement.id==='fq';
      $('sheetbody').innerHTML=body; $('sheetbody')._h=body;
      if(keep&&$('fq')){ $('fq').focus(); var v=$('fq').value; $('fq').setSelectionRange(v.length,v.length); }
    }
    renderMap();
  }

  /* ---------- acciones ---------- */
  function openForm(kind,key){
    S.form={kind:kind,key:key||null,eta:kind==='leaving'?10:60,q:''};
    S.view='form'; $('app').className='full';
    if(!S.pos||Date.now()-S.posAt>120000){
      locate(function(ok){
        if(ok&&S.form&&!S.form.key){ var n=nearest(1)[0]; if(n&&n.d<150) S.form.key=n.s.key; }
        render();
      });
    }else if(!S.form.key){ var n=nearest(1)[0]; if(n&&n.d<150) S.form.key=n.s.key; }
    render();
  }
  function send(){
    var f=S.form; if(!f||!f.key) return;
    var st=S.byKey[f.key];
    var r={id:uuid(),street:st.key,street_name:st.name,event:f.kind,eta_min:f.eta===null?null:f.eta};
    backend.add(r).then(function(){
      var created=Date.now();
      S.mine={id:r.id,event:r.event,street:st.key,name:st.name,etaAt:created+(f.eta||0)*60000};
      S.notice=f.kind==='leaving'?'Aviso enviado. Gracias: mañana te avisan a ti.':'Guardado.';
      S.view='list'; S.form=null; S.seen[r.id]=true;
      return refresh();
    }).then(render).catch(function(e){ S.notice='No se pudo enviar ('+e.message+'). Inténtalo otra vez.'; render(); });
  }

  document.addEventListener('click',function(ev){
    var b=ev.target.closest?ev.target.closest('[data-act]'):null; if(!b) return;
    var a=b.getAttribute('data-act');
    if(a==='sheet'){ $('app').className=($('app').className==='full')?'':'full'; return; }
    if(a==='filter'){ S.filter=b.getAttribute('data-f'); S.view='list'; }
    else if(a==='street') openStreet(b.getAttribute('data-key'),true);
    else if(a==='back'){ S.view='list'; S.form=null; }
    else if(a==='form'){ openForm(b.getAttribute('data-kind'),b.getAttribute('data-key')); return; }
    else if(a==='pick'){ S.form.key=b.getAttribute('data-key'); S.form.q=''; }
    else if(a==='eta'){ var arr=S.form.kind==='leaving'?ETAS:STAYS; S.form.eta=arr[Number(b.getAttribute('data-i'))].m; }
    else if(a==='locate-form'){ locate(function(ok){ if(ok&&S.form&&!S.form.key){ var n=nearest(1)[0]; if(n) S.form.key=n.s.key; } render(); }); return; }
    else if(a==='send'){ send(); return; }
    else if(a==='locate'){ locate(function(ok){ if(ok&&map) map.setView(S.pos,17); S.view='list'; render(); }); return; }
    else if(a==='watch-near'){
      if(S.watch&&S.watch.type==='near') S.watch=null;
      else{ S.watch={type:'near'}; if(!S.pos) locate(function(){ render(); }); S.notice='Te avisaremos de plazas que se liberen a menos de 500 m.'; }
    }
    else if(a==='watch-street'){
      var k=b.getAttribute('data-key');
      S.watch=(S.watch&&S.watch.type==='street'&&S.watch.key===k)?null:{type:'street',key:k};
    }
    else if(a==='vote'){
      var id=b.getAttribute('data-id'), v=Number(b.getAttribute('data-v'));
      S.voted=S.voted||{}; S.voted[id]=true;
      backend.vote(id,v).then(refresh).then(render);
    }
    else if(a==='mine-done'){
      var m=S.mine; S.mine=null;
      if(m&&m.event==='leaving') backend.cancel(m.id).then(refresh).then(render);
    }
    else if(a==='leave-from-mine'){ var key=S.mine&&S.mine.street; S.mine=null; openForm('leaving',key); return; }
    else if(a==='dismiss') S.notice='';
    render();
  });
  document.addEventListener('input',function(e){
    if(e.target&&e.target.id==='fq'&&S.form){ S.form.q=e.target.value; render(); }
    if(e.target&&e.target.id==='q'){ S.text=e.target.value; S.view='list'; render(); }
  });

  /* ---------- arranque ---------- */
  function start(){
    $('sheetbody').innerHTML='<p class="note">Cargando las calles de '+esc(CFG.PLACE_LABEL||'tu zona')+'…</p>'; $('sheetbody')._h=null;
    loadStreets().then(function(d){
      S.streets=d.map(function(s){ return {key:s.key,name:s.name,segs:s.segs}; });
      S.streets.forEach(function(s){ S.byKey[s.key]=s; });
      if(!REMOTE) seedDemo();
      initMap();
      return refresh();
    }).then(function(){
      S.loading=false; render();
      setInterval(function(){ if(!REMOTE) seedDemo(); refresh().then(render); },POLL);
      setInterval(render,5000);
    }).catch(function(err){
      $('sheetbody').innerHTML='<p style="font-weight:600">No se han podido descargar las calles.</p><p class="note">Comprueba la conexión y pulsa Reintentar. Los servidores gratuitos de mapas a veces están saturados.</p><p class="note" style="font-size:12px">Detalle: '+esc(err.message)+'</p><div class="actions"><button type="button" class="btn primary" id="retry">Reintentar</button></div>';
      $('retry').addEventListener('click',start);
    });
  }
  if('serviceWorker' in navigator){ window.addEventListener('load',function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); }); }
  start();
})();
