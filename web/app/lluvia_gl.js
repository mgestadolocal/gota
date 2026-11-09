// Lluvia en WebGL: capa personalizada de MapLibre que dibuja miles de gotas con estela directo en la GPU.
// - En 3D las gotas van pegadas al relieve del mapa (misma elevación y exageración que el terreno) y los cerros
//   las tapan cuando quedan detrás (prueba de profundidad contra el terreno).
// - Estela en un búfer circular: cada cuadro solo se sube la posición nueva de cada gota (n puntos), y la GPU
//   calcula la antigüedad de cada punto para desvanecer la cola. Nada de GeoJSON ni recálculos por cuadro.
// - La simulación avanza por tiempo real dentro del ciclo de dibujo del mapa.
/* global maplibregl */

const VX = [1, 1, 0, -1, -1, -1, 0, 1], VY = [0, 1, 1, 1, 0, -1, -1, -1];
const ESTELA = 20; // cuadros de estela por gota
const STRIDE = 5; // x, y, z, alfa, cuadro en que se escribió

const VS = `
precision highp float;
attribute vec3 a_pos;
attribute float a_a;
attribute float a_cuadro;
uniform mat4 u_matrix;
uniform float u_size;
uniform float u_cuadro;
uniform float u_estela;
varying float v_a;
void main() {
  float edad = u_cuadro - a_cuadro;            // 0 = cabeza
  float f = clamp(1.0 - edad / u_estela, 0.0, 1.0);
  v_a = a_a * f * f;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  if (v_a < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // fuera de pantalla
  gl_PointSize = u_size * (0.35 + 0.65 * f);
}`;
const FS = `
precision mediump float;
varying float v_a;
uniform vec3 u_cabeza;
uniform vec3 u_cola;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * v_a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(u_cola, u_cabeza, v_a) * a, a);
}`;

function compilar(gl, tipo, src) {
  const s = gl.createShader(tipo);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

export function crearCapaLluvia(mapa) {
  const S = { activa: false, gotas: [], n: 0, ultimo: 0, cuadro: 0, opciones: { tam: 1, brillo: 1 }, subir: true };

  const capa = {
    id: "gotas",
    type: "custom",
    renderingMode: "3d",
    onAdd(map, gl) {
      const p = gl.createProgram();
      gl.attachShader(p, compilar(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compilar(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      Object.assign(S, {
        prog: p, aPos: gl.getAttribLocation(p, "a_pos"), aA: gl.getAttribLocation(p, "a_a"), aC: gl.getAttribLocation(p, "a_cuadro"),
        uM: gl.getUniformLocation(p, "u_matrix"), uSize: gl.getUniformLocation(p, "u_size"), uCuadro: gl.getUniformLocation(p, "u_cuadro"),
        uEstela: gl.getUniformLocation(p, "u_estela"), uCab: gl.getUniformLocation(p, "u_cabeza"), uCola: gl.getUniformLocation(p, "u_cola"),
        vbo: gl.createBuffer(),
      });
    },
    render(gl, matrix) {
      if (!S.activa || !S.n) return;
      const ahora = performance.now();
      const dt = S.ultimo ? Math.min(0.1, (ahora - S.ultimo) / 1000) : 0;
      S.ultimo = ahora;

      gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
      if (S.subir) { gl.bufferData(gl.ARRAY_BUFFER, S.datos, gl.DYNAMIC_DRAW); S.subir = false; }
      if (dt > 0) {
        paso(dt);
        // solo el bloque de este cuadro (posición nueva de cada gota)
        const slot = S.cuadro % ESTELA, bloque = S.n * STRIDE;
        gl.bufferSubData(gl.ARRAY_BUFFER, slot * bloque * 4, S.datos.subarray(slot * bloque, (slot + 1) * bloque));
      }

      // matriz relativa al origen (evita temblor por precisión de float32 en zoom alto)
      const m = matrix, mr = S.mr || (S.mr = new Float32Array(16));
      for (let i = 0; i < 12; i++) mr[i] = m[i];
      for (let r = 0; r < 4; r++) mr[12 + r] = m[r] * S.ox + m[4 + r] * S.oy + m[12 + r];

      gl.useProgram(S.prog);
      gl.uniformMatrix4fv(S.uM, false, mr);
      const z = mapa.getZoom();
      gl.uniform1f(S.uSize, Math.max(2.2, Math.min(7, 0.62 * (z - 7))) * devicePixelRatio * S.opciones.tam);
      gl.uniform1f(S.uCuadro, S.cuadro);
      gl.uniform1f(S.uEstela, ESTELA);
      gl.uniform3f(S.uCab, 0.95 * S.opciones.brillo, 0.99 * S.opciones.brillo, 1.0);
      gl.uniform3f(S.uCola, 0.36, 0.72, 1.0);
      gl.enableVertexAttribArray(S.aPos);
      gl.vertexAttribPointer(S.aPos, 3, gl.FLOAT, false, STRIDE * 4, 0);
      gl.enableVertexAttribArray(S.aA);
      gl.vertexAttribPointer(S.aA, 1, gl.FLOAT, false, STRIDE * 4, 12);
      gl.enableVertexAttribArray(S.aC);
      gl.vertexAttribPointer(S.aC, 1, gl.FLOAT, false, STRIDE * 4, 16);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, S.n * ESTELA);
      gl.disableVertexAttribArray(S.aA);
      gl.disableVertexAttribArray(S.aC);
      mapa.triggerRepaint();
    },
  };

  // ---------- elevación del terreno del mapa (la misma con que se dibuja el relieve 3D) ----------
  // (se llama una vez por cuadro) prepara el estado del terreno para la función elevacion
  function prepararElevacion() {
    const t = mapa.getTerrain();
    S.hayTerreno = !!t;
    if (!t) return;
    const exa = t.exaggeration || 1;
    if (S.cacheExa !== exa) { S.cache = new Map(); S.cacheExa = exa; }
    S.elevCentro = mapa.transform.elevation || 0;
    S.desfase = (3 * exa - S.elevCentro) * S.mPorMetro;
  }
  function elevacion(i, cx, cy) {
    if (!S.hayTerreno) return 0;
    let abs = S.cache.get(i);
    if (abs === undefined) {
      const rel = mapa.queryTerrainElevation(S.aLL(cx, cy));
      // 0 = la tesela de relieve aún no carga: no se guarda y la gota se oculta hasta tener el dato
      if (rel === null || rel === undefined || rel === 0) return null;
      abs = rel + S.elevCentro;
      S.cache.set(i, abs);
    }
    return abs * S.mPorMetro + S.desfase;
  }

  // ---------- simulación ----------
  function sortear() { return S.celdas[(Math.random() * S.celdas.length) | 0]; }
  function nueva(g) {
    const E = S.E;
    g.i = sortear();
    for (let k = 0; k < 30; k++) {
      const ok = !S.enPoza(g.i) && E.an.dir[g.i] >= 0 && (!S.esc || Math.random() <= 0.45 + 0.55 * Math.min(1, S.esc[g.i] / S.escMax));
      if (ok) break;
      g.i = sortear();
    }
    g.t = Math.random();
    g.vida = 0;
    g.max = 3 + Math.random() * 4;
    g.funde = 0;
    return g;
  }
  function paso(dt) {
    const E = S.E, dir = E.an.dir, pe = E.an.pendiente, w = E.g.w, h = E.g.h;
    S.cuadro++;
    prepararElevacion();
    const slot = S.cuadro % ESTELA, base = slot * S.n * STRIDE, d = S.datos, A = S.afinM;
    for (let n = 0; n < S.n; n++) {
      const g = S.gotas[n];
      g.vida += dt;
      if (g.vida > g.max || (g.funde && (g.funde += dt) > 0.7)) nueva(g);
      const v = g.funde ? 1.2 : S.veloc * (5 + 16 * Math.min(1, pe[g.i] / 15));
      g.t += v * dt;
      while (g.t >= 1) {
        g.t -= 1;
        const k = dir[g.i];
        const r = (g.i / w) | 0, c = g.i - r * w;
        const rr = r + VY[k], cc = c + VX[k];
        if (k < 0 || rr < 0 || cc < 0 || rr >= h || cc >= w || dir[rr * w + cc] < 0) { nueva(g); break; }
        g.i = rr * w + cc;
        if (!g.funde && S.enPoza(g.i)) g.funde = 0.001;
      }
      const r = (g.i / w) | 0, c = g.i - r * w, kk = Math.max(0, dir[g.i]);
      const cx = c + 0.5 + VX[kk] * g.t, cy = r + 0.5 + VY[kk] * g.t;
      // posición en Mercator por transformación afín precalculada (sin log/tan por gota)
      const x = A[0] + A[1] * cx + A[2] * cy, y = A[3] + A[4] * cx + A[5] * cy;
      const z = elevacion(g.i, cx, cy);
      const o = base + n * STRIDE;
      d[o] = x; d[o + 1] = y; d[o + 2] = z === null ? 0 : z;
      const aparece = Math.min(1, g.vida / 0.35), desaparece = Math.min(1, (g.max - g.vida) / 0.5);
      d[o + 3] = z === null ? 0 : Math.min(aparece, desaparece) * (g.funde ? 1 - g.funde / 0.7 : 1);
      d[o + 4] = S.cuadro;
    }
  }

  return {
    capa,
    estado: S,
    iniciar({ E, afin, enPoza, celdas, esc, escMax, veloc, cantidad }) {
      S.E = E; S.aLL = afin; S.enPoza = enPoza; S.celdas = celdas; S.esc = esc; S.escMax = escMax; S.veloc = veloc;
      const c = afin(E.g.w / 2, E.g.h / 2);
      S.ox = mercX(c[0]); S.oy = mercY(c[1]);
      // afín celda → Mercator relativo al origen (a partir de tres esquinas de la grilla)
      const p0 = afin(0, 0), p1 = afin(E.g.w, 0), p2 = afin(0, E.g.h);
      const X = (p) => mercX(p[0]) - S.ox, Y = (p) => mercY(p[1]) - S.oy;
      S.afinM = [X(p0), (X(p1) - X(p0)) / E.g.w, (X(p2) - X(p0)) / E.g.h, Y(p0), (Y(p1) - Y(p0)) / E.g.w, (Y(p2) - Y(p0)) / E.g.h];
      S.mPorMetro = maplibregl.MercatorCoordinate.fromLngLat(c).meterInMercatorCoordinateUnits();
      S.cache = new Map(); S.cacheExa = null;
      S.n = cantidad;
      S.gotas = Array.from({ length: cantidad }, () => nueva({}));
      for (const g of S.gotas) g.vida = Math.random() * g.max; // desfasadas: no nacen todas juntas
      S.datos = new Float32Array(cantidad * ESTELA * STRIDE);
      for (let i = 4; i < S.datos.length; i += STRIDE) S.datos[i] = -1e6; // nada escrito todavía
      S.subir = true;
      S.ultimo = 0; S.cuadro = 0;
      S.activa = true;
      mapa.triggerRepaint();
    },
    detener() {
      S.activa = false; S.n = 0;
      mapa.triggerRepaint();
    },
    opciones(o) { Object.assign(S.opciones, o); },
  };
}
