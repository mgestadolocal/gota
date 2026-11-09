// Cálculo hidrológico y de pendientes (Web Worker).
// Grilla: w × h celdas, z Float32 (NaN = sin dato), mask Uint8 (1 = dentro del polígono),
// dx/dy = tamaño de celda en metros. La fila crece hacia el sur.

// Estado del último análisis (lo usa la simulación de tormenta)
let U = null;

// Vecinos D8: E, SE, S, SO, O, NO, N, NE
const VX = [1, 1, 0, -1, -1, -1, 0, 1];
const VY = [0, 1, 1, 1, 0, -1, -1, -1];

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.tipo === "analizar") {
      const g = { w: m.w, h: m.h, z: m.z, mask: m.mask, dx: m.dx, dy: m.dy };
      const r = analizar(g);
      U = { ...g, f: r._f, orden: r._orden, dir: r.dir.slice(), prof: r.prof.slice(), acc: r.acc.slice() };
      delete r._f; delete r._orden;
      self.postMessage({ tipo: "analisis", ...r }, [r.pendiente.buffer, r.prof.buffer, r.acc.buffer, r.dir.buffer]);
    } else if (m.tipo === "tormenta") {
      const r = tormenta(U, m);
      self.postMessage({ tipo: "tormenta", ...r }, [r.profT.buffer, r.qp.buffer, r.escurre.buffer]);
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
    pendiente, prof, acc, dir, _f: f, _orden: cola.subarray(0, qt),
    stats: {
      celdas: nc, area: nc * A, zmin, zmax, zmedia: zsum / nc, pendMedia: psum / nc,
      clases: clases.map((x) => x / nc), limites: CLASES.slice(0, -1),
      encArea, encVol, encMax, accMax,
    },
  };
}

// ---------- tormenta de diseño ----------
// p: { cn: Float32Array por celda, P24 (mm), idf: { a, n } con P(D) = a·D^n (D en horas) }
// 1) Escorrentía por celda con el número de curva (SCS) para la lluvia de 24 h.
// 2) El agua escurre por el flujo D8; las depresiones se llenan hasta su capacidad y rebalsan
//    hacia aguas abajo (llenado y desborde simplificado: cada depresión se llena como una sola poza).
// 3) Caudal punta por cauce con el método racional: Q = C·i·A/3,6, i a la duración del tiempo de
//    concentración (California) y C = escorrentía / lluvia de la cuenca aportante.
function tormenta(Ur, p) {
  if (!Ur) throw new Error("Primero analiza el terreno.");
  const { w, h, z, mask, dx, dy, f, dir, orden } = Ur;
  const n = w * h, A = dx * dy, dd = Math.hypot(dx, dy);
  const dist = [dx, dd, dy, dd, dx, dd, dy, dd];
  const { cn, P24, idf } = p;

  const qSCS = (P, CN) => {
    const S = 25400 / CN - 254, Ia = 0.2 * S;
    return P > Ia ? ((P - Ia) * (P - Ia)) / (P - Ia + S) : 0;
  };

  // 1) escorrentía local (mm) y volumen (m³)
  const escurre = new Float32Array(n);
  for (let i = 0; i < n; i++) escurre[i] = Number.isNaN(z[i]) ? 0 : qSCS(P24, cn[i]);

  // 2) depresiones = componentes conexas con profundidad de relleno > 5 mm
  const UMBRAL = 0.005;
  const comp = new Int32Array(n).fill(-1);
  const capacidad = [];
  const pila = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || !(f[i] - z[i] > UMBRAL)) continue;
    const k = capacidad.length;
    let cap = 0, sp = 0;
    pila[sp++] = i; comp[i] = k;
    while (sp) {
      const c = pila[--sp];
      cap += (f[c] - z[c]) * A;
      const r = (c / w) | 0, col = c - r * w;
      for (let q = 0; q < 8; q++) {
        const rr = r + VY[q], cc = col + VX[q];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const v = rr * w + cc;
        if (comp[v] < 0 && f[v] - z[v] > UMBRAL) { comp[v] = k; pila[sp++] = v; }
      }
    }
    capacidad.push(cap);
  }
  const libre = Float64Array.from(capacidad);
  const guardado = new Float64Array(capacidad.length);

  // flujo de volumen en orden topológico; al salir de una depresión se descuenta lo que queda retenido
  const W = new Float64Array(n);
  for (let i = 0; i < n; i++) W[i] = (escurre[i] / 1000) * A;
  const receptor = (c) => (dir[c] < 0 ? -1 : c + VY[dir[c]] * w + VX[dir[c]]);
  // longitud de flujo más larga, cota de su inicio y CN medio aguas arriba (para el método racional)
  const L = new Float64Array(n), zIni = Float64Array.from(z), cnA = new Float64Array(n), area = new Float64Array(n);
  for (let i = 0; i < n; i++) { cnA[i] = cn[i] * A; area[i] = A; }

  let saleDelPoligono = 0, entraAlPoligono = 0;
  for (let t = 0; t < orden.length; t++) {
    const c = orden[t];
    const rec = receptor(c);
    const k = comp[c];
    if (k >= 0 && (rec < 0 || comp[rec] !== k)) {
      const ret = Math.min(W[c], libre[k]);
      libre[k] -= ret; guardado[k] += ret; W[c] -= ret;
    }
    if (rec < 0) { if (mask[c]) saleDelPoligono += W[c]; continue; }
    if (mask[c] && !mask[rec]) saleDelPoligono += W[c];
    if (!mask[c] && mask[rec]) entraAlPoligono += W[c];
    W[rec] += W[c];
    cnA[rec] += cnA[c]; area[rec] += area[c];
    const cand = L[c] + dist[dir[c]];
    if (cand > L[rec]) { L[rec] = cand; zIni[rec] = zIni[c]; }
  }

  // nivel de agua en cada depresión según lo retenido (bisección sobre la cota)
  const miembros = Array.from({ length: capacidad.length }, () => []);
  for (let i = 0; i < n; i++) if (comp[i] >= 0) miembros[comp[i]].push(i);
  const profT = new Float32Array(n);
  for (let k = 0; k < capacidad.length; k++) {
    if (guardado[k] <= 0) continue;
    const cel = miembros[k];
    let lo = Infinity, hi = -Infinity;
    for (const c of cel) { lo = Math.min(lo, z[c]); hi = Math.max(hi, f[c]); }
    const vol = (nivel) => { let v = 0; for (const c of cel) v += Math.max(0, Math.min(nivel, f[c]) - z[c]); return v * A; };
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (vol(m) < guardado[k]) lo = m; else hi = m; }
    for (const c of cel) profT[c] = Math.max(0, Math.min(hi, f[c]) - z[c]);
  }

  // 3) caudal punta (m³/s)
  const qp = new Float32Array(n);
  const PD = (D) => idf.a * Math.pow(D, idf.n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(z[i])) { qp[i] = NaN; continue; }
    const Lkm = Math.max(L[i], dx) / 1000;
    const H = Math.max(zIni[i] - z[i], 0.001 * Lkm * 1000, 0.1);
    const tc = Math.max(1 / 6, 0.95 * Math.pow((Lkm * Lkm * Lkm) / H, 0.385)); // horas, mínimo 10 min
    const iMMh = PD(tc) / tc;
    const C = qSCS(P24, cnA[i] / area[i]) / P24;
    qp[i] = (C * iMMh * (area[i] / 1e6)) / 3.6;
  }

  // estadísticas dentro del polígono
  let nc = 0, llueve = 0, genera = 0, enCharcos = 0, aCharcos = 0, qMax = 0, iMax = -1;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || Number.isNaN(z[i])) continue;
    nc++;
    llueve += (P24 / 1000) * A;
    genera += (escurre[i] / 1000) * A;
    if (profT[i] >= 0.02) { enCharcos += profT[i] * A; aCharcos += A; }
    if (qp[i] > qMax) { qMax = qp[i]; iMax = i; }
  }
  return {
    profT, qp, escurre,
    stats: { llueve, genera, infiltra: llueve - genera, enCharcos, aCharcos, sale: saleDelPoligono, entra: entraAlPoligono,
      qMax, iMax, cnMedio: Array.from(cn).reduce((s, v, i) => s + (mask[i] ? v : 0), 0) / nc },
  };
}
