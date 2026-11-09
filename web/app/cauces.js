// Red de cauces vectorial: une las celdas con área aportante sobre el umbral siguiendo el flujo D8,
// arma tramos entre confluencias, los suaviza (Chaikin) y les asigna su caudal o área aportante.
// Se dibuja como líneas nítidas a cualquier zoom (también sobre el relieve 3D), en vez de píxeles.
import { afin } from "./dem.js";

const VX = [1, 1, 0, -1, -1, -1, 0, 1], VY = [0, 1, 1, 1, 0, -1, -1, -1];

function chaikin(p, vueltas = 2) {
  for (let v = 0; v < vueltas; v++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

// valor: Float32Array con el valor a mostrar por celda (área aportante en m² o caudal en m³/s)
export function redCauces(g, an, umbral, valor) {
  const { w, h } = g, { acc, dir, mask } = an;
  const n = w * h;
  const enRed = new Uint8Array(n), entradas = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (acc[i] >= umbral && dir[i] >= 0) enRed[i] = 1;
  const abajo = (i) => { const k = dir[i]; if (k < 0) return -1; const r = (i / w) | 0, c = i - r * w, rr = r + VY[k], cc = c + VX[k]; return rr < 0 || cc < 0 || rr >= h || cc >= w ? -1 : rr * w + cc; };
  for (let i = 0; i < n; i++) if (enRed[i]) { const j = abajo(i); if (j >= 0 && enRed[j]) entradas[j]++; }

  const aLL = afin(g);
  const pto = (i) => { const r = (i / w) | 0, c = i - r * w; return aLL(c + 0.5, r + 0.5); };
  const visto = new Uint8Array(n);
  const feats = [];
  // un tramo parte en una naciente (sin entradas) o justo aguas abajo de una confluencia
  const inicios = [];
  for (let i = 0; i < n; i++) if (enRed[i] && entradas[i] !== 1) inicios.push(i);
  for (const ini of inicios) {
    if (visto[ini] && entradas[ini] === 0) continue;
    let i = ini;
    const pts = [pto(i)];
    let vmax = valor[i], dentro = mask[i] ? 1 : 0, largo = 0;
    visto[i] = 1;
    for (;;) {
      const j = abajo(i);
      if (j < 0 || !enRed[j]) { if (j >= 0) pts.push(pto(j)); break; }
      pts.push(pto(j));
      largo++;
      vmax = Math.max(vmax, valor[j]);
      if (mask[j]) dentro = 1;
      if (entradas[j] !== 1 || visto[j]) break; // confluencia o tramo ya recorrido
      visto[j] = 1;
      i = j;
    }
    if (pts.length < 2) continue;
    feats.push({ type: "Feature", properties: { v: vmax, dentro }, geometry: { type: "LineString", coordinates: chaikin(pts) } });
  }
  return { type: "FeatureCollection", features: feats };
}
