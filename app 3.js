(function(){
  'use strict';
  var CFG = window.PLAZAS_CONFIG || {};
  var REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  var TTL = 10*60000;            // un hueco avisado dura 10 minutos
  var POLL = 15000;              // refresco de avisos
  var NEAR_M = 600;              // «cerca» = 600 m
  var MERGE_M = 20;              // «he aparcado» a menos de 20 m de un hueco lo ocupa
  var COOLDOWN = 90000;          // 1,5 min entre avisos del mismo dispositivo
  var CACHE_KEY = 'plazas-calles-v1';
  var B = CFG.BBOX || [41.484,2.358,41.545,2.425];
  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];

  function $(id){ return document.getElementById(id); }
  function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function norm(t){ return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
  function uuid(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){ var r=Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); });
  }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function round4(x){ return Math.round(x*10000)/10000; }
  var DEVICE = lsGet('plazas-device');
  if(!DEVICE){ DEVICE = uuid(); lsSet('plazas-device',DEVICE); }

  var S = { pos:null, reports:[], spots:[], streets:[], sel:null, voted:{}, seen:{}, firstLoad:false, notice:null, lastSend:0, centered:false, error:'' };
  var map=null, markers={}, meMarker=null, toastTimer=null;

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

  function distPt(a,b){ var m=metersFrom(a[0],a[1],b[0],b[1]); return Math.sqrt(m[0]*m[0]+m[1]*m[1]); }
  function distLabel(d){ return d<1000?(Math.round(d/10)*10)+' m':(d/1000).toFixed(1)+' km'; }
  function agoText(ms){ var m=Math.floor((Date.now()-ms)/60000); return m<1?'ahora mismo':'hace '+m+' min'; }
  function streetNameAt(p){
    var best=Infinity, name='';
    S.streets.forEach(function(st){
      st.segs.forEach(function(seg){
        for(var i=1;i<seg.length;i++){
          var a=metersFrom(p[0],p[1],seg[i-1][0],seg[i-1][1]), b=metersFrom(p[0],p[1],seg[i][0],seg[i][1]);
          var d=segDist([0,0],a,b); if(d<best){ best=d; name=st.name; }
        }
      });
    });
    return best<60?name:'';
  }
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
  function fetchTile(b,i,errs){
    if(i>=ENDPOINTS.length) return Promise.reject(new Error(errs.join(' · ')||'sin respuesta'));
    var q='[out:json][timeout:25];way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"]["name"]('+b.join(',')+');out geom;';
    var ctl=(typeof AbortController!=='undefined')?new AbortController():null;
    var timer=ctl?setTimeout(function(){ ctl.abort(); },20000):null;
    var host=ENDPOINTS[i].split('/')[2];
    var opts={};
    if(ctl) opts.signal=ctl.signal;
    // GET sencillo: evita problemas de CORS/preflight en Safari
    return fetch(ENDPOINTS[i]+'?data='+encodeURIComponent(q),opts)
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(j){ if(timer) clearTimeout(timer); if(!j||!j.elements) throw new Error('sin datos'); return j.elements; })
      .catch(function(e){ if(timer) clearTimeout(timer); errs.push(host+': '+(e&&e.name==='AbortError'?'tardó demasiado':(e&&e.message)||'error')); return fetchTile(b,i+1,errs); });
  }
  function fetchOverpass(){
    var b=CFG.BBOX||[41.484,2.358,41.545,2.425];
    var mlat=(b[0]+b[2])/2, mlon=(b[1]+b[3])/2;
    var tiles=[[b[0],b[1],mlat,mlon],[b[0],mlon,mlat,b[3]],[mlat,b[1],b[2],mlon],[mlat,mlon,b[2],b[3]]];
    var errs=[], all=[];
    // un trozo cada vez para no saturar el servidor gratuito
    return tiles.reduce(function(p,t){
      return p.then(function(){ return fetchTile(t,0,errs).then(function(els){ all=all.concat(els); }); });
    },Promise.resolve()).then(function(){
      if(!all.length) throw new Error('sin datos');
      var seen={}; all=all.filter(function(w){ if(seen[w.id]) return false; seen[w.id]=1; return true; });
      return {elements:all};
    });
  }
  function loadStreets(){
    var c=lsGet(CACHE_KEY);
    if(c){ try{ var d=JSON.parse(c); if(d&&d.length>10) return Promise.resolve(d); }catch(e){} }
    return fetchOverpass().then(function(osm){
      var d=buildStreets(osm);
      if(d.length<5) throw new Error('muy pocas calles');
      lsSet(CACHE_KEY,JSON.stringify(d));
      return d;
    });
  }

  /* ---------- servidor de avisos (Supabase) o modo demo ---------- */
  function api(path,opt){
    opt=opt||{};
    var h={apikey:CFG.SUPABASE_ANON_KEY,'Content-Type':'application/json'};
    if(/^eyJ/.test(CFG.SUPABASE_ANON_KEY)) h.Authorization='Bearer '+CFG.SUPABASE_ANON_KEY;
    return fetch(CFG.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/'+path,{method:opt.method||'GET',headers:h,body:opt.body?JSON.stringify(opt.body):undefined})
      .then(function(r){
        if(!r.ok&&r.status!==409) return r.text().then(function(t){ throw new Error('HTTP '+r.status+(t?' '+t.slice(0,80):'')); });
        return r.text().then(function(t){ return t?JSON.parse(t):null; });
      });
  }
  var backend;
  if(REMOTE){
    backend={
      list:function(){
        var since=new Date(Date.now()-30*60000).toISOString();
        return api('reports_public?select=*&order=created_at.desc&limit=500&created_at=gte.'+encodeURIComponent(since));
      },
      add:function(r){ return api('reports',{method:'POST',body:{id:r.id,street:r.street,street_name:r.street_name,event:r.event,eta_min:0,device:DEVICE,lat:r.lat,lng:r.lng}}); },
      vote:function(id,v){ return api('votes',{method:'POST',body:{report_id:id,device:DEVICE,vote:v}}); },
      cancel:function(id){ return api('rpc/cancel_report',{method:'POST',body:{p_id:id,p_device:DEVICE}}); }
    };
  }else{
    var local=function(){ try{ return JSON.parse(lsGet('hueco-demo')||'[]'); }catch(e){ return []; } };
    var save=function(a){ lsSet('hueco-demo',JSON.stringify(a.slice(-100))); };
    backend={
      list:function(){ return Promise.resolve(local().filter(function(r){ return !r.cancelled; })); },
      add:function(r){ var a=local(); a.push({id:r.id,street:r.street,street_name:r.street_name,event:r.event,lat:r.lat,lng:r.lng,created_at:new Date().toISOString(),confirms:0,denies:0}); save(a); return Promise.resolve(); },
      vote:function(id,v){ var a=local(); a.forEach(function(r){ if(r.id===id){ if(v>0) r.confirms++; else r.denies++; } }); save(a); return Promise.resolve(); },
      cancel:function(id){ var a=local(); a.forEach(function(r){ if(r.id===id) r.cancelled=true; }); save(a); return Promise.resolve(); }
    };
  }
  function seedDemo(){
    var a=[]; try{ a=JSON.parse(lsGet('hueco-demo')||'[]'); }catch(e){}
    var c=[(B[0]+B[2])/2,(B[1]+B[3])/2];
    var base=S.pos||c, n=a.filter(function(r){ return r.demo&&Date.now()-Date.parse(r.created_at)<TTL; }).length;
    for(var i=n;i<4;i++){
      a.push({id:uuid(),street:'zona',street_name:'Hueco de prueba',event:'leaving',demo:true,
        lat:base[0]+(Math.random()-.5)*0.004,lng:base[1]+(Math.random()-.5)*0.006,
        created_at:new Date(Date.now()-Math.floor(Math.random()*6)*60000).toISOString(),confirms:Math.floor(Math.random()*3),denies:0});
    }
    lsSet('hueco-demo',JSON.stringify(a.slice(-100)));
  }

  /* ---------- huecos activos ---------- */
  function normReport(r){
    return {id:r.id,event:r.event,name:r.street_name,lat:r.lat,lng:r.lng,t:Date.parse(r.created_at),conf:r.confirms||0,deny:r.denies||0};
  }
  function computeSpots(){
    var now=Date.now(), rs=S.reports.filter(function(r){ return typeof r.lat==='number'&&typeof r.lng==='number'&&now-r.t<=TTL; });
    var parked=rs.filter(function(r){ return r.event==='parked'; });
    S.spots=rs.filter(function(r){
      if(r.event!=='leaving') return false;
      if((1+r.conf-1.5*r.deny)<=0) return false;
      return !parked.some(function(p){ return p.t>r.t && distPt([p.lat,p.lng],[r.lat,r.lng])<=MERGE_M; });
    }).map(function(r){ r.d=S.pos?distPt(S.pos,[r.lat,r.lng]):null; return r; })
      .sort(function(a,b){ return (a.d!==null&&b.d!==null)?a.d-b.d:b.t-a.t; });
  }
  function refresh(){
    return backend.list().then(function(rows){
      S.reports=(rows||[]).map(normReport); S.error='';
      computeSpots(); checkNew();
    }).catch(function(e){ S.error='Sin conexión con el servidor ('+e.message+')'; });
  }
  function checkNew(){
    var fresh=[];
    S.spots.forEach(function(r){
      if(S.seen[r.id]) return; S.seen[r.id]=true;
      if(!S.firstLoad||r.mine) return;
      if(S.pos&&r.d!==null&&r.d<=NEAR_M) fresh.push(r);
    });
    S.firstLoad=true;
    if(fresh.length){
      showToast('¡Hueco libre a '+distLabel(fresh[0].d)+'!',null,6000);
      try{ if(navigator.vibrate) navigator.vibrate([250,120,250]); }catch(e){}
    }
  }

  /* ---------- ubicación ---------- */
  function startGPS(){
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(function(p){
      S.pos=[p.coords.latitude,p.coords.longitude]; S.acc=p.coords.accuracy;
      if(map&&!S.centered){ S.centered=true; map.setView(S.pos,17); }
      computeSpots(); render();
    },function(){ S.gpsDenied=true; render(); },{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
  }
  function needPos(cb){
    if(S.pos) return cb(true);
    navigator.geolocation&&navigator.geolocation.getCurrentPosition(function(p){
      S.pos=[p.coords.latitude,p.coords.longitude]; cb(true);
    },function(){ cb(false); },{enableHighAccuracy:true,timeout:12000});
    if(!navigator.geolocation) cb(false);
  }

  /* ---------- mapa ---------- */
  function initMap(){
    var c=[(B[0]+B[2])/2,(B[1]+B[3])/2];
    map=L.map('map',{zoomControl:false,attributionControl:false}).setView(c,16);
    L.control.attribution({prefix:false,position:'bottomleft'}).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
      maxZoom:19,subdomains:'abcd',attribution:'© OpenStreetMap · © CARTO'}).addTo(map);
    map.on('click',function(){ S.sel=null; render(); });
  }
  function spotIcon(r,sel){
    var m=Math.floor((Date.now()-r.t)/60000), cls=m<4?'f':(m<7?'m':'o');
    return L.divIcon({className:'spotwrap',iconSize:[48,48],iconAnchor:[24,24],
      html:'<div class="spot '+cls+(sel?' sel':'')+'"><b>P</b><i>'+(m<1?'ya':m+"'")+'</i></div>'});
  }
  function renderMap(){
    if(!map) return;
    var ids={};
    S.spots.forEach(function(r){
      ids[r.id]=1; var sel=S.sel===r.id, m=Math.floor((Date.now()-r.t)/60000), sig=m+'|'+sel;
      if(!markers[r.id]){
        markers[r.id]=L.marker([r.lat,r.lng],{icon:spotIcon(r,sel),keyboard:false,zIndexOffset:500}).addTo(map);
        (function(id){ markers[id].on('click',function(e){ L.DomEvent.stopPropagation(e); S.sel=id; render(); }); })(r.id);
        markers[r.id]._sig=sig;
      }else if(markers[r.id]._sig!==sig){ markers[r.id].setIcon(spotIcon(r,sel)); markers[r.id]._sig=sig; }
    });
    Object.keys(markers).forEach(function(id){ if(!ids[id]){ map.removeLayer(markers[id]); delete markers[id]; } });
    if(S.pos){
      if(!meMarker) meMarker=L.marker(S.pos,{icon:L.divIcon({className:'spotwrap',html:'<div class="me"></div>',iconSize:[20,20],iconAnchor:[10,10]}),interactive:false,zIndexOffset:1000}).addTo(map);
      else meMarker.setLatLng(S.pos);
    }
  }

  /* ---------- pantalla ---------- */
  function showToast(text,undoId,ms){
    S.notice={text:text,undo:undoId||null};
    clearTimeout(toastTimer); toastTimer=setTimeout(function(){ S.notice=null; render(); },ms||7000);
    render();
  }
  function render(){
    var n=S.spots.length, near=S.spots.filter(function(r){ return r.d!==null&&r.d<=NEAR_M; });
    var badge=$('badge'), bt=$('bt'), bs=$('bs');
    if(S.loadingMsg){ badge.className='badge none'; bt.textContent=S.loadingMsg; bs.textContent=''; }
    else if(n){
      badge.className='badge';
      bt.textContent=n+(n===1?' hueco libre':' huecos libres');
      bs.textContent=near.length&&S.pos?near.length+' a menos de '+NEAR_M+' m de ti':'en toda la zona';
    }else{
      badge.className='badge none'; bt.textContent='Sin huecos avisados'; bs.textContent='Sé el primero en avisar';
    }
    var h=$('hint');
    if(S.gpsDenied&&!S.pos) h.textContent='Activa la ubicación para avisar (Ajustes › Safari › Ubicación)';
    else if(S.error) h.textContent=S.error;
    else if(S.spots.length&&S.spots[0].d!==null) h.textContent='Más cercano: '+distLabel(S.spots[0].d)+' · '+agoText(S.spots[0].t);
    else if(S.spots.length) h.textContent='Toca un punto verde para ver el hueco';
    else h.textContent='Cuando alguien se vaya, verás aquí su hueco';

    var t='';
    if(S.notice) t='<div class="tbox"><span>'+esc(S.notice.text)+'</span>'+(S.notice.undo?'<button type="button" data-a="undo" data-id="'+S.notice.undo+'">Deshacer</button>':'')+'</div>';
    if($('toast')._h!==t){ $('toast').innerHTML=t; $('toast')._h=t; }

    var c='', sp=null;
    S.spots.forEach(function(r){ if(r.id===S.sel) sp=r; });
    if(sp){
      var voted=S.voted[sp.id];
      c='<div class="card"><button type="button" class="x" data-a="close" aria-label="Cerrar">×</button>'+
        '<h2>Hueco libre'+(sp.mine?' (tuyo)':'')+'</h2>'+
        '<div class="sub">'+(sp.name&&sp.name!=='Zona'?esc(sp.name)+' · ':'')+(sp.d!==null?distLabel(sp.d)+' · ':'')+agoText(sp.t)+(sp.conf?' · '+sp.conf+' confirmaciones':'')+'</div>'+
        '<div class="acts"><a class="ir" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+sp.lat+','+sp.lng+'">Ir</a>'+
        (sp.mine?'':'<button type="button" data-a="vote" data-id="'+sp.id+'" data-v="1"'+(voted?' disabled':'')+'>'+(voted?'Gracias':'Sigue libre')+'</button>'+
        (voted?'':'<button type="button" data-a="vote" data-id="'+sp.id+'" data-v="-1">Ya no está</button>'))+'</div></div>';
    }
    if($('card')._h!==c){ $('card').innerHTML=c; $('card')._h=c; }
    renderMap();
  }

  /* ---------- acciones ---------- */
  function send(kind0){
    var see=(kind0==='see'), kind=see?'leaving':kind0;
    var now=Date.now();
    if(now-S.lastSend<COOLDOWN){ showToast('Espera un momento antes de volver a avisar.',null,3500); return; }
    needPos(function(ok){
      if(!ok){ S.gpsDenied=true; showToast('No veo tu ubicación. Actívala en Ajustes › Safari › Ubicación.',null,6000); return; }
      var p=[round4(S.pos[0]),round4(S.pos[1])];
      if(see){
        // Si ya hay un hueco avisado a menos de 15 m, no se duplica: se confirma.
        var dup=null;
        S.spots.forEach(function(s){ if(!dup&&!s.mine&&distPt(S.pos,[s.lat,s.lng])<=15) dup=s; });
        if(dup){
          if(!S.voted[dup.id]){ S.voted[dup.id]=true; dup.conf++; backend.vote(dup.id,1).then(refresh).then(render); }
          S.sel=dup.id; showToast('Ese hueco ya estaba avisado. Lo he confirmado, ¡gracias!',null,5000); return;
        }
      }
      var nm=streetNameAt(S.pos);
      var r={id:uuid(),street:nm?norm(nm).slice(0,80):'zona',street_name:(nm||'Zona').slice(0,80),event:kind,lat:p[0],lng:p[1]};
      S.lastSend=now;
      backend.add(r).then(function(){
        S.reports.push({id:r.id,event:kind,name:r.street_name,lat:p[0],lng:p[1],t:Date.now(),conf:0,deny:0,mine:true});
        S.seen[r.id]=true; computeSpots();
        S.spots.forEach(function(s){ if(s.id===r.id) s.mine=true; });
        if(see){ showToast('Hueco avisado. ¡Gracias, vecino!',r.id,9000); if(map) map.setView(p,Math.max(map.getZoom(),17)); }
        else if(kind==='leaving'){ showToast('Aviso enviado. ¡Gracias!',r.id,9000); if(map) map.setView(p,Math.max(map.getZoom(),17)); }
        else showToast('Anotado. Si había un hueco aquí, ya no sale.',null,5000);
        render(); refresh().then(function(){ S.spots.forEach(function(s){ if(s.id===r.id) s.mine=true; }); render(); });
      }).catch(function(e){ S.lastSend=0; showToast('No se pudo enviar ('+e.message+').',null,6000); });
    });
  }
  document.addEventListener('click',function(ev){
    var b=ev.target.closest?ev.target.closest('button,[data-a]'):null; if(!b) return;
    var id=b.id, a=b.getAttribute('data-a');
    if(id==='bgo') send('leaving');
    else if(id==='bpark') send('parked');
    else if(id==='bsee') send('see');
    else if(id==='loc'){ needPos(function(ok){ if(ok&&map) map.setView(S.pos,17); else showToast('No veo tu ubicación.',null,4000); }); }
    else if(a==='close'){ S.sel=null; render(); }
    else if(a==='undo'){
      var uid=b.getAttribute('data-id'); S.notice=null; S.lastSend=0;
      S.reports=S.reports.filter(function(r){ return r.id!==uid; }); computeSpots(); render();
      backend.cancel(uid).then(refresh).then(render);
    }
    else if(a==='vote'){
      var vid=b.getAttribute('data-id'), v=Number(b.getAttribute('data-v'));
      S.voted[vid]=true;
      S.reports.forEach(function(r){ if(r.id===vid){ if(v>0) r.conf++; else r.deny++; } });
      computeSpots(); if(v<0) S.sel=null; render();
      backend.vote(vid,v).then(refresh).then(render);
    }
  });

  /* ---------- arranque ---------- */
  function start(){
    S.loadingMsg='Cargando…'; render();
    initMap(); startGPS();
    if(!REMOTE) seedDemo();
    refresh().then(function(){ S.loadingMsg=''; render(); });
    setInterval(function(){ if(!REMOTE) seedDemo(); refresh().then(render); },POLL);
    setInterval(function(){ computeSpots(); render(); },10000);
    // Nombres de calle: se cargan en segundo plano; si fallan, la app funciona igual.
    loadStreets().then(function(d){ S.streets=d; }).catch(function(){});
  }
  if('serviceWorker' in navigator){ window.addEventListener('load',function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); }); }
  start();
})();
