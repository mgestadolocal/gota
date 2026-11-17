// Ríos que entran al área analizada desde fuera, con la capa nacional de cuencas (HydroSHEDS 15" ≈ 450 m,
// generada con tools/cuencas_nacionales.py y tools/cuencas_teselas.py). Cada entrada trae el área aportante,
// el número de curva medio y el recorrido más largo de toda su cuenca aguas arriba, para que el caudal de un
// predio a la orilla de un río incluya el agua que viene de arriba (el relieve local solo cubre el área + margen).
// Datos: HydroSHEDS v1 © WWF (Lehner et al. 2008), ESA WorldCover 2021 (CC BY 4.0).
const RES = 15 / 3600;
const D8 = { 1: [0, 1], 2: [1, 1], 4: [1, 0], 8: [1, -1], 16: [0, -1], 32: [-1, -1], 64: [-1, 0], 128: [-1, 1] };
const cache = new Map();

async function tesela(la, lo) {
  const n = `${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}${lo < 0 ? "W" : "E"}${String(Math.abs(lo)).padStart(3, "0")}`;
  if (!cache.has(n)) {
    cache.set(n, fetch(new URL(`data/cuencas/${n}.bin`, import.meta.url)).then(async (r) => {
      if (!r.ok) return null;
      const b = await r.arrayBuffer();
      const N = new DataView(b).getUint32(0, true);
      let o = 4;
      const A = new Float32Array(b, o, N); o += 4 * N;
      const L = new Float32Array(b, o, N); o += 4 * N;
      const Z0 = new Int16Array(b, o, N); o += 2 * N;
      const fila = new Uint8Array(b, o, N); o += N;
      const col = new Uint8Array(b, o, N); o += N;
      const dir = new Uint8Array(b, o, N); o += N;
      const cn = new Uint8Array(b, o, N);
      return { N, A, L, Z0, fila, col, dir, cn, la, lo };
    }).catch(() => null));
  }
  return cache.get(n);
}

// g: grilla local; an: resultado del análisis (prof = relleno − z, acc = área aportante local).
// Devuelve [{ i, area_m2, cn, L_m, zIni, areaKm2 }] listas para el Worker.
export async function riosQueEntran(g, an, { areaMin = 1, radio = 15 } = {}) {
  if (g.georef.crs !== "EPSG:4326") return []; // DEM del usuario en UTM: por ahora solo con Copernicus
  const { x0, y0, rx, ry } = g.georef;
  const lon0 = x0, lon1 = x0 + g.w * rx, lat1 = y0, lat0 = y0 - g.h * ry;
  const dentro = (lo, la) => lo >= lon0 && lo <= lon1 && la >= lat0 && la <= lat1;
  const pedidos = [];
  const M = 0.1; // margen para seguir los ríos aguas abajo
  for (let la = Math.floor(lat0 - M); la <= Math.floor(lat1 + M); la++)
    for (let lo = Math.floor(lon0 - M); lo <= Math.floor(lon1 + M); lo++) pedidos.push(tesela(la, lo));
  const teselas = (await Promise.all(pedidos)).filter(Boolean);
  // índice global de celdas de cauce (fila desde 0°, columna desde 180° O) → dirección D8
  const clave = (gr, gc) => gr * 100000 + gc;
  const dirG = new Map();
  for (const t of teselas) {
    const fr = Math.round(-(t.la + 1) / RES), fc = Math.round((t.lo + 180) / RES);
    for (let k = 0; k < t.N; k++) dirG.set(clave(fr + t.fila[k], fc + t.col[k]), t.dir[k]);
  }
  const out = [];
  for (const t of teselas) {
    for (let k = 0; k < t.N; k++) {
      if (t.A[k] < areaMin) continue;
      const la = t.la + 1 - (t.fila[k] + 0.5) * RES, lo = t.lo + (t.col[k] + 0.5) * RES;
      if (lo < lon0 - 2 * RES || lo > lon1 + 2 * RES || la < lat0 - 2 * RES || la > lat1 + 2 * RES || dentro(lo, la)) continue;
      const d = D8[t.dir[k]];
      if (!d) continue;
      const la2 = la - d[0] * RES, lo2 = lo + d[1] * RES;
      if (!dentro(lo2, la2)) continue;
      const c0 = Math.min(g.w - 1, Math.max(0, Math.floor((lo2 - x0) / rx)));
      const r0 = Math.min(g.h - 1, Math.max(0, Math.floor((y0 - la2) / ry)));
      const fr = Math.round(-(t.la + 1) / RES) + t.fila[k], fc = Math.round((t.lo + 180) / RES) + t.col[k];
      // recorrido del río de HydroSHEDS dentro del área (para calzar su forma con el cauce local)
      const curso = [];
      {
        let r = fr + d[0], c = fc + d[1];
        for (let s = 0; s < 400; s++) {
          const lat = -(r + 0.5) * RES, lon = -180 + (c + 0.5) * RES;
          if (!dentro(lon, lat)) break;
          curso.push([lon, lat]);
          const dd = D8[dirG.get(clave(r, c))];
          if (!dd) break;
          r += dd[0]; c += dd[1];
        }
      }
      let iMin = -1;
      if (an?.dir && curso.length >= 3) {
        // celdas del borde (≤ 4 celdas) a ≤ ~1,5 km de la entrada: se sigue su flujo local y se elige la que corre
        // más pegada al recorrido de HydroSHEDS (corrige desfases de hasta un par de km entre ambos relieves)
        const R = Math.max(radio, Math.round(1500 / Math.min(g.dx, g.dy)));
        const kx = Math.cos((la2 * Math.PI) / 180) * 111320, ky = 111320;
        const distCurso = (lon, lat) => {
          let m = Infinity;
          for (const [a, b] of curso) { const v = ((lon - a) * kx) ** 2 + ((lat - b) * ky) ** 2; if (v < m) m = v; }
          return Math.sqrt(m);
        };
        const VX = [1, 1, 0, -1, -1, -1, 0, 1], VY = [0, 1, 1, 1, 0, -1, -1, -1];
        const largo = Math.min(300, Math.round((curso.length * RES * ky) / Math.min(g.dx, g.dy)));
        let mejor = Infinity;
        for (let r = Math.max(0, r0 - R); r <= Math.min(g.h - 1, r0 + R); r++)
          for (let c = Math.max(0, c0 - R); c <= Math.min(g.w - 1, c0 + R); c++) {
            if (Math.min(r, c, g.h - 1 - r, g.w - 1 - c) > 4 || (r - r0) ** 2 + (c - c0) ** 2 > R * R) continue;
            const i0 = r * g.w + c;
            if (Number.isNaN(g.z[i0])) continue;
            let i = i0, suma = 0, n = 0;
            for (let s = 0; s < largo; s++) {
              suma += distCurso(x0 + ((i % g.w) + 0.5) * rx, y0 - (Math.floor(i / g.w) + 0.5) * ry); n++;
              const dl = an.dir[i];
              if (dl < 0) break;
              const rr = Math.floor(i / g.w) + VY[dl], cc = (i % g.w) + VX[dl];
              if (rr < 0 || cc < 0 || rr >= g.h || cc >= g.w) break;
              i = rr * g.w + cc;
            }
            // recorridos que salen enseguida no sirven; se penaliza el recorrido corto
            const costo = suma / n + 3000 / Math.max(1, n);
            if (costo < mejor) { mejor = costo; iMin = i0; }
          }
      }
      if (iMin < 0) {
        // río que apenas toca el área: la celda más baja de la superficie RELLENADA (no el fondo de una poza);
        // entre celdas a la misma cota (±0,5 m), la de mayor área aportante
        let fMin = Infinity, accMin = -1;
        for (let r = Math.max(0, r0 - radio); r <= Math.min(g.h - 1, r0 + radio); r++)
          for (let c = Math.max(0, c0 - radio); c <= Math.min(g.w - 1, c0 + radio); c++) {
            if ((r - r0) ** 2 + (c - c0) ** 2 > radio * radio) continue;
            const i = r * g.w + c;
            if (Number.isNaN(g.z[i])) continue;
            const f = g.z[i] + (an?.prof ? an.prof[i] || 0 : 0);
            const acc = an?.acc ? an.acc[i] : 0;
            if (f < fMin - 0.5 || (f <= fMin + 0.5 && acc > accMin)) { if (f < fMin) fMin = f; accMin = acc; iMin = i; }
          }
      }
      if (iMin < 0) continue;
      const paso = d[0] && d[1] ? Math.SQRT2 : 1;
      out.push({ _g: clave(fr, fc), _fr: fr, _fc: fc, i: iMin, area_m2: t.A[k] * 1e6, areaKm2: t.A[k], cn: t.cn[k], L_m: (t.L[k] + paso * RES * 111.32) * 1000, zIni: t.Z0[k],
        lon: lo2, lat: la2 });
    }
  }
  // un río que sale y vuelve a entrar se contaría dos veces: se descarta la entrada cuyo recorrido aguas abajo
  // pasa por otra celda de entrada (esa ya trae toda su cuenca)
  const claves = new Set(out.map((e) => e._g));
  return out.filter((e) => {
    let r = e._fr, c = e._fc;
    for (let paso = 0; paso < 2000; paso++) {
      const d = D8[dirG.get(clave(r, c))];
      if (!d) return true;
      r += d[0]; c += d[1];
      if (claves.has(clave(r, c))) return false;
    }
    return true;
  }).map(({ _g, _fr, _fc, ...e }) => e);
}
