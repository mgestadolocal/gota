/* global maplibregl */
import { geotiffFloat32 } from "./geotiff_escribir.js";
import { cargarCopernicus, cargarArchivo, mascara, esquinas, afin, areaAnillo } from "./dem.js";
import { pintar, sombreado, curvas, equidistancia, leyenda, CLASES_PEND } from "./render.js";

const params = new URLSearchParams(location.search);
const API = (params.get("api") || window.COTA_API || location.origin).replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString("es-CL", { maximumFractionDigits: d, minimumFractionDigits: d });
const ha = (m2) => (m2 >= 100000 ? fmt(m2 / 10000, 0) : fmt(m2 / 10000, m2 >= 10000 ? 1 : 2)) + " ha";
const m3 = (v) => fmt(Math.round(v)) + " m³";

const E = {
  anillo: null, vertices: [], cursor: null, dibujando: false,
  archivo: null, g: null, an: null, capa: "escurrimiento",
};

// ---------- mapa ----------
const mapa = new maplibregl.Map({
  container: "mapa",
  style: {
    version: 8,
    sources: {
      sat: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        attribution: "Imágenes © Esri, Maxar, Earthstar Geographics",
      },
      dem: {
        type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      },
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
  },
  center: [-71.05, -34.45],
  zoom: 9,
  maxPitch: 80,
  preserveDrawingBuffer: true,
  attributionControl: { compact: true },
});
mapa.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
mapa.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

const vacio = { type: "FeatureCollection", features: [] };
mapa.on("load", () => {
  mapa.addSource("curvas", { type: "geojson", data: vacio });
  mapa.addSource("poligono", { type: "geojson", data: vacio });
  mapa.addSource("gotas", { type: "geojson", data: vacio });
  mapa.addLayer({ id: "curvas", type: "line", source: "curvas",
    paint: { "line-color": "#ffffff", "line-opacity": ["case", ["get", "maestra"], 0.75, 0.38], "line-width": ["case", ["get", "maestra"], 1.4, 0.7] } });
  mapa.addLayer({ id: "pol-relleno", type: "fill", source: "poligono", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#ffd166", "fill-opacity": 0.08 } });
  mapa.addLayer({ id: "pol-linea", type: "line", source: "poligono", filter: ["!=", "$type", "Point"], paint: { "line-color": "#ffd166", "line-width": 2.4 } });
  mapa.addLayer({ id: "gotas", type: "circle", source: "gotas",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 16, 3.2], "circle-color": "#9be3ff", "circle-opacity": ["get", "o"], "circle-blur": 0.3 } });
  mapa.addLayer({ id: "pol-vertices", type: "circle", source: "poligono", filter: ["==", "$type", "Point"],
    paint: { "circle-radius": 4.5, "circle-color": "#ffd166", "circle-stroke-color": "#1d2420", "circle-stroke-width": 1.5 } });
});

// ---------- estado / mensajes ----------
function estado(txt, error = false) {
  const el = $("estado");
  el.hidden = !txt;
  el.textContent = txt || "";
  el.classList.toggle("error", !!error);
}

// ---------- dibujo del polígono ----------
function dibujarPoligono() {
  const f = [];
  if (E.anillo) f.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [E.anillo] } });
  else if (E.vertices.length) {
    const linea = E.cursor ? [...E.vertices, E.cursor] : E.vertices;
    if (linea.length > 1) f.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: linea } });
    E.vertices.forEach((v) => f.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: v } }));
  }
  mapa.getSource("poligono")?.setData({ type: "FeatureCollection", features: f });
}

function empezarDibujo() {
  limpiarResultados();
  E.anillo = null; E.vertices = []; E.cursor = null; E.dibujando = true;
  mapa.doubleClickZoom.disable();
  mapa.getCanvas().style.cursor = "crosshair";
  $("b-dibujar").textContent = "Cancelar dibujo";
  $("b-dibujar").classList.add("activo");
  $("ayuda-dibujo").hidden = false;
  $("info-poligono").hidden = true;
  actualizarBotonAnalizar();
  dibujarPoligono();
}

function terminarDibujo(cerrar) {
  E.dibujando = false;
  mapa.getCanvas().style.cursor = "";
  setTimeout(() => mapa.doubleClickZoom.enable(), 300);
  $("b-dibujar").textContent = "Dibujar polígono";
  $("b-dibujar").classList.remove("activo");
  $("ayuda-dibujo").hidden = true;
  // quitar vértices repetidos (el doble clic agrega dos)
  const v = E.vertices.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-7);
  if (cerrar && v.length >= 3) {
    E.anillo = [...v, v[0]];
    const area = areaAnillo(E.anillo);
    $("info-poligono").hidden = false;
    $("info-poligono").innerHTML = `Polígono de <b>${ha(area)}</b> · ${v.length} vértices`;
  }
  E.vertices = []; E.cursor = null;
  dibujarPoligono();
  actualizarBotonAnalizar();
}

$("b-dibujar").onclick = () => (E.dibujando ? terminarDibujo(false) : empezarDibujo());
$("deshacer").onclick = (e) => { e.preventDefault(); E.vertices.pop(); dibujarPoligono(); };

mapa.on("click", (e) => {
  if (!E.dibujando) return;
  const p = [e.lngLat.lng, e.lngLat.lat];
  if (E.vertices.length >= 3) {
    const a = mapa.project(E.vertices[0]);
    if (Math.hypot(a.x - e.point.x, a.y - e.point.y) < 12) return terminarDibujo(true);
  }
  E.vertices.push(p);
  dibujarPoligono();
});
mapa.on("dblclick", (e) => { if (E.dibujando) { e.preventDefault(); terminarDibujo(true); } });
mapa.on("mousemove", (e) => { if (E.dibujando && E.vertices.length) { E.cursor = [e.lngLat.lng, e.lngLat.lat]; dibujarPoligono(); } });
document.addEventListener("keydown", (e) => {
  if (!E.dibujando) return;
  if (e.key === "Escape") terminarDibujo(false);
  if (e.key === "Enter") terminarDibujo(true);
  if (e.key === "Backspace" && document.activeElement === document.body) { E.vertices.pop(); dibujarPoligono(); }
});

// ---------- búsqueda de lugares (Nominatim, solo al presionar Enter) ----------
$("buscar").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cl&q=${encodeURIComponent(q)}`);
    const [res] = await r.json();
    if (!res) return estado("No encontré ese lugar.", true);
    estado("");
    const [s, n, o, e_] = res.boundingbox.map(Number);
    mapa.fitBounds([[o, s], [e_, n]], { padding: 60, maxZoom: 16 });
  } catch { estado("No pude buscar el lugar.", true); }
};

// ---------- DEM propio ----------
$("archivo").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  E.archivo = f;
  $("fuente-nombre").textContent = f.name;
  $("quitar-archivo").hidden = false;
  limpiarResultados();
  actualizarBotonAnalizar();
  estado(E.anillo ? "" : "Puedes analizar el archivo completo o dibujar un polígono para recortarlo.");
};
$("quitar-archivo").onclick = (e) => {
  e.preventDefault();
  E.archivo = null; $("archivo").value = "";
  $("fuente-nombre").textContent = "Copernicus GLO-30 (30 m, todo Chile)";
  $("quitar-archivo").hidden = true;
  limpiarResultados(); actualizarBotonAnalizar(); estado("");
};

function actualizarBotonAnalizar() {
  $("b-analizar").disabled = E.dibujando || !(E.anillo || E.archivo);
}

// ---------- Web Worker de análisis ----------
const trabajador = new Worker("analisis.js");
let pendiente = null;
trabajador.onmessage = (e) => {
  const p = pendiente; pendiente = null;
  if (!p) return;
  if (e.data.tipo === "error") p.no(new Error(e.data.mensaje)); else p.si(e.data);
};
const pedir = (msg, transfer = []) => new Promise((si, no) => { pendiente = { si, no }; trabajador.postMessage(msg, transfer); });

// ---------- análisis ----------
$("b-analizar").onclick = async () => {
  $("b-analizar").disabled = true;
  detenerLluvia();
  try {
    estado("Preparando…");
    const g = E.archivo ? await cargarArchivo(E.archivo, E.anillo, estado) : await cargarCopernicus(API, E.anillo, estado);
    const mask = mascara(g, E.anillo);
    if (!mask.some((v) => v)) throw new Error("No hay datos de elevación dentro del polígono.");
    estado(`Calculando escurrimiento y pendientes (${fmt(g.w * g.h)} celdas)…`);
    const r = await pedir({ tipo: "analizar", w: g.w, h: g.h, z: g.z.slice(), mask: mask.slice(), dx: g.dx, dy: g.dy });
    E.g = g;
    E.an = { ...r, mask, sombra: sombreado(g) };
    estado("");
    if (!E.anillo) {
      const c = esquinas(g);
      mapa.fitBounds([[Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1]))], [Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))]], { padding: 40 });
    }
    mostrarResultados();
  } catch (err) {
    console.error(err);
    estado(err.message || String(err), true);
  } finally {
    actualizarBotonAnalizar();
  }
};

function limpiarResultados() {
  detenerLluvia();
  E.g = null; E.an = null;
  for (const id of ["paso-resultados", "paso-exportar"]) $(id).hidden = true;
  if (mapa.getLayer("capa")) mapa.setLayoutProperty("capa", "visibility", "none");
  mapa.getSource("curvas")?.setData(vacio);
  if ($("t-3d").checked) { $("t-3d").checked = false; alternar3D(false); }
}

function tarjeta(valor, texto, clase = "") {
  return `<div class="tarjeta ${clase}"><b>${valor}</b><span>${texto}</span></div>`;
}

function mostrarResultados() {
  const st = E.an.stats;
  $("tarjetas").innerHTML =
    tarjeta(ha(st.area), "superficie analizada") +
    tarjeta(`${fmt(st.pendMedia, 1)} %`, "pendiente media") +
    tarjeta(`${fmt(st.zmin)}–${fmt(st.zmax)} m`, "cota mínima–máxima") +
    tarjeta(`${fmt(st.zmax - st.zmin, 1)} m`, "desnivel") +
    tarjeta(st.encArea ? ha(st.encArea) : "—", st.encArea ? `se encharca · ${m3(st.encVol)}` : "sin depresiones relevantes") +
    tarjeta(ha(st.accMax), "cuenca máx. que cruza el terreno");
  for (const id of ["paso-resultados", "paso-exportar"]) $(id).hidden = false;
  $("aviso-dsm").hidden = !E.g.esDSM;
  // curvas de nivel
  const eq = Math.max(equidistancia(st.zmax - st.zmin), E.g.dx >= 10 ? 1 : 0.25);
  E.eq = eq;
  $("eq-txt").textContent = `(cada ${fmt(eq, eq < 1 ? 2 : 0)} m)`;
  actualizarCurvas();
  pintarCapa();
}

function actualizarCurvas() {
  if (!E.an) return;
  mapa.getSource("curvas").setData($("t-curvas").checked ? curvas(E.g, E.an.mask, E.eq) : vacio);
}

// umbral de cauces: escala logarítmica de 0,05 ha a 500 ha
const umbral = () => Math.pow(10, Math.log10(500) + ($("umbral").value / 100) * (Math.log10(5e6) - Math.log10(500)));
function textoUmbral() { $("umbral-txt").textContent = ha(umbral()); }
textoUmbral();

function pintarCapa() {
  if (!E.an) return;
  const capa = E.capa;
  $("control-umbral").hidden = capa !== "escurrimiento";
  if (capa === "ninguna") {
    if (mapa.getLayer("capa")) mapa.setLayoutProperty("capa", "visibility", "none");
    $("leyenda").innerHTML = "";
    return;
  }
  const op = { umbralCauce: umbral() };
  const url = pintar(capa, E.g, E.an, op).toDataURL("image/png");
  const coordinates = esquinas(E.g);
  const src = mapa.getSource("capa");
  if (src) src.updateImage({ url, coordinates });
  else {
    mapa.addSource("capa", { type: "image", url, coordinates });
    mapa.addLayer({ id: "capa", type: "raster", source: "capa", paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, "curvas");
  }
  mapa.setLayoutProperty("capa", "visibility", "visible");
  $("leyenda").innerHTML = leyenda(capa, E.an, op);
}

function elegirCapa(capa) {
  E.capa = capa;
  document.querySelectorAll(".capas button").forEach((b) => b.classList.toggle("activa", b.dataset.capa === capa));
  pintarCapa();
}
document.querySelectorAll(".capas button").forEach((b) => (b.onclick = () => elegirCapa(b.dataset.capa)));
$("umbral").oninput = () => { textoUmbral(); clearTimeout(E.tUmbral); E.tUmbral = setTimeout(pintarCapa, 60); };
$("t-curvas").onchange = actualizarCurvas;

// ---------- 3D ----------
function centroTerreno() {
  if (E.anillo) {
    const v = E.anillo.slice(0, -1);
    return [v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length];
  }
  if (E.g) { const c = esquinas(E.g); return [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]; }
  return mapa.getCenter().toArray();
}

function alternar3D(on) {
  detenerOrbita();
  $("ctl3d").hidden = !on;
  if (on) {
    mapa.setTerrain({ source: "dem", exaggeration: Number($("exagerar").value) });
    mapa.easeTo({ center: centroTerreno(), pitch: 62, duration: 900 });
  } else {
    mapa.setTerrain(null);
    mapa.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }
}
$("t-3d").onchange = (e) => alternar3D(e.target.checked);

// girar / inclinar / ver desde un punto cardinal (alrededor del centro de la pantalla)
document.querySelectorAll("[data-girar]").forEach((b) => (b.onclick = () => {
  detenerOrbita();
  mapa.easeTo({ bearing: mapa.getBearing() + Number(b.dataset.girar), duration: 600 });
}));
document.querySelectorAll("[data-inclinar]").forEach((b) => (b.onclick = () => {
  detenerOrbita();
  mapa.easeTo({ pitch: Math.max(0, Math.min(80, mapa.getPitch() + Number(b.dataset.inclinar))), duration: 500 });
}));
// "desde el sur" = la cámara está al sur mirando al norte (rumbo 0)
document.querySelectorAll("[data-desde]").forEach((b) => (b.onclick = () => {
  detenerOrbita();
  mapa.easeTo({ center: centroTerreno(), bearing: Number(b.dataset.desde), pitch: Math.max(mapa.getPitch(), 55), duration: 900 });
}));
$("centrar3d").onclick = () => {
  detenerOrbita();
  const c = E.anillo || (E.g && [...esquinas(E.g)]);
  if (!c) return;
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  mapa.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 80, pitch: mapa.getPitch(), bearing: mapa.getBearing(), duration: 900 });
};
$("exagerar").oninput = (e) => {
  $("exagerar-txt").textContent = fmt(e.target.value, 1);
  if ($("t-3d").checked) mapa.setTerrain({ source: "dem", exaggeration: Number(e.target.value) });
};

// dar la vuelta alrededor del terreno; se detiene si el usuario toca el mapa
const orbita = { raf: 0 };
function detenerOrbita() {
  cancelAnimationFrame(orbita.raf);
  orbita.raf = 0;
  $("orbitar").classList.remove("activo");
  $("orbitar").textContent = "▶ Dar la vuelta";
}
$("orbitar").onclick = () => {
  if (orbita.raf) return detenerOrbita();
  $("orbitar").classList.add("activo");
  $("orbitar").textContent = "■ Detener";
  mapa.jumpTo({ center: centroTerreno() });
  let t0 = performance.now();
  const paso = (t) => {
    mapa.setBearing((mapa.getBearing() + (t - t0) * 0.012) % 360);
    t0 = t;
    orbita.raf = requestAnimationFrame(paso);
  };
  orbita.raf = requestAnimationFrame(paso);
};
for (const ev of ["mousedown", "touchstart", "wheel"]) mapa.getCanvasContainer().addEventListener(ev, () => orbita.raf && detenerOrbita(), { passive: true });

// ---------- simulación de lluvia (partículas que siguen el flujo D8) ----------
const VX = [1, 1, 0, -1, -1, -1, 0, 1], VY = [0, 1, 1, 1, 0, -1, -1, -1];
const lluvia = { raf: 0, gotas: [], celdas: null, aLL: null, cuadro: 0 };

function nuevaGota(g) {
  g.i = lluvia.celdas[(Math.random() * lluvia.celdas.length) | 0];
  g.t = Math.random();
  g.vida = 0;
  g.max = 160 + Math.random() * 260;
  return g;
}
function iniciarLluvia() {
  const { mask } = E.an;
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  lluvia.celdas = Int32Array.from(idx);
  lluvia.aLL = afin(E.g);
  const n = Math.min(2500, Math.max(400, Math.round(idx.length / 3)));
  lluvia.gotas = Array.from({ length: n }, () => nuevaGota({}));
  lluvia.activa = true;
  const paso = () => {
    if (!lluvia.activa) return;
    const { dir, pendiente: pe, prof } = E.an;
    const w = E.g.w, h = E.g.h;
    const f = [];
    for (const g of lluvia.gotas) {
      const k = dir[g.i];
      if (k < 0 || ++g.vida > g.max) { nuevaGota(g); continue; }
      const enPozo = prof[g.i] >= 0.05;
      g.t += enPozo ? 0.025 : 0.06 + 0.3 * Math.min(1, pe[g.i] / 15);
      while (g.t >= 1) {
        g.t -= 1;
        const r = (g.i / w) | 0, c = g.i - r * w;
        const rr = r + VY[dir[g.i]], cc = c + VX[dir[g.i]];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) { nuevaGota(g); break; }
        g.i = rr * w + cc;
        if (dir[g.i] < 0) { nuevaGota(g); break; }
      }
      const r = (g.i / w) | 0, c = g.i - r * w, kk = dir[g.i];
      if (kk < 0) continue;
      const pos = lluvia.aLL(c + 0.5 + VX[kk] * g.t, r + 0.5 + VY[kk] * g.t);
      const o = Math.min(1, g.vida / 20, (g.max - g.vida) / 30) * 0.9;
      f.push({ type: "Feature", properties: { o }, geometry: { type: "Point", coordinates: pos } });
    }
    if (lluvia.cuadro++ % 2 === 0) mapa.getSource("gotas").setData({ type: "FeatureCollection", features: f });
    lluvia.raf = requestAnimationFrame(paso);
  };
  lluvia.raf = requestAnimationFrame(paso);
}
function detenerLluvia() {
  cancelAnimationFrame(lluvia.raf);
  lluvia.raf = 0;
  lluvia.activa = false;
  const limpiar = () => mapa.getSource("gotas")?.setData(vacio);
  limpiar();
  setTimeout(limpiar, 120); // por si quedó una actualización en vuelo
  $("t-lluvia").checked = false;
}
$("t-lluvia").onchange = (e) => {
  const encender = e.target.checked && !!E.an; // leer ANTES de detener (detenerLluvia desmarca la casilla)
  detenerLluvia();
  if (encender) { e.target.checked = true; iniciarLluvia(); }
};

// ---------- exportar ----------
function descargar(nombre, datos, tipo) {
  const url = URL.createObjectURL(datos instanceof Blob ? datos : new Blob([datos], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function contorno() {
  if (E.anillo) return E.anillo;
  const c = esquinas(E.g);
  return [...c, c[0]];
}

$("b-geojson").onclick = () => {
  const st = E.an.stats;
  const props = { fuente: E.g.fuente, area_ha: +(st.area / 1e4).toFixed(3), cota_min: +st.zmin.toFixed(2), cota_max: +st.zmax.toFixed(2),
    pendiente_media_pct: +st.pendMedia.toFixed(2), encharcamiento_ha: +(st.encArea / 1e4).toFixed(3), encharcamiento_m3: Math.round(st.encVol) };
  const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [contorno()] } }] };
  descargar("cota_terreno.geojson", JSON.stringify(fc, null, 1), "application/geo+json");
};

$("b-tif").onclick = async () => {
  const fuentes = { elevacion: [E.g.z, "elevacion_m"], pendiente: [E.an.pendiente, "pendiente_pct"], encharcamiento: [E.an.prof, "encharcamiento_m"],
    escurrimiento: [E.an.acc, "area_aportante_m2"], ninguna: [E.g.z, "elevacion_m"] };
  const [arr, nombre] = fuentes[E.capa];
  const { w, h } = E.g;
  const { crs, x0, y0, rx, ry } = E.g.georef;
  const vals = new Float32Array(w * h);
  for (let i = 0; i < vals.length; i++) vals[i] = E.an.mask[i] && !Number.isNaN(arr[i]) ? arr[i] : -9999;
  const epsg = Number(crs.split(":")[1]);
  try {
    const buf = geotiffFloat32(vals, w, h, { epsg, x0, y0, rx, ry });
    descargar(`cota_${nombre}.tif`, new Blob([buf], { type: "image/tiff" }));
  } catch (err) {
    console.error(err);
    estado("No pude generar el GeoTIFF: " + err.message, true);
  }
};

$("b-informe").onclick = () => {
  const st = E.an.stats, g = E.g;
  const [lon, lat] = mapa.getCenter().toArray();
  const img = mapa.getCanvas().toDataURL("image/jpeg", 0.9);
  const fila = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
  $("informe").innerHTML = `
    <h1>Informe de terreno</h1>
    <p class="meta">Generado con Cota el ${new Date().toLocaleDateString("es-CL", { dateStyle: "long" })} · centro aprox. ${fmt(lat, 5)}, ${fmt(lon, 5)} · fuente: ${g.fuente} · celda ${fmt(g.dx, 1)} × ${fmt(g.dy, 1)} m</p>
    <img src="${img}" alt="Mapa del terreno" />
    <h2>Terreno</h2>
    <table>${fila("Superficie", ha(st.area))}${fila("Cota mínima / máxima", `${fmt(st.zmin, 1)} / ${fmt(st.zmax, 1)} m s.n.m.`)}${fila("Desnivel", `${fmt(st.zmax - st.zmin, 1)} m`)}${fila("Pendiente media", `${fmt(st.pendMedia, 1)} %`)}</table>
    <h2>Pendientes</h2>
    <table>${CLASES_PEND.map((k, i) => fila(k.txt, `${fmt(100 * st.clases[i], 1)} % · ${ha(st.clases[i] * st.area)}`)).join("")}</table>
    <h2>Agua</h2>
    <table>${fila("Zonas que se encharcan (≥ 5 cm)", st.encArea ? ha(st.encArea) : "no se detectan")}${fila("Volumen que pueden retener", m3(st.encVol))}${fila("Profundidad máxima", `${fmt(st.encMax, 2)} m`)}${fila("Mayor cuenca que cruza el terreno", ha(st.accMax))}</table>
    <p class="nota">${g.esDSM ? "Copernicus GLO-30 es un modelo digital de superficie de ~30 m: incluye vegetación y construcciones y no capta detalles menores a la celda. " : ""}Resultado referencial de prediagnóstico; no reemplaza un levantamiento topográfico ni un estudio hidrológico.</p>`;
  window.print();
};

// ---------- panel plegable (celular) ----------
$("plegar").onclick = () => $("panel").classList.toggle("plegado");
