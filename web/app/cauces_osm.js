// Cauces conocidos (ríos y esteros de OpenStreetMap) "grabados" en el DEM para guiar el escurrimiento.
// Solo se usan para calcular hacia dónde corre el agua: pendientes, alturas y curvas siguen con el DEM original.
// Datos © OpenStreetMap contributors (ODbL).
import { desdeLngLat, esquinas } from "./dem.js";

const PASO = 0.2; // teselas de 0,2° generadas con tools/cauces_osm.py (ríos y esteros naturales; sin canales de riego)
const PROFUNDIDAD = 5; // m que se baja el eje del cauce (solo para dirigir el flujo; no es la profundidad real)
const ANCHO = 2; // celdas a cada lado en que la bajada se atenúa hasta 0 (atrapa valles del DEM corridos unos metros)
const cache = new Map();

// Solo tiene sentido en DEM gruesos: en un DEM de dron o LiDAR el relieve es más exacto que el trazado de OSM.
export const convieneQuemar = (g) => Math.min(g.dx, g.dy) >= 10;

async function tesela(i, j) {
  const k = `${i}_${j}`;
  if (!cache.has(k)) {
    cache.set(k, fetch(new URL(`data/cauces/${k}.json`, import.meta.url)).then((r) => {
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`cauces ${k}: ${r.status}`);
      return r.json();
    }).catch((e) => { cache.delete(k); throw e; }));
  }
  return cache.get(k);
}

// Líneas { tipo, nombre, puntos: [[lon, lat], …] } que tocan la grilla; null si no se pudieron leer.
export async function cargarCaucesOSM(g) {
  const c = esquinas(g);
  const lons = c.map((p) => p[0]), lats = c.map((p) => p[1]);
  const [o, s_, e, n] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const pedidos = [];
  for (let i = Math.floor(o / PASO); i <= Math.floor(e / PASO); i++)
    for (let j = Math.floor(s_ / PASO); j <= Math.floor(n / PASO); j++) pedidos.push(tesela(i, j));
  let grupos;
  try { grupos = await Promise.all(pedidos); } catch { return null; }
  const vistos = new Set(), lineas = [];
  for (const regs of grupos) for (const r of regs) {
    if (vistos.has(r.id)) continue;
    vistos.add(r.id);
    if (!r.c.some(([x, y]) => x >= o && x <= e && y >= s_ && y <= n)) {
      // puede cruzar la grilla sin tener vértices dentro: se mira su caja
      const xs = r.c.map((p) => p[0]), ys = r.c.map((p) => p[1]);
      if (Math.max(...xs) < o || Math.min(...xs) > e || Math.max(...ys) < s_ || Math.min(...ys) > n) continue;
    }
    lineas.push({ tipo: r.t === "r" ? "river" : "stream", nombre: r.n, puntos: r.c });
  }
  return lineas;
}

// Devuelve { quema: Float32Array (m a restar por celda), km: largo de cauces dentro de la grilla,
//   rioExterno: Uint8Array (franja de ríos que entran o salen de la grilla: su caudal real depende de una cuenca
//   mayor que el área analizada), riosExternos: nombres de esos ríos }.
export function rasterizarCauces(g, lineas) {
  const { w, h } = g;
  const { crs, x0, y0, rx, ry } = g.georef;
  const eje = new Uint8Array(w * h);
  const ejeRio = new Uint8Array(w * h);
  const riosExternos = new Set();
  let largo = 0;
  for (const l of lineas) {
    const px = l.puntos.map((p) => { const [X, Y] = desdeLngLat(crs, p); return [(X - x0) / rx, (y0 - Y) / ry]; });
    for (let k = 1; k < px.length; k++) {
      const [ax, ay] = px[k - 1], [bx, by] = px[k];
      const pasos = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      let dentro = false;
      for (let s = 0; s <= pasos; s++) {
        const c = Math.floor(ax + ((bx - ax) * s) / pasos), r = Math.floor(ay + ((by - ay) * s) / pasos);
        if (c >= 0 && r >= 0 && c < w && r < h) { eje[r * w + c] = 1; dentro = true; }
      }
      if (dentro) largo += Math.hypot((bx - ax) * g.dx, (by - ay) * g.dy);
    }
    // río (no estero) que cruza el borde de la grilla: se marca su franja
    const fuera = px.some(([x, y]) => x < 0 || y < 0 || x >= w || y >= h);
    const adentro = px.some(([x, y]) => x >= 0 && y >= 0 && x < w && y < h);
    if (l.tipo === "river" && fuera && (adentro || largo > 0)) {
      let toca = false;
      for (let k = 1; k < px.length; k++) {
        const [ax, ay] = px[k - 1], [bx, by] = px[k];
        const pasos = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
        for (let s = 0; s <= pasos; s++) {
          const c = Math.floor(ax + ((bx - ax) * s) / pasos), r = Math.floor(ay + ((by - ay) * s) / pasos);
          if (c >= 0 && r >= 0 && c < w && r < h) { ejeRio[r * w + c] = 1; toca = true; }
        }
      }
      if (toca) riosExternos.add(l.nombre || "un río");
    }
  }
  // distancia al eje (chamfer 3-4, en celdas) y bajada atenuada
  const INF = 1e9, d = new Float32Array(w * h).fill(INF);
  for (let i = 0; i < d.length; i++) if (eje[i]) d[i] = 0;
  const pasar = (orden) => {
    for (let t = 0; t < w * h; t++) {
      const i = orden ? t : w * h - 1 - t;
      const r = (i / w) | 0, c = i - r * w;
      const vec = orden ? [[-1, 0, 3], [0, -1, 3], [-1, -1, 4], [1, -1, 4]] : [[1, 0, 3], [0, 1, 3], [1, 1, 4], [-1, 1, 4]];
      for (const [dc, dr, cost] of vec) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
        const v = d[rr * w + cc] + cost;
        if (v < d[i]) d[i] = v;
      }
    }
  };
  pasar(true); pasar(false);
  const quema = new Float32Array(w * h);
  for (let i = 0; i < quema.length; i++) {
    const dist = d[i] / 3;
    if (dist <= ANCHO) quema[i] = PROFUNDIDAD * (1 - dist / (ANCHO + 1));
  }
  // franja de los ríos externos (mismo ancho que la bajada + 1 celda)
  const rioExterno = new Uint8Array(w * h);
  if (riosExternos.size) {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (!ejeRio[r * w + c]) continue;
      for (let dr = -ANCHO - 1; dr <= ANCHO + 1; dr++) for (let dc = -ANCHO - 1; dc <= ANCHO + 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < h && cc < w) rioExterno[rr * w + cc] = 1;
      }
    }
  }
  return { quema, km: largo / 1000, n: lineas.length, rioExterno, riosExternos: [...riosExternos] };
}
