# Gotyx.ai — el agua y el terreno de Chile

Dibuja un polígono (o sube un DEM de dron/LiDAR) y obtén, en el navegador:

- **Escurrimiento**: por dónde corre el agua (flujo D8 sobre superficie rellenada, área aportante).
- **Encharcamiento**: depresiones sin salida, superficie y volumen que retienen.
- **Pendientes** por clase, **elevación** con sombreado y **curvas de nivel**.
- **Vista 3D** con controles para girar, inclinar, ver desde N/E/S/O, dar la vuelta y exagerar el relieve, y **simulación de lluvia** (partículas que siguen el flujo).
- **Tormenta de diseño** (2–100 años): lluvia de GPEX en el punto, escorrentía por número de curva SCS con cobertura
  ESA WorldCover y tipo de suelo, llenado y desborde de depresiones según el volumen, caudal punta por cauce (método racional).
- Exporta informe (PDF vía imprimir), GeoTIFF Float32 de la capa y polígono GeoJSON.

## Datos
- **Copernicus GLO-30** (DSM ~30 m, todo Chile) desde el bucket abierto de AWS. El bucket no envía CORS,
  así que pasa por un Cloudflare Worker (`worker/`) que solo reenvía lecturas por rango.
- **GeoTIFF del usuario**: cualquier EPSG (UTM WGS84/SIRGAS conocidos; otros vía epsg.io). Se procesa localmente,
  no se sube a ningún servidor. Se remuestrea a ≤ 4 M celdas.
- **GPEX** (Gründemann et al. 2021, CC BY 4.0, doi:10.4121/12764429.v4): niveles de retorno de lluvia 3 h–72 h,
  0,1°, recortado a Chile en `web/data/gpex/` con `tools/gpex_chile.py` (descarga: `tools/bajar_gpex.py`).
- **ESA WorldCover 2021** (10 m, CC BY 4.0) vía el Worker (`/wc/`).
- Relieve 3D: Terrain Tiles (AWS, terrarium). Imagen: Esri World Imagery.

## Estructura
- `web/` — sitio estático (MapLibre, geotiff.js, proj4). `analisis.js` corre en un Web Worker.
- `worker/` — intermediario Copernicus (`/cop/{tesela}`).
- `tools/servidor_local.py` — prueba local: `python tools/servidor_local.py` → http://localhost:8790/

## Despliegue
GitHub Pages (`pages.yml`, escribe `web/config.js` con la variable `GOTA_API`) y Cloudflare Worker (`worker.yml`,
secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`, variable `ALLOWED_ORIGINS`).

## Límites
Copernicus es un modelo de superficie (incluye árboles y edificios) de ~30 m: sirve para prediagnóstico,
no para nivelar potreros. No reemplaza topografía ni estudio hidrológico.

## Gotyx: sitio, demo y cuentas
- `web/index.html` — landing (assets en `web/assets/`, clips en `web/assets/clips/`).
- `web/app/` — el software. `?demo=macul` o `?demo=aculeo` abre la demo sin cuenta; sin `?demo` exige sesión.
- `web/ingresar.html` — acceso de clientes. `web/admin.html` — panel privado (solicitudes de demo y cuentas).
- Worker (`worker/src/index.js`): `/cop` y `/wc` (sin sesión solo las teselas de la demo), `POST /demo`,
  `/auth/login|logout|yo`, `/admin/*` (cabecera `X-Admin-Key`). Datos en KV `gotyx-datos` (binding `DATOS`, el
  workflow lo crea y lo enlaza). Secretos del repo: `ADMIN_KEY`, y opcionales `RESEND_API_KEY` + `AVISO_CORREO`
  para recibir un correo por cada solicitud. Las claves de clientes se guardan con PBKDF2-SHA256 y sal.
- Nota: KV es eventualmente consistente (≈60 s): un cierre de sesión, una clave nueva o un borrado pueden tardar
  hasta un minuto en verse en todas partes.
