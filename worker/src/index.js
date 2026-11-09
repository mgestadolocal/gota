// Worker de Gotyx
// 1) Intermediario de datos: Copernicus DEM y ESA WorldCover (AWS Open Data) no envían CORS;
//    aquí se reenvían lecturas por rango. Sin sesión solo se entregan las teselas de la demo abierta.
// 2) Solicitudes de demo (POST /demo): se guardan en KV y, si hay clave de Resend, avisan por correo.
// 3) Cuentas por invitación (POST /auth/login, /auth/logout, GET /auth/yo) con claves PBKDF2 y sesiones en KV.
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
  if (env.RESEND_API_KEY && env.AVISO_CORREO) {
    const texto = `Nueva solicitud de demo en Gotyx\n\nNombre: ${d.nombre}\nEmpresa: ${d.empresa}\nRubro: ${d.rubro}\nCorreo: ${d.correo}\nTeléfono: ${d.telefono || "—"}\n\nTerreno o zona:\n${d.mensaje || "—"}\n\nFecha: ${d.fecha}`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.AVISO_DESDE || "Gotyx <onboarding@resend.dev>", to: [env.AVISO_CORREO], reply_to: d.correo, subject: `Demo Gotyx: ${d.empresa} (${d.rubro})`, text: texto }),
      });
    } catch { /* la solicitud ya quedó guardada */ }
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
  const token = azar(32);
  const exp = Date.now() + SESION_DIAS * 86400e3;
  await env.DATOS.put(`sesion:${await sha256(token)}`, JSON.stringify({ correo, exp }), { expirationTtl: SESION_DIAS * 86400 });
  u.ultimoIngreso = new Date().toISOString();
  await env.DATOS.put(`usuario:${correo}`, JSON.stringify(u));
  return json({ token, nombre: u.nombre, empresa: u.empresa }, 200, cors);
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
    const clave = claveNueva();
    const sal = azar(16);
    const u = {
      ...(previo || { creado: new Date().toISOString(), activo: true }),
      nombre: limpiar(b.nombre, 120) || previo?.nombre || "",
      empresa: limpiar(b.empresa, 160) || previo?.empresa || "",
      sal, iter: ITER, hash: await pbkdf2(clave, sal),
    };
    await env.DATOS.put(`usuario:${correo}`, JSON.stringify(u));
    return json({ correo, clave }, 200, cors);
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
      if (ruta.startsWith("/admin/")) return await admin(req, env, cors, ruta);
    } catch (e) {
      return json({ error: "Error interno." }, 500, cors);
    }
    return json({ error: "no encontrado" }, 404, cors);
  },
};
