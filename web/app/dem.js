// Carga de modelos de elevación: Copernicus GLO-30 (vía intermediario) o un GeoTIFF del usuario.
// Devuelve una grilla { w, h, z: Float32Array (NaN = sin dato), georef, dx, dy, fuente }.
// georef = { crs: "EPSG:xxxx", x0, y0 (esquina superior izquierda), rx, ry (> 0) }.

/* global GeoTIFF, proj4 */

const MAX_CELDAS = 4_000_000;
// cabecera de sesión (la define app.js al iniciar sesión)
export const auth = () => window.__gotyxAuth || {};
const R_TIERRA = 111_320; // m por grado (aprox.)

// ---------- sistemas de referencia ----------
const DEF_CRS = {
  "EPSG:31978": "+proj=utm +zone=18 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  "EPSG:31979": "+proj=utm +zone=19 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
};

export async function asegurarCrs(codigo) {
  const crs = `EPSG:${codigo}`;
  if (codigo === 4326 || proj4.defs(crs)) return crs;
  if (codigo >= 32601 && codigo <= 32660) { proj4.defs(crs, `+proj=utm +zone=${codigo - 32600} +datum=WGS84 +units=m +no_defs`); return crs; }
  if (codigo >= 32701 && codigo <= 32760) { proj4.defs(crs, `+proj=utm +zone=${codigo - 32700} +south +datum=WGS84 +units=m +no_defs`); return crs; }
  if (DEF_CRS[crs]) { proj4.defs(crs, DEF_CRS[crs]); return crs; }
  // otros códigos (SIRGAS-Chile, PSAD56…): definición desde epsg.io
  const r = await fetch(`https://epsg.io/${codigo}.proj4`);
  const txt = r.ok ? (await r.text()).trim() : "";
  if (!txt.startsWith("+proj")) throw new Error(`No reconozco el sistema de coordenadas EPSG:${codigo}. Reproyecta el DEM a UTM (WGS84 o SIRGAS) e inténtalo de nuevo.`);
  proj4.defs(crs, txt);
  return crs;
}

export const aLngLat = (crs, p) => (crs === "EPSG:4326" ? p : proj4(crs, "EPSG:4326", p));
export const desdeLngLat = (crs, p) => (crs === "EPSG:4326" ? p : proj4("EPSG:4326", crs, p));

// Esquinas de la grilla en lon/lat (orden de MapLibre: sup-izq, sup-der, inf-der, inf-izq)
export function esquinas(g) {
  const { crs, x0, y0, rx, ry } = g.georef;
  const x1 = x0 + g.w * rx, y1 = y0 - g.h * ry;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => aLngLat(crs, p));
}

// Transformación afín píxel (col, fila; continuo) → lon/lat, a partir de tres esquinas.
// Exacta en grillas geográficas; en UTM el error es despreciable para predios.
export function afin(g) {
  const [tl, tr, , bl] = esquinas(g);
  const ax = (tr[0] - tl[0]) / g.w, ay = (tr[1] - tl[1]) / g.w;
  const bx = (bl[0] - tl[0]) / g.h, by = (bl[1] - tl[1]) / g.h;
  return (c, r) => [tl[0] + ax * c + bx * r, tl[1] + ay * c + by * r];
}

// Máscara del polígono (relleno por líneas de barrido) en la grilla
export function mascara(g, anillo) {
  const m = new Uint8Array(g.w * g.h);
  const { crs, x0, y0, rx, ry } = g.georef;
  if (!anillo) {
    for (let i = 0; i < m.length; i++) m[i] = Number.isNaN(g.z[i]) ? 0 : 1;
    return m;
  }
  const px = anillo.map((p) => {
    const [X, Y] = desdeLngLat(crs, p);
    return [(X - x0) / rx, (y0 - Y) / ry];
  });
  const cruces = [];
  for (let r = 0; r < g.h; r++) {
    const yc = r + 0.5;
    cruces.length = 0;
    for (let k = 0; k < px.length - 1; k++) {
      const [ax, ay] = px[k], [bx, by] = px[k + 1];
      if ((ay <= yc) !== (by <= yc)) cruces.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    cruces.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cruces.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(cruces[k] - 0.5));
      const c1 = Math.min(g.w - 1, Math.floor(cruces[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) {
        const i = r * g.w + c;
        if (!Number.isNaN(g.z[i])) m[i] = 1;
      }
    }
  }
  return m;
}

function tamanoCelda(g) {
  const { crs, y0, ry, rx } = g.georef;
  if (crs === "EPSG:4326") {
    const latc = y0 - (g.h * ry) / 2;
    return [rx * R_TIERRA * Math.cos((latc * Math.PI) / 180), ry * R_TIERRA];
  }
  return [rx, ry];
}

function cajaAnillo(anillo) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of anillo) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}

// Área geodésica aproximada (m²) de un anillo lon/lat
export function areaAnillo(anillo) {
  const [, b, , d] = cajaAnillo(anillo);
  const k = Math.cos((((b + d) / 2) * Math.PI) / 180);
  let s = 0;
  for (let i = 0; i < anillo.length - 1; i++) {
    const [x1, y1] = anillo[i], [x2, y2] = anillo[i + 1];
    s += x1 * k * R_TIERRA * y2 * R_TIERRA - x2 * k * R_TIERRA * y1 * R_TIERRA;
  }
  return Math.abs(s) / 2;
}

// ---------- Copernicus GLO-30 ----------
const nombreTesela = (lat, lon) =>
  `Copernicus_DSM_COG_10_${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
  `${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_00_DEM`;

export async function cargarCopernicus(api, anillo, avisar = () => {}) {
  const [minLon0, minLat0, maxLon0, maxLat0] = cajaAnillo(anillo);
  const latc = (minLat0 + maxLat0) / 2;
  const kx = R_TIERRA * Math.cos((latc * Math.PI) / 180);
  const tam = Math.max((maxLon0 - minLon0) * kx, (maxLat0 - minLat0) * R_TIERRA);
  // margen alrededor del polígono para incluir el agua que llega desde fuera
  const margen = Math.min(1500, Math.max(300, tam * 0.15));
  const minLon = minLon0 - margen / kx, maxLon = maxLon0 + margen / kx;
  const minLat = minLat0 - margen / R_TIERRA, maxLat = maxLat0 + margen / R_TIERRA;

  const absLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const ry = 1 / 3600;
  const rx = (absLat < 50 ? 1 : absLat < 60 ? 1.5 : 2) / 3600;
  const x0 = Math.floor(minLon / rx) * rx;
  const y0 = Math.ceil(maxLat / ry) * ry;
  const w = Math.ceil((maxLon - x0) / rx);
  const h = Math.ceil((y0 - minLat) / ry);
  if (w * h > MAX_CELDAS) throw new Error("El área es demasiado grande para analizarla de una vez (máx. ~3.000 km² con Copernicus). Dibuja un polígono más chico.");

  const z = new Float32Array(w * h).fill(NaN);
  const teselas = [];
  for (let la = Math.floor(minLat); la <= Math.floor(maxLat); la++)
    for (let lo = Math.floor(minLon); lo <= Math.floor(maxLon); lo++) teselas.push([la, lo]);

  let conDatos = 0;
  for (let t = 0; t < teselas.length; t++) {
    const [la, lo] = teselas[t];
    const nombre = nombreTesela(la, lo);
    avisar(`Descargando Copernicus ${t + 1}/${teselas.length}…`);
    const url = `${api}/cop/${nombre}`;
    const prueba = await fetch(url, { headers: { Range: "bytes=0-0", ...auth() } });
    if (prueba.status === 404) continue; // mar abierto
    if (prueba.status === 401) throw new Error("Para analizar este lugar necesitas una cuenta. Ingresa o agenda una demo.");
    if (!prueba.ok) throw new Error(`El servidor de elevación respondió ${prueba.status}.`);

    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false, maxRanges: 0, headers: auth() });
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [trx, try_] = img.getResolution();
    const tw = img.getWidth(), th = img.getHeight();
    const tcol = (c) => Math.floor((x0 + (c + 0.5) * rx - ox) / trx);
    const tfil = (r) => Math.floor((y0 - (r + 0.5) * ry - oy) / try_);

    // rango de la grilla destino que cae en esta tesela
    let c0 = w, c1 = -1, r0 = h, r1 = -1;
    for (let c = 0; c < w; c++) { const v = tcol(c); if (v >= 0 && v < tw) { c0 = Math.min(c0, c); c1 = Math.max(c1, c); } }
    for (let r = 0; r < h; r++) { const v = tfil(r); if (v >= 0 && v < th) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); } }
    if (c1 < c0 || r1 < r0) continue;

    const win = [tcol(c0), tfil(r0), tcol(c1) + 1, tfil(r1) + 1];
    const ww = win[2] - win[0];
    const [banda] = await img.readRasters({ window: win, samples: [0] });
    for (let r = r0; r <= r1; r++) {
      const fr = tfil(r) - win[1];
      for (let c = c0; c <= c1; c++) {
        const v = banda[fr * ww + (tcol(c) - win[0])];
        if (v > -1000 && v < 9000) { z[r * w + c] = v; conDatos++; }
      }
    }
  }
  if (!conDatos) throw new Error("Copernicus no tiene datos para esta zona (¿mar abierto?).");

  const g = { w, h, z, georef: { crs: "EPSG:4326", x0, y0, rx, ry }, fuente: "Copernicus GLO-30 (DSM, ~30 m)", esDSM: true };
  [g.dx, g.dy] = tamanoCelda(g);
  return g;
}

// ---------- GeoTIFF del usuario (dron, LiDAR, levantamiento) ----------
export async function cargarArchivo(archivo, anillo, avisar = () => {}) {
  avisar("Leyendo GeoTIFF…");
  const tiff = await GeoTIFF.fromBlob(archivo);
  const img = await tiff.getImage();
  const claves = img.getGeoKeys() || {};
  const codigo = claves.ProjectedCSTypeGeoKey || claves.GeographicTypeGeoKey;
  if (!codigo || codigo === 32767) throw new Error("El GeoTIFF no indica su sistema de coordenadas (código EPSG). Expórtalo con EPSG, por ejemplo UTM 19S (32719).");
  const crs = await asegurarCrs(codigo);

  const [ox, oy] = img.getOrigin();
  const [rx0, ry0] = img.getResolution();
  const W = img.getWidth(), H = img.getHeight();

  let win = [0, 0, W, H];
  if (anillo) {
    const pts = anillo.map((p) => desdeLngLat(crs, p));
    const [a, b, c, d] = cajaAnillo(pts);
    const lado = Math.max(c - a, d - b);
    const m = Math.min(300, Math.max(30, lado * 0.15)) / (crs === "EPSG:4326" ? R_TIERRA : 1);
    win = [
      Math.max(0, Math.floor((a - m - ox) / rx0)),
      Math.max(0, Math.floor((oy - (d + m)) / -ry0)),
      Math.min(W, Math.ceil((c + m - ox) / rx0)),
      Math.min(H, Math.ceil((oy - (b - m)) / -ry0)),
    ];
    if (win[2] <= win[0] || win[3] <= win[1]) throw new Error("El polígono dibujado no se cruza con el GeoTIFF.");
  }
  const ww = win[2] - win[0], wh = win[3] - win[1];
  const f = Math.max(1, Math.sqrt((ww * wh) / MAX_CELDAS));
  const ow = Math.max(2, Math.round(ww / f)), oh = Math.max(2, Math.round(wh / f));
  avisar(f > 1 ? `Remuestreando a ${ow}×${oh} celdas…` : "Leyendo elevaciones…");

  const [banda] = await img.readRasters({ window: win, samples: [0], width: ow, height: oh });
  const nd = img.getGDALNoData();
  const z = new Float32Array(ow * oh);
  for (let i = 0; i < z.length; i++) {
    const v = banda[i];
    z[i] = (nd !== null && v === nd) || !(v > -500 && v < 9000) ? NaN : v;
  }
  const g = {
    w: ow, h: oh, z,
    georef: { crs, x0: ox + win[0] * rx0, y0: oy + win[1] * ry0, rx: (rx0 * ww) / ow, ry: (-ry0 * wh) / oh },
    fuente: `${archivo.name} (${crs})`, esDSM: false,
  };
  [g.dx, g.dy] = tamanoCelda(g);
  return g;
}
