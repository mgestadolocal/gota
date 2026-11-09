# Cota — análisis de terreno para Chile

Dibuja un polígono (o sube un DEM de dron/LiDAR) y obtén, en el navegador:

- **Escurrimiento**: por dónde corre el agua (flujo D8 sobre superficie rellenada, área aportante).
- **Encharcamiento**: depresiones sin salida, superficie y volumen que retienen.
- **Pendientes** por clase, **elevación** con sombreado y **curvas de nivel**.
- **Vista 3D** con controles para girar, inclinar, ver desde N/E/S/O, dar la vuelta y exagerar el relieve, y **simulación de lluvia** (partículas que siguen el flujo).
- Exporta informe (PDF vía imprimir), GeoTIFF Float32 de la capa y polígono GeoJSON.

## Datos
- **Copernicus GLO-30** (DSM ~30 m, todo Chile) desde el bucket abierto de AWS. El bucket no envía CORS,
  así que pasa por un Cloudflare Worker (`worker/`) que solo reenvía lecturas por rango.
- **GeoTIFF del usuario**: cualquier EPSG (UTM WGS84/SIRGAS conocidos; otros vía epsg.io). Se procesa localmente,
  no se sube a ningún servidor. Se remuestrea a ≤ 4 M celdas.
- Relieve 3D: Terrain Tiles (AWS, terrarium). Imagen: Esri World Imagery.

## Estructura
- `web/` — sitio estático (MapLibre, geotiff.js, proj4). `analisis.js` corre en un Web Worker.
- `worker/` — intermediario Copernicus (`/cop/{tesela}`).
- `tools/servidor_local.py` — prueba local: `python tools/servidor_local.py` → http://localhost:8790/

## Despliegue
GitHub Pages (`pages.yml`, escribe `web/config.js` con la variable `COTA_API`) y Cloudflare Worker (`worker.yml`,
secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`, variable `ALLOWED_ORIGINS`).

## Límites
Copernicus es un modelo de superficie (incluye árboles y edificios) de ~30 m: sirve para prediagnóstico,
no para nivelar potreros. No reemplaza topografía ni estudio hidrológico.
