# Pueblo Paleta 🏡

Lista de tareas personal de Javi. PWA instalable que funciona **totalmente sin conexión** y se sincroniza con Supabase cuando hay internet.

- Tarjetas con título grande; debajo categoría, prioridad y fecha.
- Subtareas desplegables, cada una con prioridad y fecha.
- Filtros por categoría y opción de ocultar las completadas.

## Cómo funciona

- Todo se guarda primero en el dispositivo (`localStorage`) y se sube a la tabla `public.pp_tasks` del proyecto Supabase de Ciudad Verde (mismo usuario y contraseña).
- Las tareas borradas se marcan con `deleted = true` para que el borrado también se sincronice.
- Si una misma tarea se edita en dos dispositivos sin conexión, gana la edición más reciente.
- `sw.js` cachea la app para abrirla sin conexión. **Sube `VERSION` en `sw.js` cada vez que cambies un archivo.**

## Estructura

```
index.html            # Shell
styles.css
app.js                # UI + auth REST + sincronización
config.js             # URL y anon key de Supabase (públicas; RLS protege los datos)
sw.js                 # Service worker (offline)
manifest.webmanifest
assets/               # Imagen de cabecera e iconos
netlify.toml
```

## Desarrollo local

```
npx serve -l 5174 .
```
