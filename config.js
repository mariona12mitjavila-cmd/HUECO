// Configuración. Mientras SUPABASE_URL y SUPABASE_ANON_KEY estén vacíos, la app funciona en MODO DEMO
// (avisos de prueba, solo en tu navegador). Con los dos rellenos, los vecinos comparten avisos de verdad.
window.PLAZAS_CONFIG = {
  SUPABASE_URL: 'https://eixohailrprsmylydnvf.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_fzHKAOdPrOrRTkCM9KsxCQ_9oEgRff4',   // clave pública: puede estar en la web
  // Zona a cargar (sur, oeste, norte, este): Vilassar de Mar y alrededores, hasta Cabrera de Mar.
  BBOX: [41.484, 2.358, 41.545, 2.425],
  PLACE_LABEL: 'Vilassar de Mar y alrededores'
};
