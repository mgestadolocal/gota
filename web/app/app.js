/* global maplibregl */
import { geotiffFloat32 } from "./geotiff_escribir.js";
import { crearCapaLluvia } from "./lluvia_gl.js";
import { redCauces } from "./cauces.js";
import { registrarProtocolo, publicarCapa } from "./capa_teselas.js";
import { laminasDeAgua } from "./agua.js";
import { informeHTML } from "./informe.js";

registrarProtocolo();
import { cargarCopernicus, cargarArchivo, mascara, esquinas, afin, areaAnillo } from "./dem.js";
import { pintar, sombreado, curvas, equidistancia, leyenda, CLASES_PEND } from "./render.js";
import { cargarCobertura } from "./cobertura.js";
import { lluviasDiseno, ajusteIDF, numerosCurva, SUELOS } from "./lluvia.js";

const params = new URLSearchParams(location.search);
const API = (params.get("api") || window.GOTA_API || location.origin).replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

// ---------- sesión (cuentas por invitación) ----------
// Sin ?demo= hace falta haber ingresado; si no, se envía a la pantalla de acceso.
const TOKEN = (() => { try { return localStorage.getItem("gotyx-sesion"); } catch { return null; } })();
const MODO_DEMO = ["macul", "aculeo"].includes(params.get("demo"));
if (TOKEN) window.__gotyxAuth = { Authorization: `Bearer ${TOKEN}` };
if (!MODO_DEMO && !TOKEN) location.replace("../ingresar.html");
async function salir() {
  try { await fetch(`${API}/auth/logout`, { method: "POST", headers: window.__gotyxAuth || {} }); } catch {}
  try { localStorage.removeItem("gotyx-sesion"); } catch {}
  location.href = "../ingresar.html";
}
if (TOKEN && !MODO_DEMO) {
  fetch(`${API}/auth/yo`, { headers: window.__gotyxAuth }).then(async (r) => {
    if (r.status === 401) { try { localStorage.removeItem("gotyx-sesion"); } catch {} location.replace("../ingresar.html"); return; }
    if (!r.ok) return;
    const u = await r.json();
    const chip = document.createElement("div");
    chip.className = "usuario";
    chip.innerHTML = `<span title="${u.correo}">${(u.nombre || u.correo).replace(/[<>&]/g, "")}${u.empresa ? ` · ${u.empresa.replace(/[<>&]/g, "")}` : ""}</span><button type="button">Salir</button>`;
    chip.querySelector("button").onclick = salir;
    document.querySelector("#panel .riel").after(chip);
  }).catch(() => {});
}
const fmt = (v, d = 0) => Number(v).toLocaleString("es-CL", { maximumFractionDigits: d, minimumFractionDigits: d });
const ha = (m2) => (m2 >= 100000 ? fmt(m2 / 10000, 0) : fmt(m2 / 10000, m2 >= 10000 ? 1 : 2)) + " ha";
const m3 = (v) => fmt(Math.round(v)) + " m³";

const E = {
  anillo: null, vertices: [], cursor: null, dibujando: false,
  archivo: null, g: null, an: null, capa: "escurrimiento", T: 10, lluvias: null,
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
        // ojo: tileSize 512 recorta las capas de imagen (pendiente, cobertura…) sobre el relieve 3D; se mantiene 256
        type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      },
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
  },
  center: [-71.05, -34.45],
  zoom: 9,
  maxPitch: 75,
  // sin preserveDrawingBuffer (es caro en GPUs integradas); el informe captura el mapa justo al dibujarse
  pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
  attributionControl: { compact: true },
});
mapa.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
mapa.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

const vacio = { type: "FeatureCollection", features: [] };
const lluviaGL = crearCapaLluvia(mapa);
window.__gotyxMapa = mapa;
window.__gotyxLluvia = lluviaGL; // para ajustes de presentación (tamaño y brillo de las gotas)
mapa.on("load", () => {
  mapa.addSource("curvas", { type: "geojson", data: vacio });
  mapa.addSource("poligono", { type: "geojson", data: vacio });
  mapa.addSource("cauces", { type: "geojson", data: vacio, tolerance: 0.2 });
  mapa.addSource("agua", { type: "geojson", data: vacio, tolerance: 0.15 });
  mapa.addLayer({ id: "curvas", type: "line", source: "curvas",
    paint: { "line-color": "#ffffff", "line-opacity": ["case", ["get", "maestra"], 0.75, 0.38], "line-width": ["case", ["get", "maestra"], 1.4, 0.7] } });
  // agua acumulada: láminas vectoriales por profundidad (agua.js)
  mapa.addLayer({ id: "agua", type: "fill", source: "agua",
    paint: { "fill-color": ["match", ["get", "nivel"], 0, "#8fd3ff", 1, "#4aa8ff", 2, "#1f78d1", "#0b4fa3"], "fill-opacity": 0.82, "fill-antialias": true } }, "curvas");
  mapa.addLayer({ id: "agua-borde", type: "line", source: "agua", filter: ["==", ["get", "nivel"], 0],
    paint: { "line-color": "#e6f7ff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 15, 1.4], "line-opacity": 0.7 } }, "curvas");
  // cauces: brillo ancho + núcleo; grosor y color según el caudal (o área aportante) normalizado "t" (0..1)
  const ancho = (k) => ["interpolate", ["linear"], ["zoom"], 10, ["*", k * 0.6, ["+", 0.6, ["*", 2.6, ["get", "t"]]]], 15, ["*", k * 2.2, ["+", 0.6, ["*", 2.6, ["get", "t"]]]]];
  mapa.addLayer({ id: "cauces-brillo", type: "line", source: "cauces", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#5cc8ff", "line-blur": 3, "line-width": ancho(2.6), "line-opacity": ["*", ["case", ["==", ["get", "dentro"], 1], 0.35, 0.12], ["+", 0.3, ["get", "t"]]] } }, "curvas");
  mapa.addLayer({ id: "cauces", type: "line", source: "cauces", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["interpolate", ["linear"], ["get", "t"], 0, "#a8e4ff", 0.5, "#3aa0f0", 1, "#0d5fc4"],
      "line-width": ancho(1), "line-opacity": ["case", ["==", ["get", "dentro"], 1], 0.95, 0.35] } }, "curvas");
  mapa.addLayer({ id: "pol-relleno", type: "fill", source: "poligono", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#ffd166", "fill-opacity": 0.08 } });
  mapa.addLayer({ id: "pol-linea", type: "line", source: "poligono", filter: ["!=", "$type", "Point"], paint: { "line-color": "#ffd166", "line-width": 2.4 } });
  // gotas: capa WebGL propia (ver lluvia_gl.js)
  mapa.addLayer(lluviaGL.capa);
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
  $("b-dibujar").querySelector("span").textContent = "Cancelar dibujo";
  $("b-dibujar").classList.add("activo");
  $("ayuda-dibujo").hidden = false;
  actualizarRiel();
  $("info-poligono").hidden = true;
  actualizarBotonAnalizar();
  dibujarPoligono();
}

function terminarDibujo(cerrar) {
  E.dibujando = false;
  mapa.getCanvas().style.cursor = "";
  setTimeout(() => mapa.doubleClickZoom.enable(), 300);
  $("b-dibujar").querySelector("span").textContent = "Dibujar polígono";
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
  actualizarRiel();
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

// ---------- búsqueda con autocompletado (Photon / OpenStreetMap; Nominatim de respaldo) ----------
const BUSQ = { items: [], sel: -1, t: 0, n: 0 };
const CAJA_CHILE = "-76.5,-56.5,-66,-17";
const TIPOS = { city: "Ciudad", town: "Ciudad", village: "Pueblo", hamlet: "Localidad", locality: "Localidad", isolated_dwelling: "Localidad",
  suburb: "Barrio", neighbourhood: "Barrio", quarter: "Barrio", residential: "Calle", primary: "Calle", secondary: "Calle", tertiary: "Calle",
  street: "Calle", house: "Dirección", county: "Provincia", state: "Región", district: "Comuna", administrative: "Comuna", peak: "Cerro",
  volcano: "Volcán", water: "Agua", lake: "Lago", river: "Río", stream: "Estero", beach: "Playa", bay: "Bahía", island: "Isla", valley: "Valle",
  farm: "Predio", farmland: "Predio", park: "Parque", national_park: "Parque", nature_reserve: "Reserva" };
const ZOOM_TIPO = { house: 17, street: 15.5, residential: 15.5, village: 14, hamlet: 14.5, locality: 14, suburb: 14, neighbourhood: 15, city: 12, town: 13, peak: 13.5 };
const sinTildes = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const escH = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function resaltar(txt, q) {
  const i = sinTildes(txt).indexOf(sinTildes(q.trim()));
  if (i < 0 || !q.trim()) return escH(txt);
  const n = q.trim().length;
  return escH(txt.slice(0, i)) + "<mark>" + escH(txt.slice(i, i + n)) + "</mark>" + escH(txt.slice(i + n));
}
function margenMapa() {
  const p = $("panel").getBoundingClientRect();
  return innerWidth > 720 ? { left: p.right + 40, right: 60, top: 70, bottom: 50 } : { left: 30, right: 30, top: 70, bottom: innerHeight - p.top + 30 };
}
function itemPhoton(f) {
  const p = f.properties;
  const nombre = p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.name || p.street || "";
  const corto = (x) => x && x.replace(/^Provincia de(l)? /, "").replace(/^Región (de |del )?/, "").replace("Libertador General Bernardo O'Higgins", "O'Higgins")
    .replace(/^Metropolitana de Santiago$/, "Región Metropolitana").replace(/^Aysén del General Carlos Ibáñez del Campo$/, "Aysén");
  const ctx = [p.street && !p.housenumber && p.name !== p.street ? p.street : null, p.district, p.city, corto(p.county), corto(p.state)]
    .filter((x, i, a) => x && x !== nombre && a.indexOf(x) === i).slice(0, 3).join(", ");
  const tipo = TIPOS[p.osm_value] || TIPOS[p.type] || "";
  return { nombre, ctx, tipo, centro: f.geometry.coordinates, extent: p.extent, zoom: ZOOM_TIPO[p.osm_value] || ZOOM_TIPO[p.type] || 13 };
}
function coordenadas(q) {
  const m = q.match(/^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1].replace(",", ".")), lon = Number(m[2].replace(",", "."));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { nombre: `${fmt(lat, 5)}°, ${fmt(lon, 5)}°`, ctx: "Ir a estas coordenadas", tipo: "Punto", centro: [lon, lat], zoom: 15 };
}
function pintarSugerencias(q, vacia = "") {
  const ul = $("sugerencias");
  if (!BUSQ.items.length && !vacia) { cerrarSugerencias(); return; }
  ul.innerHTML = BUSQ.items.length
    ? BUSQ.items.map((it, i) => `<li role="option" id="sug-${i}" data-i="${i}" class="${i === BUSQ.sel ? "on" : ""}" aria-selected="${i === BUSQ.sel}">
        <svg aria-hidden="true"><use href="#i-pin" /></svg><div><b>${resaltar(it.nombre, q)}</b>${it.ctx ? `<small>${escH(it.ctx)}</small>` : ""}</div>${it.tipo ? `<em>${escH(it.tipo)}</em>` : ""}</li>`).join("")
    : `<li class="vacia">${escH(vacia)}</li>`;
  ul.hidden = false;
  $("q").setAttribute("aria-expanded", "true");
  $("q").setAttribute("aria-activedescendant", BUSQ.sel >= 0 ? `sug-${BUSQ.sel}` : "");
}
function cerrarSugerencias() {
  $("sugerencias").hidden = true;
  $("q").setAttribute("aria-expanded", "false");
  BUSQ.sel = -1;
}
async function sugerir(q) {
  const n = ++BUSQ.n;
  const c = coordenadas(q);
  if (c) { BUSQ.items = [c]; BUSQ.sel = 0; pintarSugerencias(q); return; }
  if (q.trim().length < 2) { BUSQ.items = []; cerrarSugerencias(); return; }
  $("buscar").classList.add("cargando");
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=15&bbox=${CAJA_CHILE}`);
    const d = await r.json();
    if (n !== BUSQ.n) return; // llegó una respuesta más nueva
    const vistos = new Set();
    BUSQ.items = d.features.filter((f) => f.properties.countrycode === "CL").map(itemPhoton)
      .filter((it) => { const k = it.nombre + "|" + it.ctx; if (!it.nombre || vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 7);
    BUSQ.sel = BUSQ.items.length ? 0 : -1;
    pintarSugerencias(q, "Sin resultados. Prueba con la comuna o una calle cercana.");
  } catch {
    if (n === BUSQ.n) { BUSQ.items = []; pintarSugerencias(q, "No pude buscar. Revisa tu conexión."); }
  } finally {
    if (n === BUSQ.n) $("buscar").classList.remove("cargando");
  }
}
function irA(it) {
  cerrarSugerencias();
  $("q").value = it.nombre;
  $("q").blur();
  estado("");
  if (it.extent) {
    const [o, n, e_, s_] = it.extent;
    mapa.fitBounds([[o, s_], [e_, n]], { padding: margenMapa(), maxZoom: 16, duration: 1600, essential: true });
  } else {
    const m = margenMapa();
    mapa.flyTo({ center: it.centro, zoom: it.zoom, offset: [(m.left - m.right) / 2, (m.top - m.bottom) / 2], duration: 1600, essential: true });
  }
}
$("q").addEventListener("input", () => {
  clearTimeout(BUSQ.t);
  const q = $("q").value;
  BUSQ.t = setTimeout(() => sugerir(q), 200);
});
$("q").addEventListener("keydown", (e) => {
  const abierto = !$("sugerencias").hidden && BUSQ.items.length;
  if (e.key === "ArrowDown" && abierto) { e.preventDefault(); BUSQ.sel = (BUSQ.sel + 1) % BUSQ.items.length; pintarSugerencias($("q").value); }
  else if (e.key === "ArrowUp" && abierto) { e.preventDefault(); BUSQ.sel = (BUSQ.sel - 1 + BUSQ.items.length) % BUSQ.items.length; pintarSugerencias($("q").value); }
  else if (e.key === "Escape") cerrarSugerencias();
});
$("q").addEventListener("focus", () => { if (BUSQ.items.length && $("q").value.trim()) pintarSugerencias($("q").value); });
$("q").addEventListener("blur", () => setTimeout(cerrarSugerencias, 150));
$("sugerencias").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault();
  irA(BUSQ.items[Number(li.dataset.i)]);
});
$("buscar").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  clearTimeout(BUSQ.t);
  if (BUSQ.items.length && !$("sugerencias").hidden) return irA(BUSQ.items[Math.max(0, BUSQ.sel)]);
  const c = coordenadas(q);
  if (c) return irA(c);
  // respaldo: Nominatim (direcciones con número que Photon no tiene)
  $("buscar").classList.add("cargando");
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cl&q=${encodeURIComponent(q)}`);
    const [res] = await r.json();
    if (!res) return estado("No encontré ese lugar.", true);
    const [s_, n, o, e_] = res.boundingbox.map(Number);
    irA({ nombre: q, extent: [o, n, e_, s_] });
  } catch { estado("No pude buscar el lugar.", true); }
  finally { $("buscar").classList.remove("cargando"); }
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
    E.an = { ...r, mask, sombra: sombreado(g), borde: difuminado(mask, g.w, g.h) };
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
  for (const id of ["paso-resultados", "paso-tormenta", "paso-exportar"]) $(id).hidden = true;
  $("res-tormenta").hidden = true;
  document.querySelector('[data-capa="cobertura"]').disabled = true;
  if (E.capa === "cobertura") E.capa = "escurrimiento";
  marcaQ.remove();
  if (mapa.getLayer("capa")) mapa.setLayoutProperty("capa", "visibility", "none");
  mapa.getSource("curvas")?.setData(vacio);
  mapa.getSource("cauces")?.setData(vacio);
  mapa.getSource("agua")?.setData(vacio);
  if ($("t-3d").checked) { $("t-3d").checked = false; alternar3D(false); }
  actualizarRiel();
}

// riel de progreso bajo el logo
function actualizarRiel() {
  const listo = { "paso-terreno": true, "paso-resultados": !!E.an, "paso-tormenta": !!E.an?.tormenta, "paso-exportar": !!E.an?.tormenta };
  document.querySelectorAll(".riel li").forEach((li) => li.classList.toggle("on", listo[li.dataset.r]));
  $("guia").hidden = !!(E.an || E.anillo || E.dibujando || MODO_DEMO);
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
  for (const id of ["paso-resultados", "paso-tormenta", "paso-exportar"]) $(id).hidden = false;
  $("res-tormenta").hidden = true;
  marcaQ.remove();
  document.querySelector('[data-capa="cobertura"]').disabled = true;
  if (E.capa === "cobertura") elegirCapa("escurrimiento");
  cargarLluvias();
  actualizarRiel();
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
  const op = { umbralCauce: umbral(), retorno: E.T };
  actualizarCauces(capa === "escurrimiento");
  const agua = capa === "escurrimiento" || capa === "encharcamiento";
  actualizarAgua(agua, capa === "encharcamiento");
  if (agua) {
    if (mapa.getLayer("capa")) mapa.setLayoutProperty("capa", "visibility", "none");
  } else {
    publicarCapa(mapa, pintar(capa, E.g, E.an, op), E.g, "agua");
    mapa.setLayoutProperty("capa", "visibility", "visible");
  }
  $("leyenda").innerHTML = leyenda(capa, E.an, op);
}

// agua acumulada: con tormenta, las pozas que se forman; sin tormenta, las depresiones llenas
function actualizarAgua(mostrar, porProfundidad) {
  const src = mapa.getSource("agua");
  if (!src) return;
  if (!mostrar || !E.an) { src.setData(vacio); return; }
  const prof = E.an.tormenta ? E.an.tormenta.profT : E.an.prof;
  src.setData(laminasDeAgua(E.g, prof, E.an.mask));
  // en "escurrimiento" el agua quieta va en un solo tono suave, para no competir con los cauces
  mapa.setPaintProperty("agua", "fill-color", porProfundidad
    ? ["match", ["get", "nivel"], 0, "#8fd3ff", 1, "#4aa8ff", 2, "#1f78d1", "#0b4fa3"] : "#6cc4ff");
  mapa.setPaintProperty("agua", "fill-opacity", porProfundidad ? 0.82 : 0.6);
}

// difuminado del borde: 1 dentro del polígono, y fuera baja suavemente a 0 (sin cortes duros)
function difuminado(mask, w, h) {
  const n = w * h, INF = 1e9, d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = mask[i] ? 0 : INF;
  const D = 1, DD = Math.SQRT2;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c; let v = d[i];
    if (c > 0) v = Math.min(v, d[i - 1] + D);
    if (r > 0) { v = Math.min(v, d[i - w] + D); if (c > 0) v = Math.min(v, d[i - w - 1] + DD); if (c < w - 1) v = Math.min(v, d[i - w + 1] + DD); }
    d[i] = v;
  }
  for (let r = h - 1; r >= 0; r--) for (let c = w - 1; c >= 0; c--) {
    const i = r * w + c; let v = d[i];
    if (c < w - 1) v = Math.min(v, d[i + 1] + D);
    if (r < h - 1) { v = Math.min(v, d[i + w] + D); if (c < w - 1) v = Math.min(v, d[i + w + 1] + DD); if (c > 0) v = Math.min(v, d[i + w - 1] + DD); }
    d[i] = v;
  }
  const F = Math.max(6, Math.min(30, Math.round(Math.min(w, h) * 0.06)));
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (d[i] === 0) { k[i] = 1; continue; }
    const t = Math.min(1, d[i] / F);
    k[i] = 0.55 * (1 - t) * (1 - t) * (1 + 2 * t); // suave (curva de Hermite) desde 0,55 en el borde
  }
  return k;
}

// red de cauces vectorial (escurrimiento): caudal de la tormenta si existe, si no área aportante
function actualizarCauces(mostrar) {
  const src = mapa.getSource("cauces");
  if (!src) return;
  if (!mostrar || !E.an) { src.setData(vacio); return; }
  const T = E.an.tormenta;
  const valor = T ? T.qp : E.an.acc;
  // depresiones rellenadas (incluye llanos y lagunas): ahí el flujo D8 no es un cauce real
  const fc = redCauces(E.g, E.an, umbral(), valor, E.an.prof);
  // normalización logarítmica a 0..1 para grosor y color
  let vmin = Infinity, vmax = 0;
  for (const f of fc.features) { const v = f.properties.v; if (v > 0) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } }
  const l0 = Math.log10(Math.max(vmin, T ? 0.005 : 1)), l1 = Math.log10(Math.max(vmax, 1e-9));
  for (const f of fc.features) f.properties.t = Math.max(0, Math.min(1, (Math.log10(Math.max(f.properties.v, 1e-9)) - l0) / (l1 - l0 || 1)));
  src.setData(fc);
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
    mapa.easeTo({ center: centroTerreno(), pitch: 55, duration: 1600, easing: (t) => t * t * (3 - 2 * t) });
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

// ---------- simulación de lluvia (partículas que siguen el flujo D8, dibujadas en WebGL) ----------
const enPoza = (i) => (E.an.tormenta ? E.an.tormenta.profT : E.an.prof)[i] >= 0.05;
const lluvia = { activa: false };

function iniciarLluvia() {
  const { mask } = E.an;
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  const celdas = Int32Array.from(idx);
  // con tormenta: más gotas y más rápidas cuanto más escurre; nacen más donde se genera escorrentía
  const T = E.an.tormenta;
  const escMedia = T ? (T.stats.genera / (idx.length * E.g.dx * E.g.dy)) * 1000 : 0; // mm
  let escMax = 1;
  if (T) {
    // referencia = percentil 90 fuera de pozas (las lagunas escurren ~100 % y aplastarían al resto)
    const v = Array.from(celdas).filter((i) => !enPoza(i)).map((i) => T.escurre[i]).sort((x, y) => x - y);
    escMax = Math.max(1, v[Math.floor(v.length * 0.9)] || 1);
  }
  const cantidad = T
    ? Math.min(5000, Math.max(800, Math.round((idx.length / 3) * Math.min(3, escMedia / 15))))
    : Math.min(3500, Math.max(800, Math.round(idx.length / 3)));
  lluviaGL.iniciar({ E, afin: afin(E.g), enPoza, celdas, esc: T ? T.escurre : null, escMax,
    veloc: T ? 1 + 0.6 * Math.min(1, escMedia / 40) : 1, cantidad });
  lluvia.activa = true;
}
function detenerLluvia() {
  lluviaGL.detener();
  lluvia.activa = false;
  $("t-lluvia").checked = false;
}
$("t-lluvia").onchange = (e) => {
  const encender = e.target.checked && !!E.an; // leer ANTES de detener (detenerLluvia desmarca la casilla)
  detenerLluvia();
  if (encender) { e.target.checked = true; iniciarLluvia(); }
};

// ---------- tormenta de diseño ----------
const etiquetaQ = Object.assign(document.createElement("span"), { className: "marca-q" });
const contenedorQ = document.createElement("div");
contenedorQ.append(etiquetaQ);
const marcaQ = new maplibregl.Marker({ element: contenedorQ, anchor: "bottom", offset: [0, -4] });

async function cargarLluvias() {
  E.lluvias = null;
  $("idf").innerHTML = "Buscando lluvias extremas para este lugar…";
  const [lon, lat] = centroTerreno();
  try {
    E.lluvias = await lluviasDiseno(lon, lat);
  } catch (err) { console.error(err); }
  mostrarIDF();
}

function mostrarIDF() {
  document.querySelectorAll(".retornos button").forEach((b) => b.classList.toggle("activa", Number(b.dataset.t) === E.T));
  $("b-tormenta").disabled = !E.lluvias;
  if (!E.lluvias) { $("idf").innerHTML = "No hay datos de lluvias extremas para este lugar."; return; }
  const fila = E.lluvias.P[E.T];
  const { a } = ajusteIDF(fila);
  const mm = (v) => `${fmt(v, v < 10 ? 1 : 0)} mm`;
  const filas = [["1 hora", a, true], ["6 horas", fila[1]], ["24 horas", fila[3]], ["3 días", fila[5]]];
  const max = Math.max(...filas.map((f) => f[1]));
  $("idf").innerHTML = `<div class="idf-tit"><b>Lluvia de ${E.T} años aquí</b><span>GPEX${E.lluvias.distanciaKm > 3 ? ` · ${fmt(E.lluvias.distanciaKm)} km` : ""}</span></div>` +
    filas.map(([n, v, est]) => `<div class="idf-fila"><span>${n}${est ? " <small>est.</small>" : ""}</span><i><u style="width:${((100 * v) / max).toFixed(1)}%"></u></i><b>${mm(v)}</b></div>`).join("");
}

document.querySelectorAll(".retornos button").forEach((b) => (b.onclick = () => {
  E.T = Number(b.dataset.t);
  mostrarIDF();
  if (E.an && E.an.tormenta) simularTormenta();
}));
$("suelo").onchange = () => { $("suelo-txt").textContent = SUELOS[$("suelo").value]; if (E.an && E.an.tormenta) simularTormenta(); };
$("suelo-txt").textContent = SUELOS[$("suelo").value];

async function simularTormenta() {
  if (!E.an || !E.lluvias) return;
  $("b-tormenta").disabled = true;
  $("b-tormenta").classList.add("simulando");
  try {
    if (!E.an.clase) {
      try {
        E.an.clase = await cargarCobertura(API, E.g, estado);
      } catch (err) {
        console.error(err);
        E.an.clase = new Uint8Array(E.g.w * E.g.h); // sin cobertura: se asume cultivo
        estado("No pude leer la cobertura de suelo; se asume terreno cultivado.", true);
      }
      document.querySelector('[data-capa="cobertura"]').disabled = false;
    }
    if (!$("estado").classList.contains("error")) estado("Simulando la tormenta…");
    const fila = E.lluvias.P[E.T];
    const cn = numerosCurva(E.an.clase, $("suelo").value);
    const r = await pedir({ tipo: "tormenta", cn, P24: fila[3], idf: ajusteIDF(fila) }, [cn.buffer]);
    E.an.tormenta = { ...r, T: E.T, P24: fila[3], suelo: $("suelo").value };
    if (!$("estado").classList.contains("error")) estado("");
    mostrarTormenta();
    if (!["escurrimiento", "encharcamiento"].includes(E.capa)) elegirCapa("escurrimiento"); else pintarCapa();
    if ($("t-lluvia").checked) { detenerLluvia(); $("t-lluvia").checked = true; iniciarLluvia(); }
  } catch (err) {
    console.error(err);
    estado(err.message || String(err), true);
  } finally {
    $("b-tormenta").disabled = false;
    $("b-tormenta").classList.remove("simulando");
    actualizarRiel();
  }
}
$("b-tormenta").onclick = simularTormenta;

const caudalTxt = (q) => (q >= 1 ? `${fmt(q, 1)} m³/s` : `${fmt(q * 1000)} L/s`);

function mostrarTormenta() {
  const t = E.an.tormenta, s = t.stats;
  // el caudal máximo (tarjeta y etiqueta) se toma en el punto de mayor caudal de un cauce visible (fuera de lagunas y llanos rellenados)
  let iVis = -1, qVis = 0;
  for (let i = 0; i < t.qp.length; i++) {
    if (!E.an.mask[i] || E.an.prof[i] >= 0.01 || !(t.qp[i] > qVis)) continue;
    qVis = t.qp[i]; iVis = i;
  }
  if (iVis < 0) { iVis = s.iMax; qVis = s.qMax; }
  t.qVis = qVis;

  const pct = (v) => `${fmt((100 * v) / s.llueve)} %`;
  $("res-tormenta").innerHTML =
    `<p class="explica">Con una lluvia de <b>${t.T} años</b> (${fmt(t.P24)} mm en 24 h) sobre tu terreno:</p>` +
    tarjeta(m3(s.llueve), "de agua cae en total") +
    tarjeta(m3(s.genera), `escurre por la superficie (${pct(s.genera)})`, "agua") +
    tarjeta(m3(s.infiltra), `se infiltra en el suelo (${pct(s.infiltra)})`) +
    tarjeta(s.aCharcos ? m3(s.enCharcos) : "—", s.aCharcos ? `queda en pozas (${ha(s.aCharcos)})` : "no se forman pozas") +
    tarjeta(m3(s.sale), "sale del terreno") +
    tarjeta(m3(s.entra), "entra desde terrenos vecinos") +
    tarjeta(caudalTxt(qVis), "caudal máximo en el cauce principal (en el peak de la tormenta)", "ancha agua") +
    `<p class="explica">Cobertura del suelo de ESA WorldCover y suelo tipo ${t.suelo} (número de curva medio ${fmt(s.cnMedio)}). Lluvias de GPEX, base satelital de ~10 km${E.lluvias.distanciaKm > 3 ? ` (celda a ${fmt(E.lluvias.distanciaKm)} km)` : ""}: es una estimación, no reemplaza un estudio hidrológico.</p>`;
  $("res-tormenta").hidden = false;
  if (iVis >= 0) {
    const r = (iVis / E.g.w) | 0, c = iVis - r * E.g.w;
    etiquetaQ.textContent = `Caudal máx. ${caudalTxt(qVis)}`;
    marcaQ.setLngLat(afin(E.g)(c + 0.5, r + 0.5)).addTo(mapa);
  }
}

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
    pendiente_media_pct: +st.pendMedia.toFixed(2), encharcamiento_max_ha: +(st.encArea / 1e4).toFixed(3), encharcamiento_max_m3: Math.round(st.encVol) };
  const t = E.an.tormenta;
  if (t) Object.assign(props, { tormenta_retorno_anios: t.T, lluvia_24h_mm: +t.P24.toFixed(1), suelo: t.suelo,
    escorrentia_m3: Math.round(t.stats.genera), infiltracion_m3: Math.round(t.stats.infiltra), pozas_m3: Math.round(t.stats.enCharcos),
    sale_m3: Math.round(t.stats.sale), caudal_max_m3s: +t.stats.qMax.toFixed(3) });
  const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [contorno()] } }] };
  descargar("gotyx_terreno.geojson", JSON.stringify(fc, null, 1), "application/geo+json");
};

$("b-tif").onclick = async () => {
  const t = E.an.tormenta;
  const fuentes = { elevacion: [E.g.z, "elevacion_m"], pendiente: [E.an.pendiente, "pendiente_pct"],
    encharcamiento: t ? [t.profT, `pozas_T${t.T}_m`] : [E.an.prof, "encharcamiento_max_m"],
    escurrimiento: t ? [t.qp, `caudal_T${t.T}_m3s`] : [E.an.acc, "area_aportante_m2"],
    cobertura: [E.an.clase ? Float32Array.from(E.an.clase) : E.g.z, "cobertura_worldcover"], ninguna: [E.g.z, "elevacion_m"] };
  const [arr, nombre] = fuentes[E.capa];
  const { w, h } = E.g;
  const { crs, x0, y0, rx, ry } = E.g.georef;
  const vals = new Float32Array(w * h);
  for (let i = 0; i < vals.length; i++) vals[i] = E.an.mask[i] && !Number.isNaN(arr[i]) ? arr[i] : -9999;
  const epsg = Number(crs.split(":")[1]);
  try {
    const buf = geotiffFloat32(vals, w, h, { epsg, x0, y0, rx, ry });
    descargar(`gotyx_${nombre}.tif`, new Blob([buf], { type: "image/tiff" }));
  } catch (err) {
    console.error(err);
    estado("No pude generar el GeoTIFF: " + err.message, true);
  }
};

// ---------- informe PDF ----------
// zona del mapa que no tapa el panel (en px de pantalla)
function zonaVisible() {
  const p = $("panel").getBoundingClientRect();
  if (innerWidth > 720) { const x = Math.round(p.right + 8); return { x, y: 0, w: innerWidth - x, h: innerHeight }; }
  return { x: 0, y: 0, w: innerWidth, h: Math.round(p.top) };
}
// captura del mapa: se toma dentro del evento "render", cuando el cuadro aún está en el búfer
const capturarMapa = (z) => new Promise((ok) => {
  mapa.once("render", () => {
    const cv = mapa.getCanvas(), k = cv.width / cv.clientWidth;
    const W = Math.round(z.w * k), H = Math.round(z.h * k), s = Math.min(1, 1800 / W);
    const o = document.createElement("canvas");
    o.width = Math.round(W * s); o.height = Math.round(H * s);
    o.getContext("2d").drawImage(cv, Math.round(z.x * k), Math.round(z.y * k), W, H, 0, 0, o.width, o.height);
    ok(o.toDataURL("image/jpeg", 0.88));
  });
  mapa.triggerRepaint();
});
const mapaQuieto = (max = 9000) => new Promise((ok) => {
  const t = setTimeout(ok, max);
  mapa.once("idle", () => { clearTimeout(t); setTimeout(ok, 250); });
  mapa.triggerRepaint();
});
async function nombreLugar(lon, lat) {
  if (MODO_DEMO && typeof demo !== "undefined" && demo) return demo.nombre.replace(" · ", ", ");
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}&limit=1`, { signal: ctl.signal });
    clearTimeout(t);
    const p = (await r.json()).features?.[0]?.properties;
    if (p) {
      const comuna = p.city || p.county || p.name;
      const txt = [p.district && p.district !== comuna ? p.district : null, comuna, p.state].filter(Boolean).join(", ");
      if (txt) return `Terreno en ${txt}`;
    }
  } catch {}
  return `Terreno en ${fmt(lat, 4)}°, ${fmt(lon, 4)}°`;
}

$("b-informe").onclick = async () => {
  if (E.haciendoInforme || !E.an) return;
  E.haciendoInforme = true;
  const ov = document.createElement("div");
  ov.className = "demo-carga";
  ov.innerHTML = `<div class="dc-caja"><div class="dc-gota"><svg viewBox="0 0 32 32"><path d="M16 2.5S6 13.6 6 20a10 10 0 0 0 20 0C26 13.6 16 2.5 16 2.5Z"/></svg></div>
    <div class="dc-titulo">Generando tu informe</div><ol class="dc-pasos"><li>Ubicando el terreno</li><li>Capturando la vista actual</li>
    <li>Mapa de escurrimiento</li><li>Mapa de acumulación de agua</li><li>Armando el PDF</li></ol><div class="dc-barra"><i></i></div></div>`;
  document.body.append(ov);
  const paso = (k) => {
    ov.querySelectorAll("li").forEach((li, i) => { li.classList.toggle("ok", i < k); li.classList.toggle("en", i === k); });
    ov.querySelector(".dc-barra i").style.width = `${(100 * (k + 0.5)) / 5}%`;
  };
  const previo = { capa: E.capa, centro: mapa.getCenter(), zoom: mapa.getZoom(), bearing: mapa.getBearing(), pitch: mapa.getPitch(), lluvia: lluvia.activa };
  detenerOrbita();
  try {
    paso(0);
    const [lon, lat] = centroTerreno();
    const lugar = nombreLugar(lon, lat);
    const z = zonaVisible();
    if (previo.lluvia) lluviaGL.detener(); // sin gotas en las imágenes
    paso(1);
    await mapaQuieto(4000);
    const imgs = { vista: await capturarMapa(z) };
    // vistas cenitales del terreno completo
    paso(2);
    const c = E.anillo || [...esquinas(E.g)];
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const m = 36;
    mapa.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
      { padding: { left: z.x + m, right: innerWidth - z.x - z.w + m, top: z.y + m, bottom: innerHeight - z.y - z.h + m }, pitch: 0, bearing: 0, duration: 0 });
    if (E.capa !== "escurrimiento") elegirCapa("escurrimiento");
    await mapaQuieto();
    imgs.escurrimiento = await capturarMapa(z);
    paso(3);
    elegirCapa("encharcamiento");
    await mapaQuieto(5000);
    imgs.encharcamiento = await capturarMapa(z);
    paso(4);
    const t = E.an.tormenta;
    let idf = [];
    if (t && E.lluvias) {
      const fila = E.lluvias.P[t.T];
      idf = [["1 hora (est.)", ajusteIDF(fila).a], ["6 horas", fila[1]], ["24 horas", fila[3]], ["3 días", fila[5]]];
    }
    const hoy = new Date();
    const id = `GX-${hoy.toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
    const nombre = await lugar;
    $("informe").innerHTML = informeHTML({ st: E.an.stats, t, g: E.g, imgs, clasesPend: CLASES_PEND, idf, lugar: nombre, lat, lon, id,
      fecha: hoy.toLocaleDateString("es-CL", { dateStyle: "long" }) });
    await Promise.all([...$("informe").querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
    if (document.fonts?.ready) await document.fonts.ready;
    ov.querySelector(".dc-barra i").style.width = "100%";
    // restaurar la vista del usuario antes de abrir el diálogo de impresión
    elegirCapa(previo.capa);
    mapa.jumpTo({ center: previo.centro, zoom: previo.zoom, bearing: previo.bearing, pitch: previo.pitch });
    if (previo.lluvia) { $("t-lluvia").checked = true; iniciarLluvia(); }
    ov.remove();
    const titulo = document.title;
    document.title = `Informe Gotyx - ${nombre.replace(/^Terreno en /, "")} - ${hoy.toISOString().slice(0, 10)}`;
    window.print();
    document.title = titulo;
  } catch (err) {
    console.error(err);
    ov.remove();
    elegirCapa(previo.capa);
    mapa.jumpTo({ center: previo.centro, zoom: previo.zoom, bearing: previo.bearing, pitch: previo.pitch });
    if (previo.lluvia) { $("t-lluvia").checked = true; iniciarLluvia(); }
    estado("No pude generar el informe: " + (err.message || err), true);
  } finally {
    E.haciendoInforme = false;
  }
};

// ---------- panel plegable (celular) ----------
$("plegar").onclick = () => $("panel").classList.toggle("plegado");

// ---------- modo demo (?demo=macul | ?demo=aculeo): casos precargados, sin dibujar terrenos propios ----------
const DEMOS = {
  macul: { nombre: "Quebrada de Macul · Peñalolén", anillo: [[-70.528, -33.47], [-70.46, -33.468], [-70.458, -33.53], [-70.53, -33.532]],
    capa: "escurrimiento", exagerar: 1.4, camara: { bearing: 80, pitch: 56, zoom: -0.15 } },
  aculeo: { nombre: "Laguna de Aculeo · Paine", anillo: [[-70.975, -33.805], [-70.855, -33.80], [-70.85, -33.885], [-70.97, -33.89]],
    capa: "encharcamiento", exagerar: 2.2, camara: { bearing: 8, pitch: 50, zoom: 0 } },
};
const demo = DEMOS[params.get("demo")];
if (demo) {
  document.body.classList.add("modo-demo");
  const aviso = document.createElement("div");
  aviso.className = "demo-aviso";
  aviso.innerHTML = `<span><b>Demo</b> · ${demo.nombre}</span>
    <a href="../#demo">Analiza tu terreno → agenda una demo</a>`;
  document.body.append(aviso);
  const cambiar = document.createElement("p");
  cambiar.className = "ayuda demo-casos";
  cambiar.innerHTML = `Casos de la demo: <a href="?demo=macul">Quebrada de Macul</a> · <a href="?demo=aculeo">Laguna de Aculeo</a>`;
  document.querySelector("#paso-terreno .botones").replaceWith(cambiar);
  $("buscar").hidden = true;
  // menos ruido visual: sin curvas de nivel y solo los cauces principales (se pueden activar en el panel)
  $("t-curvas").checked = false;
  $("umbral").value = 48; textoUmbral();

  // pantalla de carga con los pasos del cálculo
  const carga = document.createElement("div");
  carga.className = "demo-carga";
  carga.innerHTML = `<div class="dc-caja"><div class="dc-gota"><svg viewBox="0 0 32 32"><path d="M16 2.5S6 13.6 6 20a10 10 0 0 0 20 0C26 13.6 16 2.5 16 2.5Z"/></svg></div>
    <div class="dc-titulo">${demo.nombre}</div>
    <ol class="dc-pasos">
      <li data-p="relieve">Descargando relieve satelital</li>
      <li data-p="agua">Calculando por dónde corre el agua</li>
      <li data-p="lluvia">Lluvias extremas de 100 años para este punto</li>
      <li data-p="tormenta">Simulando la tormenta</li>
      <li data-p="3d">Preparando vista 3D</li>
    </ol><div class="dc-barra"><i></i></div></div>`;
  document.body.append(carga);
  const pasos = ["relieve", "agua", "lluvia", "tormenta", "3d"];
  const marcar = (p) => {
    const k = pasos.indexOf(p);
    carga.querySelectorAll("li").forEach((li, i) => { li.classList.toggle("ok", i < k); li.classList.toggle("en", i === k); });
    carga.querySelector(".dc-barra i").style.width = `${(100 * (k + 0.5)) / pasos.length}%`;
  };
  marcar("relieve");
  const vigilar = setInterval(() => {
    const t = $("estado").textContent || "";
    if (/escurrimiento|Calculando/i.test(t)) marcar("agua");
  }, 120);

  const esperarQue = (cond) => new Promise((ok) => { const t = setInterval(() => { if (cond()) { clearInterval(t); ok(); } }, 100); });
  const correrDemo = async () => {
    E.anillo = [...demo.anillo, demo.anillo[0]];
    dibujarPoligono();
    $("info-poligono").hidden = false;
    $("info-poligono").innerHTML = `Polígono de <b>${ha(areaAnillo(E.anillo))}</b> · caso de demostración`;
    const xs = demo.anillo.map((p) => p[0]), ys = demo.anillo.map((p) => p[1]);
    const caja = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    const celular = innerWidth <= 720;
    if (celular) $("panel").classList.add("plegado");
    const pad = { left: celular ? 16 : 400, right: celular ? 16 : 40, top: 80, bottom: celular ? 90 : 50 };
    mapa.fitBounds(caja, { padding: pad, duration: 0 });
    actualizarBotonAnalizar();
    $("b-analizar").click();
    await esperarQue(() => E.an && !$("paso-tormenta").hidden);
    marcar("lluvia");
    await esperarQue(() => E.lluvias);
    E.T = 100; mostrarIDF();
    marcar("tormenta");
    await simularTormenta();
    elegirCapa(demo.capa);
    marcar("3d");
    $("exagerar").value = demo.exagerar; $("exagerar").dispatchEvent(new Event("input"));
    $("t-3d").checked = true; $("ctl3d").hidden = false;
    mapa.setTerrain({ source: "dem", exaggeration: demo.exagerar });
    // espera a que el relieve cargue antes de mostrar (sin saltos ni teselas a medio cargar)
    await new Promise((ok) => { mapa.once("idle", ok); setTimeout(ok, 6000); });
    const cam = mapa.cameraForBounds(caja, { padding: pad, bearing: demo.camara.bearing });
    clearInterval(vigilar);
    carga.querySelector(".dc-barra i").style.width = "100%";
    carga.classList.add("fuera");
    setTimeout(() => carga.remove(), 700);
    $("t-lluvia").checked = true; iniciarLluvia();
    mapa.flyTo({ center: cam.center, zoom: cam.zoom + demo.camara.zoom, bearing: demo.camara.bearing, pitch: demo.camara.pitch,
      duration: 3200, curve: 1.2, easing: (t) => t * t * (3 - 2 * t), essential: true });
  };
  const correrSeguro = () => correrDemo().catch((err) => {
    console.error(err);
    clearInterval(vigilar);
    carga.querySelector(".dc-pasos").innerHTML = `<li class="en" style="color:#ffb39e">No pudimos cargar la demo. Revisa tu conexión y <a href="" style="color:#5cc8ff">vuelve a intentar</a>.</li>`;
  });
  if (mapa.loaded()) correrSeguro(); else mapa.once("load", correrSeguro);
}
