// Pintado de capas (canvas → imagen sobre el mapa), curvas de nivel y leyendas.
import { afin } from "./dem.js";
import { CLASES_WC } from "./cobertura.js";

const FUERA = 0.28; // opacidad relativa fuera del polígono (contexto)

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mezcla = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function rampa(paradas, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < paradas.length; i++) {
    if (t <= paradas[i][0]) {
      const [t0, c0] = paradas[i - 1], [t1, c1] = paradas[i];
      return mezcla(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return paradas[paradas.length - 1][1];
}

const HIPSO = [[0, hex("#2f6b3a")], [0.25, hex("#7da35a")], [0.5, hex("#d9c98a")], [0.75, hex("#b07a4a")], [1, hex("#f2ece4")]];
export const CLASES_PEND = [
  { hasta: 2, color: "#1a9850", txt: "0–2 % plano" },
  { hasta: 5, color: "#91cf60", txt: "2–5 % suave" },
  { hasta: 10, color: "#d9ef8b", txt: "5–10 % moderado" },
  { hasta: 15, color: "#fee08b", txt: "10–15 % inclinado" },
  { hasta: 30, color: "#fc8d59", txt: "15–30 % fuerte" },
  { hasta: 45, color: "#d73027", txt: "30–45 % muy fuerte" },
  { hasta: Infinity, color: "#7f0000", txt: "> 45 % escarpado" },
];
const PEND_RGB = CLASES_PEND.map((c) => hex(c.color));
const AGUA_QUIETA = hex("#7cc4ff");
const AGUA = [[0, hex("#bfe6ff")], [0.4, hex("#4aa8ff")], [1, hex("#0b3d91")]];

// Sombreado (hillshade) normalizado 0..1
export function sombreado(g) {
  const { w, h, z, dx, dy } = g;
  const s = new Float32Array(w * h);
  const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
  const zf = g.esDSM ? 1 : 1.5;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c, z0 = z[i];
      if (Number.isNaN(z0)) { s[i] = NaN; continue; }
      const q = (rr, cc) => {
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) return z0;
        const v = z[rr * w + cc];
        return Number.isNaN(v) ? z0 : v;
      };
      const dzdx = (q(r - 1, c + 1) + 2 * q(r, c + 1) + q(r + 1, c + 1) - q(r - 1, c - 1) - 2 * q(r, c - 1) - q(r + 1, c - 1)) / (8 * dx);
      const dzdy = (q(r + 1, c - 1) + 2 * q(r + 1, c) + q(r + 1, c + 1) - q(r - 1, c - 1) - 2 * q(r - 1, c) - q(r - 1, c + 1)) / (8 * dy);
      const pend = Math.atan(zf * Math.hypot(dzdx, dzdy));
      const asp = Math.atan2(dzdy, -dzdx);
      // fórmula de Esri: azimut matemático = 360 − az + 90; cenit = 90 − altura
      const zen = Math.PI / 2 - alt, azm = 2 * Math.PI - az + Math.PI / 2;
      const v = Math.cos(zen) * Math.cos(pend) + Math.sin(zen) * Math.sin(pend) * Math.cos(azm - asp);
      s[i] = Math.max(0, v);
    }
  }
  return s;
}

// Devuelve un canvas con la capa pedida
export function pintar(capa, g, a, opciones = {}) {
  const { w, h, z } = g;
  const mask = a.mask;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  const im = ctx.createImageData(w, h);
  const px = im.data;
  const st = a.stats;
  const rango = Math.max(1e-6, st.zmax - st.zmin);
  const umbral = opciones.umbralCauce || 5000; // m²
  const accMax = Math.log10(Math.max(umbral * 10, st.accMax));
  const accMin = Math.log10(umbral);
  const T = a.tormenta;
  const qMin = Math.log10(0.005), qMax = Math.log10(Math.max(0.05, T ? T.stats.qMax : 1));
  const WC = Object.fromEntries(Object.entries(CLASES_WC).map(([k, v]) => [k, hex(v.color)]));

  for (let i = 0; i < w * h; i++) {
    if (Number.isNaN(z[i])) continue;
    const k = mask[i] ? 1 : FUERA;
    let col = null, al = 0;
    if (capa === "elevacion") {
      const base = rampa(HIPSO, (z[i] - st.zmin) / rango);
      const sh = a.sombra[i];
      col = base.map((v) => v * (0.45 + 0.75 * sh));
      al = 0.9;
    } else if (capa === "pendiente") {
      let j = 0;
      while (a.pendiente[i] >= CLASES_PEND[j].hasta) j++;
      col = PEND_RGB[j]; al = 0.78;
    } else if (capa === "encharcamiento") {
      const d = T ? T.profT[i] : a.prof[i];
      if (d >= 0.05) { col = rampa(AGUA, Math.min(1, d / 1.5)); al = 0.55 + 0.4 * Math.min(1, d / 0.8); }
    } else if (capa === "escurrimiento") {
      const v = a.acc[i];
      // sobre agua quieta (pozas o lagunas) no hay cauce: se pinta como lámina de agua
      const quieta = (T ? T.profT[i] : a.prof[i]) >= 0.05;
      if (quieta) { col = AGUA_QUIETA; al = 0.55; }
      else if (v >= umbral) {
        const t = T
          ? (Math.log10(Math.max(T.qp[i], 0.005)) - qMin) / (qMax - qMin || 1)
          : (Math.log10(v) - accMin) / (accMax - accMin || 1);
        col = rampa(AGUA, 0.25 + 0.75 * t); al = 0.45 + 0.55 * Math.min(1, t * 1.4);
      }
    } else if (capa === "cobertura" && a.clase) {
      const c = WC[a.clase[i]];
      if (c) { col = c; al = 0.72; }
    }
    if (!col) continue;
    px[i * 4] = col[0]; px[i * 4 + 1] = col[1]; px[i * 4 + 2] = col[2];
    px[i * 4 + 3] = 255 * al * k;
  }
  ctx.putImageData(im, 0, 0);
  return cv;
}

// ---------- curvas de nivel (marching squares sobre centros de celda) ----------
export function equidistancia(rango) {
  for (const e of [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200]) if (rango / e <= 40) return e;
  return 500;
}

const TABLA = { 1: [["L", "B"]], 2: [["B", "R"]], 3: [["L", "R"]], 4: [["T", "R"]], 5: [["T", "R"], ["L", "B"]], 6: [["T", "B"]], 7: [["T", "L"]],
  8: [["T", "L"]], 9: [["T", "B"]], 10: [["T", "L"], ["B", "R"]], 11: [["T", "R"]], 12: [["L", "R"]], 13: [["B", "R"]], 14: [["L", "B"]] };

export function curvas(g, mask, eq) {
  const { w, h, z } = g;
  const aLL = afin(g);
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < w * h; i++) if (mask[i]) { zmin = Math.min(zmin, z[i]); zmax = Math.max(zmax, z[i]); }
  const feats = [];
  for (let L = Math.ceil(zmin / eq) * eq; L <= zmax; L += eq) {
    const segs = [];
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const i0 = r * w + c, i1 = i0 + 1, i2 = i0 + w + 1, i3 = i0 + w;
        if (!(mask[i0] && mask[i1] && mask[i2] && mask[i3])) continue;
        const v0 = z[i0], v1 = z[i1], v2 = z[i2], v3 = z[i3];
        const idx = (v0 > L ? 8 : 0) | (v1 > L ? 4 : 0) | (v2 > L ? 2 : 0) | (v3 > L ? 1 : 0);
        const t = TABLA[idx];
        if (!t) continue;
        const borde = (e) => {
          let x, y;
          if (e === "T") { x = c + (L - v0) / (v1 - v0); y = r; }
          else if (e === "R") { x = c + 1; y = r + (L - v1) / (v2 - v1); }
          else if (e === "B") { x = c + (L - v3) / (v2 - v3); y = r + 1; }
          else { x = c; y = r + (L - v0) / (v3 - v0); }
          return aLL(x + 0.5, y + 0.5);
        };
        for (const [e1, e2] of t) segs.push([borde(e1), borde(e2)]);
      }
    }
    if (segs.length) {
      const maestra = Math.abs(Math.round(L / eq) % 5) === 0;
      feats.push({ type: "Feature", properties: { cota: L, maestra }, geometry: { type: "MultiLineString", coordinates: segs } });
    }
  }
  return { type: "FeatureCollection", features: feats };
}

// ---------- leyendas ----------
const fmt = (v, d = 0) => v.toLocaleString("es-CL", { maximumFractionDigits: d, minimumFractionDigits: d });

export function leyenda(capa, a, opciones = {}) {
  const st = a.stats;
  const barra = (cols, izq, der) =>
    `<div class="ley-barra" style="background:linear-gradient(90deg,${cols.join(",")})"></div><div class="ley-ext"><span>${izq}</span><span>${der}</span></div>`;
  if (capa === "elevacion") return `<b>Elevación (m s.n.m.)</b>${barra(["#2f6b3a", "#7da35a", "#d9c98a", "#b07a4a", "#f2ece4"], fmt(st.zmin), fmt(st.zmax))}`;
  if (capa === "pendiente")
    return `<b>Pendiente</b>` + CLASES_PEND.map((c, i) => `<div class="ley-fila"><i style="background:${c.color}"></i>${c.txt}<span>${fmt(100 * st.clases[i])} %</span></div>`).join("");
  const T = a.tormenta;
  if (capa === "encharcamiento" && T) return `<b>Dónde se junta el agua · lluvia de ${opciones.retorno} años</b>${barra(["#bfe6ff", "#4aa8ff", "#0b3d91"], "5 cm", "≥ 1,5 m")}<p class="ley-nota">Pozas que se forman con esta tormenta. Algunas depresiones no alcanzan a llenarse.</p>`;
  if (capa === "escurrimiento" && T) return `<b>Caudal máximo · lluvia de ${opciones.retorno} años</b>${barra(["#8fd0ff", "#4aa8ff", "#0b3d91"], "0,005 m³/s", fmt(Math.max(0.05, T.stats.qMax), 2) + " m³/s")}<p class="ley-nota">Cuánta agua pasa por cada cauce en el peak de la tormenta (1 m³/s = 1.000 litros por segundo).</p>`;
  if (capa === "cobertura" && a.clase) {
    const n = {}; let tot = 0;
    for (let i = 0; i < a.clase.length; i++) if (a.mask[i] && a.clase[i]) { n[a.clase[i]] = (n[a.clase[i]] || 0) + 1; tot++; }
    return `<b>Cobertura del suelo (ESA WorldCover 2021)</b>` + Object.entries(n).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `<div class="ley-fila"><i style="background:${CLASES_WC[k].color}"></i>${CLASES_WC[k].nombre}<span>${fmt((100 * v) / tot)} %</span></div>`).join("");
  }
  if (capa === "encharcamiento") return `<b>Encharcamiento (profundidad)</b>${barra(["#bfe6ff", "#4aa8ff", "#0b3d91"], "5 cm", "≥ 1,5 m")}<p class="ley-nota">Depresiones sin salida, llenas hasta el borde (lluvia sin límite). Simula una tormenta para ver cuánto se llenan de verdad.</p>`;
  if (capa === "escurrimiento") return `<b>Escurrimiento (área aportante)</b>${barra(["#8fd0ff", "#4aa8ff", "#0b3d91"], fmt((opciones.umbralCauce || 5000) / 10000, 1) + " ha", fmt(st.accMax / 10000, 0) + " ha")}<p class="ley-nota">Por dónde corre el agua. Más oscuro = más superficie drena por ahí.</p>`;
  return "";
}
