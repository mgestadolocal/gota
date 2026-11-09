// Gotyx — interacciones del sitio de lanzamiento
const API = (window.GOTA_API || "").replace(/\/$/, "");
const reducir = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// navegación sólida al bajar
const nav = $("#nav");
const navScroll = () => nav.classList.toggle("solida", scrollY > 30);
addEventListener("scroll", navScroll, { passive: true }); navScroll();

// ---------- curvas de nivel animadas en la portada ----------
const topo = $("#topo");
if (topo) {
  const lineas = [];
  for (let k = 0; k < 22; k++) {
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", k % 5 === 0 ? "rgba(92,200,255,.55)" : "rgba(92,200,255,.18)");
    pl.setAttribute("stroke-width", k % 5 === 0 ? 1.4 : 0.9);
    topo.append(pl); lineas.push(pl);
  }
  const dibujar = (t) => {
    lineas.forEach((pl, k) => {
      const r = 50 + k * 42, cx = 1180, cy = 330, pts = [];
      for (let a = 0; a <= 72; a++) {
        const th = (a / 72) * Math.PI * 2;
        const rr = r * (1 + 0.17 * Math.sin(3 * th + k * 0.45 + t * 0.00018) + 0.08 * Math.sin(5 * th - k * 0.3 - t * 0.00011));
        pts.push(`${(cx + rr * Math.cos(th)).toFixed(1)},${(cy + rr * 0.78 * Math.sin(th)).toFixed(1)}`);
      }
      pl.setAttribute("points", pts.join(" "));
    });
  };
  dibujar(0);
  // trazo inicial
  lineas.forEach((pl, k) => {
    const L = 4000; pl.style.strokeDasharray = L; pl.style.strokeDashoffset = reducir ? 0 : L;
    if (!reducir) pl.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 2400, delay: 200 + k * 55, easing: "cubic-bezier(.6,0,.2,1)", fill: "forwards" });
  });
  if (!reducir) { const loop = (t) => { dibujar(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
}

// lectura tipo HUD en la portada
const lectura = $("#lectura");
if (lectura && !reducir) {
  const casos = [
    ["−33.5000", "−70.4970", "T = 100 AÑOS · 134 mm / 24 h"],
    ["−33.5000", "−70.4970", "CAUDAL MÁX. 77,8 m³/s"],
  ];
  let i = 0;
  setInterval(() => {
    i = (i + 1) % casos.length;
    const [la, lo, t] = casos[i];
    lectura.innerHTML = `LAT ${la} · LON ${lo}<br>${t}`;
  }, 4000);
}

// ---------- aparición al hacer scroll y contadores ----------
const fmt = (v, d) => v.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });
function contar(el) {
  const fin = parseFloat(el.dataset.contar), d = +el.dataset.dec || 0;
  if (reducir) { el.textContent = fmt(fin, d); return; }
  const t0 = performance.now(), dur = 1600;
  const paso = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(fin * e, d);
    if (p < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}
const io = new IntersectionObserver((ents) => {
  for (const e of ents) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("visible");
    $$("[data-contar]", e.target).forEach((n) => { if (!n.dataset.hecho) { n.dataset.hecho = 1; contar(n); } });
    io.unobserve(e.target);
  }
}, { threshold: 0.18 });
$$(".aparece").forEach((el) => io.observe(el));

// videos: solo se reproducen cuando están a la vista (ahorra datos y batería)
const ioVideo = new IntersectionObserver((ents) => {
  for (const e of ents) {
    const v = e.target;
    if (e.isIntersecting) { if (v.preload === "none") v.preload = "auto"; v.play().catch(() => {}); }
    else v.pause();
  }
}, { threshold: 0.25 });
$$(".caso video, .paso video").forEach((v) => ioVideo.observe(v));

// ---------- cómo funciona: video fijo que cambia con cada paso ----------
const pasos = $$(".paso");
const clips = $$(".marco video");
const barra = $("#barra-txt"), progreso = $("#progreso");
const titulos = ["GOTYX · DIBUJA EL TERRENO", "GOTYX · ANALIZANDO RELIEVE", "GOTYX · TORMENTA T = 100 AÑOS", "GOTYX · VISTA 3D"];
let activo = -1;
function activar(i) {
  if (i === activo) return;
  activo = i;
  pasos.forEach((p, k) => p.classList.toggle("activo", k === i));
  clips.forEach((v, k) => {
    if (k === i) { if (v.preload === "none") v.preload = "auto"; v.currentTime = 0; v.play().catch(() => {}); v.classList.add("visible"); }
    else { v.classList.remove("visible"); setTimeout(() => k !== activo && v.pause(), 700); }
  });
  if (barra) barra.textContent = titulos[i];
}
if (clips.length) {
  const ioPaso = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) activar(+e.target.dataset.clip);
  }, { rootMargin: "-45% 0px -45% 0px" });
  pasos.forEach((p) => ioPaso.observe(p));
  activar(0);
  clips.forEach((v) => v.addEventListener("timeupdate", () => {
    if (v.classList.contains("visible") && v.duration) progreso.style.width = `${(100 * v.currentTime) / v.duration}%`;
  }));
}

// ---------- formulario de demo ----------
const form = $("#form-demo");
if (form) {
  const estado = $("#estado-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    estado.className = "estado"; estado.textContent = "";
    const datos = Object.fromEntries(new FormData(form));
    const faltan = [];
    if (!datos.nombre?.trim()) faltan.push("nombre");
    if (!datos.empresa?.trim()) faltan.push("empresa");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(datos.correo || "")) faltan.push("un correo válido");
    if (!datos.rubro) faltan.push("rubro");
    if (faltan.length) { estado.classList.add("error"); estado.textContent = `Falta: ${faltan.join(", ")}.`; return; }
    if (!$("#f-ok").checked) { estado.classList.add("error"); estado.textContent = "Necesitamos tu autorización para contactarte."; return; }
    const boton = form.querySelector("button"); boton.disabled = true; estado.textContent = "Enviando…";
    try {
      const r = await fetch(`${API}/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...datos, origen: location.href }) });
      if (!r.ok) throw new Error(r.status);
      $("#caja-form").classList.add("enviado");
    } catch {
      estado.classList.add("error");
      estado.textContent = "No pudimos enviar tu solicitud. Intenta de nuevo en unos minutos.";
    } finally { boton.disabled = false; }
  });
}
