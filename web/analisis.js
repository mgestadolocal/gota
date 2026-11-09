// Cálculo hidrológico y de pendientes (Web Worker).
// Grilla: w × h celdas, z Float32 (NaN = sin dato), mask Uint8 (1 = dentro del polígono),
// dx/dy = tamaño de celda en metros. La fila crece hacia el sur.


// Vecinos D8: E, SE, S, SO, O, NO, N, NE
const VX = [1, 1, 0, -1, -1, -1, 0, 1];
const VY = [0, 1, 1, 1, 0, -1, -1, -1];

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.tipo === "analizar") {
      const r = analizar({ w: m.w, h: m.h, z: m.z, mask: m.mask, dx: m.dx, dy: m.dy });
      self.postMessage({ tipo: "analisis", ...r }, [r.pendiente.buffer, r.prof.buffer, r.acc.buffer, r.dir.buffer]);
    }
  } catch (err) {
    self.postMessage({ tipo: "error", mensaje: String((err && err.message) || err) });
  }
};

// ---------- montículo binario (índice, clave) ----------
class Monticulo {
  constructor(n) { this.i = new Int32Array(n); this.k = new Float64Array(n); this.n = 0; }
  push(idx, key) {
    let j = this.n++;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (this.k[p] <= key) break;
      this.i[j] = this.i[p]; this.k[j] = this.k[p]; j = p;
    }
    this.i[j] = idx; this.k[j] = key;
  }
  pop() {
    const top = this.i[0];
    const n = --this.n;
    if (n > 0) {
      const li = this.i[n], lk = this.k[n];
      let j = 0;
      for (;;) {
        let c = 2 * j + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= lk) break;
        this.i[j] = this.i[c]; this.k[j] = this.k[c]; j = c;
      }
      this.i[j] = li; this.k[j] = lk;
    }
    return top;
  }
}

// Priority-Flood + ε (Barnes et al. 2014): rellena depresiones dejando una pendiente mínima
// para que toda celda drene hacia el borde de la grilla o hacia un vacío de datos.
function rellenar(w, h, z) {
  const n = w * h;
  const f = new Float64Array(n);
  const cerrado = new Uint8Array(n);
  const abierto = new Monticulo(n);
  const pozo = new Int32Array(n);
  let ph = 0, pt = 0;
  const EPS = 1e-4;

  for (let i = 0; i < n; i++) {
    f[i] = z[i];
    if (Number.isNaN(z[i])) cerrado[i] = 1;
  }
  // semillas: celdas válidas en el borde o junto a un vacío
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (cerrado[i]) continue;
      let borde = r === 0 || c === 0 || r === h - 1 || c === w - 1;
      if (!borde) {
        for (let k = 0; k < 8; k++) {
          if (Number.isNaN(z[i + VY[k] * w + VX[k]])) { borde = true; break; }
        }
      }
      if (borde) { cerrado[i] = 1; abierto.push(i, f[i]); }
    }
  }
  while (abierto.n > 0 || ph < pt) {
    const c = ph < pt ? pozo[ph++] : abierto.pop();
    const r = (c / w) | 0, col = c - r * w;
    for (let k = 0; k < 8; k++) {
      const rr = r + VY[k], cc = col + VX[k];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const v = rr * w + cc;
      if (cerrado[v]) continue;
      cerrado[v] = 1;
      if (f[v] <= f[c] + EPS) { f[v] = f[c] + EPS; pozo[pt++] = v; }
      else abierto.push(v, f[v]);
    }
  }
  return f;
}

function analizar({ w, h, z, mask, dx, dy }) {
  const n = w * h;
  const A = dx * dy;
  const dd = Math.hypot(dx, dy);
  const dist = [dx, dd, dy, dd, dx, dd, dy, dd];

  // 1) relleno y profundidad de encharcamiento
  const f = rellenar(w, h, z);
  const prof = new Float32Array(n);
  for (let i = 0; i < n; i++) prof[i] = Number.isNaN(z[i]) ? NaN : f[i] - z[i];

  // 2) dirección de flujo D8 sobre la superficie rellenada
  const dir = new Int8Array(n).fill(-1);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (Number.isNaN(z[i])) continue;
      let mejor = -1, mejorS = 0;
      for (let k = 0; k < 8; k++) {
        const rr = r + VY[k], cc = c + VX[k];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const v = rr * w + cc;
        if (Number.isNaN(z[v])) continue;
        const s = (f[i] - f[v]) / dist[k];
        if (s > mejorS) { mejorS = s; mejor = k; }
      }
      dir[i] = mejor;
    }
  }

  // 3) área aportante (m²), orden topológico (Kahn) sin ordenar por cota
  const acc = new Float32Array(n);
  const grado = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(z[i])) { acc[i] = NaN; continue; }
    acc[i] = A;
    const k = dir[i];
    if (k >= 0) grado[i + VY[k] * w + VX[k]]++;
  }
  const cola = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(z[i]) && grado[i] === 0) cola[qt++] = i;
  while (qh < qt) {
    const c = cola[qh++];
    const k = dir[c];
    if (k < 0) continue;
    const rec = c + VY[k] * w + VX[k];
    acc[rec] += acc[c];
    if (--grado[rec] === 0) cola[qt++] = rec;
  }

  // 4) pendiente (Horn), en %
  const pendiente = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const z0 = z[i];
      if (Number.isNaN(z0)) { pendiente[i] = NaN; continue; }
      const g = (rr, cc) => {
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) return z0;
        const v = z[rr * w + cc];
        return Number.isNaN(v) ? z0 : v;
      };
      const a = g(r - 1, c - 1), b = g(r - 1, c), cc_ = g(r - 1, c + 1);
      const d = g(r, c - 1), e = g(r, c + 1);
      const ff = g(r + 1, c - 1), gg = g(r + 1, c), hh = g(r + 1, c + 1);
      const dzdx = (cc_ + 2 * e + hh - (a + 2 * d + ff)) / (8 * dx);
      const dzdy = (ff + 2 * gg + hh - (a + 2 * b + cc_)) / (8 * dy);
      pendiente[i] = 100 * Math.hypot(dzdx, dzdy);
    }
  }

  // 5) estadísticas dentro del polígono
  const CLASES = [2, 5, 10, 15, 30, 45, Infinity];
  const clases = new Array(CLASES.length).fill(0);
  let nc = 0, zmin = Infinity, zmax = -Infinity, zsum = 0, psum = 0;
  let encArea = 0, encVol = 0, encMax = 0, accMax = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || Number.isNaN(z[i])) continue;
    nc++;
    const v = z[i];
    if (v < zmin) zmin = v;
    if (v > zmax) zmax = v;
    zsum += v;
    psum += pendiente[i];
    let k = 0;
    while (pendiente[i] >= CLASES[k]) k++;
    clases[k]++;
    if (prof[i] >= 0.05) { encArea += A; encVol += prof[i] * A; if (prof[i] > encMax) encMax = prof[i]; }
    if (acc[i] > accMax) accMax = acc[i];
  }
  if (nc === 0) throw new Error("El polígono no contiene celdas con datos de elevación.");

  return {
    pendiente, prof, acc, dir,
    stats: {
      celdas: nc, area: nc * A, zmin, zmax, zmedia: zsum / nc, pendMedia: psum / nc,
      clases: clases.map((x) => x / nc), limites: CLASES.slice(0, -1),
      encArea, encVol, encMax, accMax,
    },
  };
}
