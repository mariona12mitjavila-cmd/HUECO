# Hueco (versión web) · guía paso a paso desde iPad

Funciona en iPhone y Android desde el navegador, sin tiendas de apps.
Se instala en la pantalla de inicio como una app.

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `index.html`, `app.js` | La app |
| `config.js` | Aquí pegas los datos de tu servidor (paso 2) |
| `schema.sql` | Crea la base de datos de avisos (paso 1) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Para instalarla como app |

## Antes de nada: pruébala en modo demo

Sin hacer nada más, la app ya funciona en **modo demo** (avisos de prueba que solo ves tú).
Sirve para enseñarla, pero los vecinos no se ven entre ellos hasta que hagas los pasos 1 a 3.

## Paso 1 · Crear el servidor gratis (Supabase)

1. Entra en **supabase.com** desde Safari y crea una cuenta gratuita.
2. Pulsa **New project**. Ponle un nombre (por ejemplo `plazas`), una contraseña y elige la región **West EU (Ireland)** o la más cercana.
3. Espera 1 o 2 minutos a que termine de crearse.
4. En el menú de la izquierda entra en **SQL Editor** → **New query**.
5. Abre `schema.sql`, copia todo el texto, pégalo y pulsa **Run**. Debe decir *Success*.

## Paso 2 · Copiar los dos datos del servidor

1. En Supabase entra en **Project Settings** → **API**.
2. Copia **Project URL** (empieza por `https://` y acaba en `.supabase.co`).
3. Copia la clave **anon public**.
4. Abre `config.js` y pégalas entre las comillas de `SUPABASE_URL` y `SUPABASE_ANON_KEY`.

La clave *anon public* está pensada para estar en la web. **No pegues nunca la *service_role*.**

## Paso 3 · Publicar la web (GitHub Pages, gratis)

1. Entra en **github.com** y crea una cuenta.
2. Crea un repositorio nuevo: **New repository** → nombre `hueco` → **Public** → Create.
3. Pulsa **uploading an existing file** y sube **todos** los archivos y las carpetas `icons` y `supabase` (descomprime el zip en la app Archivos antes).
4. Pulsa **Commit changes**.
5. Entra en **Settings** → **Pages** → en *Branch* elige `main` y `/ (root)` → **Save**.
6. A los 1 o 2 minutos te da un enlace tipo `https://tuusuario.github.io/hueco/`. Ese es el enlace que repartes.

## Paso 4 · Instalarla en el móvil

- **iPhone (Safari):** abre el enlace → botón Compartir → **Añadir a pantalla de inicio**.
- **Android (Chrome):** abre el enlace → menú ⋮ → **Instalar aplicación**.

## Cómo se usa

- **Me voy:** cuando vayas a dejar tu plaza, pulsa el botón, confirma la calle (la detecta por tu ubicación) y di cuándo te vas. El aviso caduca 10 minutos después de la hora.
- **He aparcado:** guarda dónde has aparcado.
- **Avísame:** actívalo en una calle o «cerca de mí» y la app te avisa mientras la tengas abierta.
- **Sigue ahí / Ya no está:** confirma o desmiente un aviso. Con más dudas que confirmaciones, el aviso se oculta.

## Qué NO hace todavía

- **No detecta el Bluetooth del coche.** Eso necesita la app nativa (siguiente fase) y en iPhone solo es posible con un atajo.
- **Los avisos solo llegan con la app abierta.** Las notificaciones con la app cerrada vienen después.
- **No sabe cuántas plazas libres hay**, solo las salidas que avisan los vecinos.
- **No evita el abuso:** cualquiera puede mandar avisos falsos. Para una prueba con pocos vecinos vale; para más gente hace falta limitar envíos.

## Privacidad

No hay cuentas. Cada navegador crea un identificador aleatorio que solo usa el servidor para evitar votos repetidos y para que puedas cancelar tu propio aviso. Los demás nunca lo ven. La ubicación solo sirve para sugerir la calle y no se envía. De cada aviso se guardan calle, hora y tiempo estimado.

Los avisos se ocultan a las 12 horas. Para borrarlos del todo, ejecuta de vez en cuando en SQL Editor:
`delete from public.reports where created_at < now() - interval '2 days';`

Antes de abrirla a mucha gente, publica una política de privacidad con estos datos.
