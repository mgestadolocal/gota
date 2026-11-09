// Intermediario de Cota: el bucket público de Copernicus DEM (AWS Open Data) responde
// lecturas por rango pero no envía CORS, así que el navegador no puede leerlo directo.
// Este Worker solo reenvía lecturas por rango de teselas GLO-30 y agrega CORS.

const BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com";
const TESELA = /^Copernicus_DSM_COG_10_[NS]\d{2}_00_[EW]\d{3}_00_DEM$/;
const RANGO = /^bytes=\d{1,10}-\d{0,10}$/;

function cabecerasCors(req, env) {
  const origen = req.headers.get("Origin") || "";
  const permitidos = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const permitido = permitidos.includes("*") ? "*" : permitidos.includes(origen) ? origen : permitidos[0] || "";
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, ETag",
    Vary: "Origin",
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = cabecerasCors(req, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Max-Age": "86400" } });
    }
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ servicio: "cota", rutas: ["/cop/{tesela}"] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const m = url.pathname.match(/^\/cop\/([^/]+)$/);
    if (!m || !TESELA.test(m[1])) return new Response("no encontrado", { status: 404, headers: cors });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("método", { status: 405, headers: cors });

    // Solo lecturas parciales: evita que alguien use el Worker para bajar teselas completas (40 MB c/u).
    const rango = req.headers.get("Range");
    if (req.method === "GET" && (!rango || !RANGO.test(rango))) {
      return new Response("se requiere un único rango de bytes", { status: 416, headers: cors });
    }

    const arriba = await fetch(`${BUCKET}/${m[1]}/${m[1]}.tif`, {
      method: req.method,
      headers: rango ? { Range: rango } : {},
    });

    const h = new Headers(cors);
    for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
      const v = arriba.headers.get(k);
      if (v) h.set(k, v);
    }
    // Las teselas de Copernicus no cambian: que el navegador las guarde.
    h.set("Cache-Control", "public, max-age=2592000, immutable");

    // Teselas inexistentes (mar abierto) → 404 limpio.
    if (arriba.status === 404 || arriba.status === 403) {
      return new Response("sin datos para esa tesela", { status: 404, headers: h });
    }
    return new Response(arriba.body, { status: arriba.status, headers: h });
  },
};
