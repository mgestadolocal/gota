// Agua acumulada (pozas, lagunas) como polígonos vectoriales suaves por rango de profundidad.
// Filtra el "ruido" del modelo satelital: depresiones de muy pocas celdas o casi sin profundidad.
/* global d3 */
import { afin } from "./dem.js";

export const NIVELES = [0.05, 0.3, 0.8, 1.5]; // m (sin tormenta: depresiones llenas)
export const COLORES_AGUA = ["#bfeaff", "#7fcfff", "#3aa0f0", "#1765c8", "#0a3a8a"];
// Con tormenta: cortes fijos para el caso, relativos a la profundidad de la tormenta de 100 años (dRef).
// Así una tormenta menor se ve más clara y una mayor, más oscura (los cortes no cambian entre tormentas).
export function nivelesTormenta(dRef) {
  const d = Math.max(0.2, dRef);
  const v = [0.05, 0.2 * d, 0.45 * d, 0.7 * d, 0.95 * d].map((x) => Math.max(0.05, x));
  for (let i = 1; i < v.length; i++) v[i] = Math.max(v[i], v[i - 1] + 0.02);
  return v;
}

function chaikinAnillo(r) {
  if (r.length < 5) return r;
  const q = [];
  for (let i = 0; i < r.length - 1; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[i + 1];
    q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
  }
  q.push(q[0]);
  return q;
}

// prof: Float32Array (m) por celda; mask: solo dentro del polígono
export function laminasDeAgua(g, prof, mask, { minCeldas = 5, minProf = 0.15, niveles = NIVELES } = {}) {
  const { w, h } = g, n = w * h;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) { const d = prof[i]; v[i] = mask[i] && d >= niveles[0] ? d : 0; }

  // componentes conexas: se descartan las muy chicas o muy someras
  const comp = new Int32Array(n).fill(-1), pila = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (v[i] <= 0 || comp[i] >= 0) continue;
    let sp = 0, celdas = [], max = 0;
    pila[sp++] = i; comp[i] = i;
    while (sp) {
      const c = pila[--sp]; celdas.push(c); if (v[c] > max) max = v[c];
      const r = (c / w) | 0, col = c - r * w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const rr = r + dy, cc = col + dx;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc;
        if (v[j] > 0 && comp[j] < 0) { comp[j] = i; pila[sp++] = j; }
      }
    }
    if (celdas.length < minCeldas || max < minProf) for (const c of celdas) v[c] = 0;
  }

  const aLL = afin(g);
  const contornos = d3.contours().size([w, h]).thresholds(niveles).smooth(true)(v);
  const feats = [];
  contornos.forEach((ct, k) => {
    if (!ct.coordinates.length) return;
    const coords = ct.coordinates.map((poli) => poli.map((anillo) => chaikinAnillo(anillo).map(([x, y]) => aLL(x, y))));
    feats.push({ type: "Feature", properties: { nivel: k, prof: niveles[k] }, geometry: { type: "MultiPolygon", coordinates: coords } });
  });
  return { type: "FeatureCollection", features: feats };
}
