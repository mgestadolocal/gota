// Cobertura de suelo ESA WorldCover 2021 (10 m, CC BY 4.0) muestreada en el centro de cada celda de la grilla.
/* global GeoTIFF */
import { afin, auth } from "./dem.js";

export const CLASES_WC = {
  10: { nombre: "Árboles", color: "#006400" },
  20: { nombre: "Matorral", color: "#ffbb22" },
  30: { nombre: "Pradera", color: "#ffff4c" },
  40: { nombre: "Cultivos", color: "#f096ff" },
  50: { nombre: "Construido", color: "#fa0000" },
  60: { nombre: "Suelo desnudo", color: "#b4b4b4" },
  70: { nombre: "Nieve o hielo", color: "#f0f0f0" },
  80: { nombre: "Agua", color: "#0064c8" },
  90: { nombre: "Humedal", color: "#0096a0" },
  95: { nombre: "Manglar", color: "#00cf75" },
  100: { nombre: "Musgo y liquen", color: "#fae6a0" },
};

const nombreTesela = (la, lo) =>
  `ESA_WorldCover_10m_2021_v200_${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}` +
  `${lo < 0 ? "W" : "E"}${String(Math.abs(lo)).padStart(3, "0")}_Map`;

// Devuelve Uint8Array (w*h) con la clase WorldCover de cada celda (0 = sin dato)
export async function cargarCobertura(api, g, avisar = () => {}) {
  const { w, h } = g;
  const aLL = afin(g);
  const lon = new Float64Array(w * h), lat = new Float64Array(w * h);
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let r = 0; r < h; r++) for (let k = 0; k < w; k++) {
    const [x, y] = aLL(k + 0.5, r + 0.5);
    const i = r * w + k; lon[i] = x; lat[i] = y;
    a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
  }
  // resolución de lectura ~ la mitad de la celda (sin bajar de los 10 m nativos)
  const celdaGr = Math.min(g.dx, g.dy) / 111320;
  const res = Math.max(1 / 12000, celdaGr / 2);

  const clase = new Uint8Array(w * h);
  const teselas = [];
  for (let la = Math.floor(b / 3) * 3; la <= d; la += 3)
    for (let lo = Math.floor(a / 3) * 3; lo <= c; lo += 3) teselas.push([la, lo]);

  for (let t = 0; t < teselas.length; t++) {
    const [la, lo] = teselas[t];
    avisar(`Leyendo cobertura de suelo ${t + 1}/${teselas.length}…`);
    const url = `${api}/wc/${nombreTesela(la, lo)}`;
    const prueba = await fetch(url, { headers: { Range: "bytes=0-0", ...auth() } });
    if (!prueba.ok) continue; // tesela inexistente (mar)
    const caja = [Math.max(a, lo), Math.max(b, la), Math.min(c, lo + 3), Math.min(d, la + 3)];
    if (caja[2] <= caja[0] || caja[3] <= caja[1]) continue;
    const ancho = Math.max(1, Math.ceil((caja[2] - caja[0]) / res));
    const alto = Math.max(1, Math.ceil((caja[3] - caja[1]) / res));
    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false, maxRanges: 0, headers: auth() });
    const [banda] = await tiff.readRasters({ bbox: caja, width: ancho, height: alto, resampleMethod: "nearest" });
    const rx = (caja[2] - caja[0]) / ancho, ry = (caja[3] - caja[1]) / alto;
    for (let i = 0; i < w * h; i++) {
      if (lon[i] < caja[0] || lon[i] >= caja[2] || lat[i] <= caja[1] || lat[i] > caja[3]) continue;
      const cx = Math.min(ancho - 1, Math.floor((lon[i] - caja[0]) / rx));
      const cy = Math.min(alto - 1, Math.floor((caja[3] - lat[i]) / ry));
      clase[i] = banda[cy * ancho + cx];
    }
  }
  if (!clase.some((v) => v)) throw new Error("No pude leer la cobertura de suelo (ESA WorldCover).");
  return clase;
}
