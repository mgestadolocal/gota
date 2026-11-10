// Worker de Gotyx
// 1) Intermediario de datos: Copernicus DEM y ESA WorldCover (AWS Open Data) no envían CORS;
//    aquí se reenvían lecturas por rango. Sin sesión solo se entregan las teselas de la demo abierta.
// 2) Solicitudes de demo (POST /demo): se guardan en KV y, si hay clave de Resend, avisan por correo.
// 3) Cuentas por invitación (POST /auth/login, /auth/logout, GET /auth/yo) con claves PBKDF2 y sesiones en KV.
//    El cliente crea su propia contraseña con un enlace de un solo uso (/auth/enlace, /auth/definir, /auth/recuperar).
// 4) Administración (/admin/*) protegida con el secreto ADMIN_KEY.
// Enlaces KV: DATOS. Secretos: ADMIN_KEY, RESEND_API_KEY (opcional), AVISO_CORREO (opcional).

const FUENTES = {
  cop: {
    re: /^Copernicus_DSM_COG_10_[NS]\d{2}_00_[EW]\d{3}_00_DEM$/,
    url: (n) => `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${n}/${n}.tif`,
  },
  wc: {
    re: /^ESA_WorldCover_10m_2021_v200_[NS]\d{2}[EW]\d{3}_Map$/,
    url: (n) => `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/${n}.tif`,
  },
};
// teselas que cubren los casos de la demo abierta (Quebrada de Macul y Laguna de Aculeo)
const DEMO_LIBRE = new Set(["Copernicus_DSM_COG_10_S34_00_W071_00_DEM", "ESA_WorldCover_10m_2021_v200_S36W072_Map"]);
const RANGO = /^bytes=\d{1,10}-\d{0,10}$/;
const ITER = 20000; // PBKDF2-SHA256 (las claves son aleatorias y largas; el plan gratis limita la CPU)
const SESION_DIAS = 30;
const CORREO_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/;

// ---------- utilidades ----------
function cabecerasCors(req, env) {
  const origen = req.headers.get("Origin") || "";
  const permitidos = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const permitido = permitidos.includes("*") ? "*" : permitidos.includes(origen) ? origen : permitidos[0] || "";
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Authorization, Content-Type, X-Admin-Key",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, ETag",
    Vary: "Origin",
  };
}
const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const azar = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function pbkdf2(clave, sal, iter = ITER) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(sal), iterations: iter }, k, 256);
  return hex(bits);
}
function igual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function claveNueva(n = 15) {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of r) s += abc[b % abc.length];
  return s.slice(0, 5) + "-" + s.slice(5, 10) + "-" + s.slice(10);
}
const limpiar = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const normalizarCorreo = (c) => limpiar(c, 254).toLowerCase();
const ipDe = (req) => req.headers.get("CF-Connecting-IP") || "0.0.0.0";

// límite simple de intentos con contador en KV (aproximado: KV es eventualmente consistente)
async function limitar(env, clave, max, ventanaSeg) {
  const k = `limite:${clave}`;
  const n = parseInt((await env.DATOS.get(k)) || "0", 10);
  if (n >= max) return false;
  await env.DATOS.put(k, String(n + 1), { expirationTtl: Math.max(60, ventanaSeg) });
  return true;
}
async function cuerpo(req) {
  try { return await req.json(); } catch { return null; }
}
async function sesionDe(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const s = await env.DATOS.get(`sesion:${await sha256(m[1])}`, "json");
  if (!s || s.exp < Date.now()) return null;
  return s;
}

// ---------- datos (Copernicus / WorldCover) ----------
async function datos(req, env, cors, fuente, nombre) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("método", { status: 405, headers: cors });
  if (!DEMO_LIBRE.has(nombre)) {
    if (!env.DATOS || !(await sesionDe(req, env))) return json({ error: "Inicia sesión para analizar este lugar." }, 401, cors);
  }
  const rango = req.headers.get("Range");
  if (req.method === "GET" && (!rango || !RANGO.test(rango))) return new Response("se requiere un único rango de bytes", { status: 416, headers: cors });
  const arriba = await fetch(fuente.url(nombre), { method: req.method, headers: rango ? { Range: rango } : {} });
  const h = new Headers(cors);
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const v = arriba.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("Cache-Control", "private, max-age=2592000");
  if (arriba.status === 404 || arriba.status === 403) return new Response("sin datos para esa tesela", { status: 404, headers: h });
  return new Response(arriba.body, { status: arriba.status, headers: h });
}

// ---------- correo (Resend) ----------
const REMITENTE = (env) => env.AVISO_DESDE || "Gotyx <hola@gotyx.cl>";
async function enviarCorreo(env, { to, subject, text, html, reply_to }) {
  if (!env.RESEND_API_KEY) return { ok: false, motivo: "sin RESEND_API_KEY" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: REMITENTE(env), to: [to], subject, text, html, ...(reply_to ? { reply_to } : {}) }),
    });
    return { ok: r.ok, motivo: r.ok ? "" : `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, motivo: String(e) };
  }
}
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SITIO = (env) => (env.SITIO || "https://gotyx.cl").replace(/\/$/, "");
const ENLACE_HORAS = { invitacion: 24 * 7, restablecer: 24 * 3, recuperar: 2 };
function correoEnlace({ nombre, correo, enlace, tipo }) {
  const saludo = nombre ? `Hola ${nombre.split(" ")[0]}` : "Hola";
  const T = {
    invitacion: ["Tu cuenta de Gotyx está lista", "Te creamos tu cuenta en Gotyx, la plataforma de simulación hidrológica para terrenos en Chile. Para entrar, crea tu contraseña:", "Crear mi contraseña →", "El enlace vale por 7 días."],
    restablecer: ["Crea una nueva contraseña para Gotyx", "Te enviamos un enlace para crear una nueva contraseña en Gotyx:", "Crear nueva contraseña →", "El enlace vale por 3 días."],
    recuperar: ["Recupera tu acceso a Gotyx", "Recibimos una solicitud para restablecer tu contraseña de Gotyx. Si fuiste tú, crea una nueva aquí:", "Crear nueva contraseña →", "El enlace vale por 2 horas. Si no lo pediste, ignora este correo: tu contraseña no cambia."],
  }[tipo];
  const [asunto, intro, boton, vence] = T;
  const text = `${saludo},\n\n${intro}\n\n${enlace}\n\nTu usuario es: ${correo}\n${vence}\n\nCualquier duda, responde este correo.\n\nEquipo Gotyx\nhttps://gotyx.cl`;
  const html = `<!doctype html><html><body style="margin:0;background:#050e16;padding:32px 12px;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#0a1c29;border:1px solid #1d3a4f;border-radius:18px">
<tr><td style="padding:32px 34px 8px"><span style="font-size:24px;font-weight:800;color:#eaf6ff">Got<span style="color:#5cc8ff">yx</span></span></td></tr>
<tr><td style="padding:8px 34px 0;color:#eaf6ff;font-size:16px;line-height:1.6">
<p style="margin:0 0 14px">${escHtml(saludo)},</p><p style="margin:0 0 22px;color:#b5cbd8">${escHtml(intro)}</p>
<p style="margin:0 0 22px"><a href="${escHtml(enlace)}" style="background:#5cc8ff;color:#050e16;text-decoration:none;font-weight:800;padding:14px 24px;border-radius:12px;display:inline-block">${escHtml(boton)}</a></p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#06131d;border:1px solid #1d3a4f;border-radius:12px">
<tr><td style="padding:14px 18px;font-family:Consolas,Menlo,monospace;font-size:14px;color:#eaf6ff"><span style="color:#8fb0c4">Usuario</span>&nbsp; ${escHtml(correo)}</td></tr></table>
<p style="margin:22px 0 28px;color:#8fb0c4;font-size:14px">${escHtml(vence)} Si el botón no funciona, copia este enlace en tu navegador:<br><span style="color:#5cc8ff;word-break:break-all">${escHtml(enlace)}</span></p>
</td></tr>
<tr><td style="padding:18px 34px 26px;border-top:1px solid #1d3a4f;color:#5f7d90;font-size:12px">Gotyx · Simulación hidrológica para cualquier terreno de Chile · <a href="https://gotyx.cl" style="color:#5cc8ff">gotyx.cl</a></td></tr>
</table></td></tr></table></body></html>`;
  return { asunto, text, html };
}
// enlace de un solo uso: el token va solo en el correo; en KV se guarda su hash
async function crearEnlace(env, correo, tipo, base) {
  const k = azar(32);
  const horas = ENLACE_HORAS[tipo];
  await env.DATOS.put(`enlace:${await sha256(k)}`, JSON.stringify({ correo, tipo, exp: Date.now() + horas * 3600e3 }), { expirationTtl: horas * 3600 });
  return `${base}?k=${k}`;
}
async function leerEnlace(env, k) {
  if (!/^[a-f0-9]{64}$/.test(String(k || ""))) return null;
  const id = `enlace:${await sha256(k)}`;
  const e = await env.DATOS.get(id, "json");
  if (!e || e.exp < Date.now()) return null;
  return { id, ...e };
}

// ---------- solicitudes de demo ----------
async function demo(req, env, cors) {
  const b = await cuerpo(req);
  if (!b) return json({ error: "Solicitud inválida." }, 400, cors);
  if (limpiar(b.sitio, 200)) return json({ ok: true }, 200, cors); // campo trampa para bots
  const d = {
    nombre: limpiar(b.nombre, 120), empresa: limpiar(b.empresa, 160), correo: normalizarCorreo(b.correo),
    telefono: limpiar(b.telefono, 40), rubro: limpiar(b.rubro, 60), mensaje: limpiar(b.mensaje, 2000),
    origen: limpiar(b.origen, 300), fecha: new Date().toISOString(), estado: "nueva",
  };
  if (!d.nombre || !d.empresa || !d.rubro || !CORREO_RE.test(d.correo)) return json({ error: "Faltan datos." }, 400, cors);
  if (!(await limitar(env, `demo:${ipDe(req)}`, 5, 3600))) return json({ error: "Demasiadas solicitudes. Intenta más tarde." }, 429, cors);
  const id = `${Date.now()}-${azar(4)}`;
  await env.DATOS.put(`demo:${id}`, JSON.stringify(d));
  if (env.AVISO_CORREO) {
    const texto = `Nueva solicitud de demo en Gotyx\n\nNombre: ${d.nombre}\nEmpresa: ${d.empresa}\nRubro: ${d.rubro}\nCorreo: ${d.correo}\nTeléfono: ${d.telefono || "—"}\n\nTerreno o zona:\n${d.mensaje || "—"}\n\nFecha: ${d.fecha}\n\nVer y crear su cuenta: https://gotyx.cl/admin.html`;
    await enviarCorreo(env, { to: env.AVISO_CORREO, reply_to: d.correo, subject: `Demo Gotyx: ${d.empresa} (${d.rubro})`, text: texto });
  }
  return json({ ok: true }, 200, cors);
}

// ---------- cuentas ----------
async function login(req, env, cors) {
  const b = await cuerpo(req);
  const correo = normalizarCorreo(b?.correo), clave = String(b?.clave ?? "");
  if (!CORREO_RE.test(correo) || !clave || clave.length > 200) return json({ error: "Correo o clave incorrectos." }, 401, cors);
  if (!(await limitar(env, `login-ip:${ipDe(req)}`, 20, 900)) || !(await limitar(env, `login-correo:${correo}`, 8, 900))) {
    return json({ error: "Demasiados intentos. Espera 15 minutos." }, 429, cors);
  }
  const u = await env.DATOS.get(`usuario:${correo}`, "json");
  const calculada = await pbkdf2(clave, u?.sal || "sal-ficticia", u?.iter || ITER); // mismo costo aunque no exista
  if (!u || !igual(calculada, u.hash)) return json({ error: "Correo o clave incorrectos." }, 401, cors);
  if (!u.activo) return json({ error: "Tu cuenta está desactivada. Escríbenos para reactivarla." }, 403, cors);
  const token = await nuevaSesion(env, correo);
  u.ultimoIngreso = new Date().toISOString();
  await env.DATOS.put(`usuario:${correo}`, JSON.stringify(u));
  return json({ token, nombre: u.nombre, empresa: u.empresa }, 200, cors);
}
async function nuevaSesion(env, correo) {
  const token = azar(32);
  await env.DATOS.put(`sesion:${await sha256(token)}`, JSON.stringify({ correo, exp: Date.now() + SESION_DIAS * 86400e3 }), { expirationTtl: SESION_DIAS * 86400 });
  return token;
}
async function verEnlace(req, env, cors) {
  const b = await cuerpo(req);
  if (!(await limitar(env, `enlace-ip:${ipDe(req)}`, 30, 900))) return json({ error: "Demasiados intentos. Espera 15 minutos." }, 429, cors);
  const e = await leerEnlace(env, b?.k);
  if (!e) return json({ error: "El enlace no es válido o ya venció. Pide uno nuevo con «¿Olvidaste tu contraseña?»." }, 410, cors);
  const u = await env.DATOS.get(`usuario:${e.correo}`, "json");
  if (!u) return json({ error: "La cuenta ya no existe." }, 410, cors);
  return json({ correo: e.correo, nombre: u.nombre || "", tipo: e.tipo }, 200, cors);
}
async function definirClave(req, env, cors) {
  const b = await cuerpo(req);
  if (!(await limitar(env, `enlace-ip:${ipDe(req)}`, 30, 900))) return json({ error: "Demasiados intentos. Espera 15 minutos." }, 429, cors);
  const clave = String(b?.clave ?? "");
  if (clave.length < 8 || clave.length > 200) return json({ error: "La contraseña debe tener al menos 8 caracteres." }, 400, cors);
  const e = await leerEnlace(env, b?.k);
  if (!e) return json({ error: "El enlace no es válido o ya venció. Pide uno nuevo." }, 410, cors);
  const u = await env.DATOS.get(`usuario:${e.correo}`, "json");
  if (!u) return json({ error: "La cuenta ya no existe." }, 410, cors);
  if (!u.activo) return json({ error: "Tu cuenta está desactivada. Escríbenos para reactivarla." }, 403, cors);
  u.sal = azar(16); u.iter = ITER; u.hash = await pbkdf2(clave, u.sal);
  u.claveDefinida = new Date().toISOString(); u.ultimoIngreso = u.claveDefinida;
  await env.DATOS.put(`usuario:${e.correo}`, JSON.stringify(u));
  await env.DATOS.delete(e.id);
  return json({ token: await nuevaSesion(env, e.correo), nombre: u.nombre, empresa: u.empresa }, 200, cors);
}
async function recuperar(req, env, cors) {
  const b = await cuerpo(req);
  const correo = normalizarCorreo(b?.correo);
  if (!CORREO_RE.test(correo)) return json({ error: "Escribe un correo válido." }, 400, cors);
  if (!(await limitar(env, `recuperar-ip:${ipDe(req)}`, 10, 3600)) || !(await limitar(env, `recuperar:${correo}`, 3, 3600))) {
    return json({ error: "Ya enviamos varios correos. Revisa tu bandeja (y spam) o espera una hora." }, 429, cors);
  }
  const u = await env.DATOS.get(`usuario:${correo}`, "json");
  // misma respuesta exista o no la cuenta (no revela qué correos están registrados)
  if (u && u.activo) {
    const enlace = await crearEnlace(env, correo, "recuperar", `${SITIO(env)}/ingresar.html`);
    const { asunto, text, html } = correoEnlace({ nombre: u.nombre, correo, enlace, tipo: "recuperar" });
    await enviarCorreo(env, { to: correo, subject: asunto, text, html, reply_to: "hola@gotyx.cl" });
  }
  return json({ ok: true }, 200, cors);
}
async function logout(req, env, cors) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (m) await env.DATOS.delete(`sesion:${await sha256(m[1])}`);
  return json({ ok: true }, 200, cors);
}
async function yo(req, env, cors) {
  const s = await sesionDe(req, env);
  if (!s) return json({ error: "Sesión vencida." }, 401, cors);
  const u = await env.DATOS.get(`usuario:${s.correo}`, "json");
  if (!u || !u.activo) return json({ error: "Cuenta no disponible." }, 401, cors);
  return json({ correo: s.correo, nombre: u.nombre, empresa: u.empresa }, 200, cors);
}

// ---------- administración ----------
async function listar(env, prefijo, max = 300) {
  const claves = [];
  let cursor;
  do {
    const r = await env.DATOS.list({ prefix: prefijo, cursor, limit: 1000 });
    claves.push(...r.keys.map((k) => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && claves.length < 5000);
  claves.sort().reverse();
  const elegidas = claves.slice(0, max);
  const valores = await Promise.all(elegidas.map((k) => env.DATOS.get(k, "json")));
  return elegidas.map((k, i) => ({ id: k.slice(prefijo.length), ...valores[i] }));
}
async function admin(req, env, cors, ruta) {
  if (!env.ADMIN_KEY || !igual(req.headers.get("X-Admin-Key") || "", env.ADMIN_KEY)) {
    await limitar(env, `admin:${ipDe(req)}`, 30, 900);
    return json({ error: "Clave de administración incorrecta." }, 401, cors);
  }
  if (ruta === "/admin/demos" && req.method === "GET") return json({ demos: await listar(env, "demo:") }, 200, cors);
  if (ruta === "/admin/demos/estado" && req.method === "POST") {
    const b = await cuerpo(req);
    const id = limpiar(b?.id, 40);
    const d = await env.DATOS.get(`demo:${id}`, "json");
    if (!d) return json({ error: "No existe." }, 404, cors);
    d.estado = limpiar(b.estado, 30) || d.estado;
    await env.DATOS.put(`demo:${id}`, JSON.stringify(d));
    return json({ ok: true }, 200, cors);
  }
  if (ruta === "/admin/usuarios" && req.method === "GET") {
    const us = (await listar(env, "usuario:", 1000)).map(({ hash, sal, iter, ...resto }) => resto);
    return json({ usuarios: us }, 200, cors);
  }
  if ((ruta === "/admin/usuarios" || ruta === "/admin/usuarios/clave") && req.method === "POST") {
    const b = await cuerpo(req);
    const correo = normalizarCorreo(b?.correo);
    if (!CORREO_RE.test(correo)) return json({ error: "Correo inválido." }, 400, cors);
    const previo = await env.DATOS.get(`usuario:${correo}`, "json");
    if (ruta === "/admin/usuarios" && previo) return json({ error: "Esa cuenta ya existe. Usa «Nueva clave»." }, 409, cors);
    if (ruta === "/admin/usuarios/clave" && !previo) return json({ error: "No existe." }, 404, cors);
    const nueva = ruta === "/admin/usuarios/clave";
    // la cuenta nace con una clave aleatoria que nadie conoce: el cliente define la suya con el enlace
    const sal = azar(16);
    const u = {
      ...(previo || { creado: new Date().toISOString(), activo: true }),
      nombre: limpiar(b.nombre, 120) || previo?.nombre || "",
      empresa: limpiar(b.empresa, 160) || previo?.empresa || "",
      ...(nueva ? {} : { sal, iter: ITER, hash: await pbkdf2(claveNueva() + azar(8), sal) }),
    };
    await env.DATOS.put(`usuario:${correo}`, JSON.stringify(u));
    const base = /^https?:\/\/[^\s]+\/ingresar\.html$/.test(limpiar(b.url, 200)) ? limpiar(b.url, 200) : `${SITIO(env)}/ingresar.html`;
    const tipo = nueva ? "restablecer" : "invitacion";
    const enlace = await crearEnlace(env, correo, tipo, base);
    let correoEnviado = false, motivo = "";
    if (b.enviar) {
      const { asunto, text, html } = correoEnlace({ nombre: u.nombre, correo, enlace, tipo });
      const env1 = await enviarCorreo(env, { to: correo, subject: asunto, text, html, reply_to: "hola@gotyx.cl" });
      correoEnviado = env1.ok; motivo = env1.motivo;
    }
    return json({ correo, enlace, tipo, correoEnviado, motivo }, 200, cors);
  }
  if (ruta === "/admin/usuarios/estado" && req.method === "POST") {
    const b = await cuerpo(req);
    const correo = normalizarCorreo(b?.correo);
    const u = await env.DATOS.get(`usuario:${correo}`, "json");
    if (!u) return json({ error: "No existe." }, 404, cors);
    u.activo = !!b.activo;
    await env.DATOS.put(`usuario:${correo}`, JSON.stringify(u));
    return json({ ok: true }, 200, cors);
  }
  if (ruta === "/admin/demos/borrar" && req.method === "POST") {
    const b = await cuerpo(req);
    await env.DATOS.delete(`demo:${limpiar(b?.id, 40)}`);
    return json({ ok: true }, 200, cors);
  }
  if (ruta === "/admin/usuarios/borrar" && req.method === "POST") {
    const b = await cuerpo(req);
    await env.DATOS.delete(`usuario:${normalizarCorreo(b?.correo)}`);
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "Ruta desconocida." }, 404, cors);
}

// ---------- enrutador ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = cabecerasCors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Max-Age": "86400" } });
    const ruta = url.pathname;
    if (ruta === "/") return json({ servicio: "gotyx", rutas: ["/cop/{tesela}", "/wc/{tesela}", "/demo", "/auth/*"] }, 200, cors);

    const m = ruta.match(/^\/(cop|wc)\/([^/]+)$/);
    if (m) {
      const fuente = FUENTES[m[1]];
      if (!fuente.re.test(m[2])) return new Response("no encontrado", { status: 404, headers: cors });
      return datos(req, env, cors, fuente, m[2]);
    }
    if (!env.DATOS) return json({ error: "Almacenamiento no configurado." }, 503, cors);
    try {
      if (ruta === "/demo" && req.method === "POST") return await demo(req, env, cors);
      if (ruta === "/auth/login" && req.method === "POST") return await login(req, env, cors);
      if (ruta === "/auth/logout" && req.method === "POST") return await logout(req, env, cors);
      if (ruta === "/auth/yo" && req.method === "GET") return await yo(req, env, cors);
      if (ruta === "/auth/enlace" && req.method === "POST") return await verEnlace(req, env, cors);
      if (ruta === "/auth/definir" && req.method === "POST") return await definirClave(req, env, cors);
      if (ruta === "/auth/recuperar" && req.method === "POST") return await recuperar(req, env, cors);
      if (ruta.startsWith("/admin/")) return await admin(req, env, cors, ruta);
    } catch (e) {
      return json({ error: "Error interno." }, 500, cors);
    }
    return json({ error: "no encontrado" }, 404, cors);
  },
};
