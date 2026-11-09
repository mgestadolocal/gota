// Intermediario de Cota: los buckets públicos de Copernicus DEM y ESA WorldCover (AWS Open Data)
// responden lecturas por rango pero no envían CORS, así que el navegador no puede leerlos directo.
// Este Worker solo reenvía lecturas por rango de sus teselas y agrega CORS.

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
      return new Response(JSON.stringify({ servicio: "gota.ai", rutas: ["/cop/{tesela}", "/wc/{tesela}"] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const m = url.pathname.match(/^\/(cop|wc)\/([^/]+)$/);
    const fuente = m && FUENTES[m[1]];
    if (!fuente || !fuente.re.test(m[2])) return new Response("no encontrado", { status: 404, headers: cors });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("método", { status: 405, headers: cors });

    // Solo lecturas parciales: evita que alguien use el Worker para bajar teselas completas (40 MB c/u).
    const rango = req.headers.get("Range");
    if (req.method === "GET" && (!rango || !RANGO.test(rango))) {
      return new Response("se requiere un único rango de bytes", { status: 416, headers: cors });
    }

    const arriba = await fetch(fuente.url(m[2]), {
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
