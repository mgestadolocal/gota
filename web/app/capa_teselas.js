// Capa de análisis servida como teselas raster generadas al vuelo (protocolo "gotyx://").
// Una imagen única (ImageSource) se recorta en los bordes de tesela al pegarse sobre el relieve 3D de MapLibre;
// las teselas se drapean correctamente en cualquier ángulo y zoom.
/* global maplibregl */
import { desdeLngLat, esquinas } from "./dem.js";

const T = 256;
let fuente = null; // { px, w, h, georef, caja }
let version = 0;
let vacia = null;

async function teselaVacia() {
  if (!vacia) {
    const c = new OffscreenCanvas(1, 1);
    vacia = await (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
  }
  return vacia.slice(0);
}

async function cargar(params) {
  const m = params.url.match(/^gotyx:\/\/capa\/(\d+)\/(\d+)\/(\d+)/);
  if (!m || !fuente) return { data: await teselaVacia() };
  const z = +m[1], tx = +m[2], ty = +m[3], n = 2 ** z;
  const lonDe = (x) => (x / n) * 360 - 180;
  const latDe = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const [a, b, c, d] = fuente.caja;
  if (lonDe(tx + 1) < a || lonDe(tx) > c || latDe(ty) < b || latDe(ty + 1) > d) return { data: await teselaVacia() };

  const { px, w, h, georef } = fuente;
  const { crs, x0, y0, rx, ry } = georef;
  const geo = crs === "EPSG:4326";
  const out = new ImageData(T, T);
  const o = out.data;
  for (let py = 0; py < T; py++) {
    const lat = latDe(ty + (py + 0.5) / T);
    for (let qx = 0; qx < T; qx++) {
      const lon = lonDe(tx + (qx + 0.5) / T);
      let X = lon, Y = lat;
      if (!geo) [X, Y] = desdeLngLat(crs, [lon, lat]);
      // muestreo bilineal (suave) en la grilla de análisis
      const fx = (X - x0) / rx - 0.5, fy = (y0 - Y) / ry - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < -1 || iy < -1 || ix >= w || iy >= h) continue;
      const tx1 = fx - ix, ty1 = fy - iy;
      let r = 0, g = 0, bb = 0, al = 0;
      for (let k = 0; k < 4; k++) {
        const cx = ix + (k & 1), cy = iy + (k >> 1);
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        const wgt = ((k & 1) ? tx1 : 1 - tx1) * ((k >> 1) ? ty1 : 1 - ty1);
        const p = (cy * w + cx) * 4, aa = px[p + 3] * wgt;
        r += px[p] * aa; g += px[p + 1] * aa; bb += px[p + 2] * aa; al += aa;
      }
      if (al <= 0) continue;
      const q = (py * T + qx) * 4;
      o[q] = r / al; o[q + 1] = g / al; o[q + 2] = bb / al; o[q + 3] = al;
    }
  }
  const cv = new OffscreenCanvas(T, T);
  cv.getContext("2d").putImageData(out, 0, 0);
  return { data: await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer() };
}

export function registrarProtocolo() {
  maplibregl.addProtocol("gotyx", cargar);
}

// Publica un canvas (w×h, una celda = un píxel) como la capa visible
export function publicarCapa(mapa, canvas, g, antes) {
  fuente = { px: canvas.getContext("2d").getImageData(0, 0, g.w, g.h).data, w: g.w, h: g.h, georef: g.georef };
  const cs = esquinas(g);
  const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
  fuente.caja = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  version++;
  const tiles = [`gotyx://capa/{z}/{x}/{y}?v=${version}`];
  const src = mapa.getSource("capa");
  if (src) {
    src.setTiles(tiles);
  } else {
    mapa.addSource("capa", { type: "raster", tiles, tileSize: T, maxzoom: 17, bounds: fuente.caja });
    mapa.addLayer({ id: "capa", type: "raster", source: "capa", paint: { "raster-fade-duration": 0, "raster-resampling": "linear" } }, antes);
  }
}
