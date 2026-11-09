// Lluvias de diseño (GPEX, CC BY 4.0) y números de curva (SCS) por cobertura y tipo de suelo.

export const DURACIONES = [3, 6, 12, 24, 48, 72]; // horas
export const RETORNOS = [2, 5, 10, 20, 50, 100]; // años
const NV = DURACIONES.length * RETORNOS.length;

// Teselas de 1°×1° con 10×10 celdas de 0,1°; cada celda trae NV valores Uint16 en décimas de mm
// (orden: período de retorno, luego duración). 0xFFFF = sin dato. Fila 0 = norte.
const cache = new Map();
async function tesela(la, lo) {
  const n = `${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}${lo < 0 ? "W" : "E"}${String(Math.abs(lo)).padStart(3, "0")}`;
  if (!cache.has(n)) {
    cache.set(n, fetch(`data/gpex/${n}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint16Array(b) : null)).catch(() => null));
  }
  return cache.get(n);
}

// Precipitación (mm) por período de retorno y duración en el punto: promedio ponderado por distancia (1/d²)
// de las 4 celdas con datos más cercanas. Así el resultado no salta al cruzar el borde entre celdas de 0,1°.
export async function lluviasDiseno(lon, lat) {
  const cand = [];
  const kx = Math.cos((lat * Math.PI) / 180);
  for (let dla = -1; dla <= 1; dla++) {
    for (let dlo = -1; dlo <= 1; dlo++) {
      const la = Math.floor(lat) + dla, lo = Math.floor(lon) + dlo;
      const t = await tesela(la, lo);
      if (!t) continue;
      for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
        const cy = la + 1 - 0.05 - 0.1 * r, cx = lo + 0.05 + 0.1 * c;
        const dist = Math.hypot((cx - lon) * kx, cy - lat);
        if (dist > 0.25) continue;
        const base = (r * 10 + c) * NV;
        if (t[base] === 0xffff) continue;
        cand.push({ dist, v: t.subarray(base, base + NV) });
      }
    }
  }
  if (!cand.length) return null;
  cand.sort((a, b) => a.dist - b.dist);
  const usar = cand.slice(0, 4);
  const pesos = usar.map((c) => 1 / Math.max(1e-6, c.dist) ** 2);
  const suma = pesos.reduce((s, w) => s + w, 0);
  const prom = new Float64Array(NV);
  usar.forEach((c, k) => { for (let j = 0; j < NV; j++) prom[j] += (pesos[k] / suma) * (c.v[j] / 10); });
  const P = {};
  RETORNOS.forEach((T, k) => { P[T] = DURACIONES.map((_, j) => prom[k * DURACIONES.length + j]); });
  return { P, distanciaKm: usar[0].dist * 111.32 };
}

// Ajuste P(D) = a·D^n (D en horas) con las duraciones de 3 a 24 h, para interpolar o extrapolar a duraciones cortas.
export function ajusteIDF(Pfila) {
  const xs = [], ys = [];
  for (let j = 0; j < 4; j++) if (Pfila[j] > 0) { xs.push(Math.log(DURACIONES[j])); ys.push(Math.log(Pfila[j])); }
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const exp = Math.min(0.9, Math.max(0.1, sxy / sxx));
  return { a: Math.exp(my - exp * mx), n: exp };
}

// Número de curva (SCS / TR-55, humedad antecedente normal) por clase WorldCover y grupo hidrológico de suelo.
const CN = {
  10: [36, 60, 73, 79], // árboles (bosque, condición regular)
  20: [35, 56, 70, 77], // matorral
  30: [49, 69, 79, 84], // pradera / pastizal
  40: [67, 78, 85, 89], // cultivos en hilera
  50: [77, 85, 90, 92], // construido (residencial denso)
  60: [77, 86, 91, 94], // suelo desnudo
  70: [98, 98, 98, 98], // nieve o hielo
  80: [98, 98, 98, 98], // agua
  90: [85, 85, 85, 85], // humedal
  95: [70, 77, 83, 87], // manglar
  100: [68, 79, 86, 89], // musgo y liquen
};
export const SUELOS = {
  A: "Arenoso o muy permeable (el agua se infiltra rápido)",
  B: "Franco: tierra de hoja, permeabilidad media",
  C: "Franco-arcilloso o con capa dura: se infiltra lento",
  D: "Arcilloso, suelo delgado sobre roca o muy compactado",
};
export function numerosCurva(clase, suelo, defecto = 40) {
  const j = "ABCD".indexOf(suelo);
  const cn = new Float32Array(clase.length);
  for (let i = 0; i < clase.length; i++) cn[i] = (CN[clase[i]] || CN[defecto])[j];
  return cn;
}
