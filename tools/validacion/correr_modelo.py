"""Paso 2: corre el motor de Gotyx (el mismo código de web/app) en cada cuenca candidata.

Sirve web/ en local, entrega tools/validacion/banco.html como /app/_banco.html y responde /cop/ y /wc/
leyendo directo de los buckets abiertos de AWS (con caché en disco), sin pasar por el Worker de producción.

Uso: python correr_modelo.py [id1 id2 ...]      (sin ids: todas las de observado.json; salta las ya hechas)
Salida: data_build/validacion/modelo.jsonl (una línea por cuenca)
Requiere el venv de Videos/gota_linkedin (playwright, pyshp, shapely).
"""
import asyncio, functools, hashlib, http.server, json, sys, threading, time, urllib.error, urllib.request
from pathlib import Path

import shapefile
from shapely.geometry import shape
from playwright.async_api import async_playwright

from comun import RAIZ, SAL

WEB = RAIZ / "web"
BANCO = Path(__file__).with_name("banco.html")
SHP = RAIZ / "data_build/camels_cl/raw/CAMELScl_catchment_boundaries/catchments_camels_cl_v1.3.shp"
CACHE = SAL / "cache_rangos"
CACHE.mkdir(exist_ok=True)
# configuración de apertura de pozas por variable de entorno: ABRIR="radio,alto" (vacío = como producción)
import os
_AB = os.environ.get("ABRIR", "").strip()
ABRIR = {"radio": int(_AB.split(",")[0]), "alto": float(_AB.split(",")[1])} if _AB else None
SALIDA = SAL / (os.environ.get("SALIDA") or (f"modelo_abrir_{_AB.replace(',', '_')}.jsonl" if _AB else "modelo.jsonl"))
PUERTO = 8791
FUENTES = {
    "cop": lambda n: f"https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/{n}/{n}.tif",
    "wc": lambda n: f"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/{n}.tif",
}


def servidor():
    class Silencioso(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    h = functools.partial(Silencioso, directory=str(WEB))
    s = http.server.ThreadingHTTPServer(("127.0.0.1", PUERTO), h)
    threading.Thread(target=s.serve_forever, daemon=True).start()


def leer_rango(url, rango):
    k = CACHE / hashlib.sha1(f"{url}|{rango}".encode()).hexdigest()
    if k.exists():
        b = k.read_bytes()
        st, total, cuerpo = int(b[:3]), b[4:b.index(b"\n")].decode(), b[b.index(b"\n") + 1:]
        return st, total, cuerpo
    for intento in range(4):
        try:
            req = urllib.request.Request(url, headers={"Range": rango} if rango else {})
            with urllib.request.urlopen(req, timeout=60) as r:
                cuerpo, st, total = r.read(), r.status, r.headers.get("Content-Range", "")
            break
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                st, total, cuerpo = 404, "", b""
                break
            if intento == 3: raise
        except Exception:
            if intento == 3: raise
            time.sleep(2 * (intento + 1))
    k.write_bytes(f"{st:03d} {total}\n".encode() + cuerpo)
    return st, total, cuerpo


async def entregar_datos(route):
    req = route.request
    partes = req.url.split("?")[0].rstrip("/").split("/")
    fuente, nombre = partes[-2], partes[-1]
    rango = (await req.all_headers()).get("range", "")
    st, total, cuerpo = await asyncio.to_thread(leer_rango, FUENTES[fuente](nombre), rango)
    if st == 404:
        return await route.fulfill(status=404, body="sin datos")
    h = {"Content-Type": "image/tiff", "Accept-Ranges": "bytes"}
    if total: h["Content-Range"] = total
    await route.fulfill(status=st, headers=h, body=cuerpo)


async def entregar_suelo(route):
    import suelo_chile
    g = json.loads(route.request.post_data)
    if not suelo_chile.CHILE.exists():
        return await route.fulfill(status=404, body="sin mapa de suelos")
    a = await asyncio.to_thread(suelo_chile.muestrear, g, g["w"], g["h"])
    await route.fulfill(status=200, body=a.tobytes(), headers={"Content-Type": "application/octet-stream"})


async def entregar_entradas(route):
    import entradas as en
    g = json.loads(route.request.post_data)
    lista = await asyncio.to_thread(en.entradas, g, g["w"], g["h"])
    await route.fulfill(status=200, body=json.dumps(lista), headers={"Content-Type": "application/json"})


def poligonos():
    r = shapefile.Reader(str(SHP), encoding="latin-1")
    out = {}
    for sr in r.iterShapeRecords():
        g = shape(sr.shape.__geo_interface__)
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda p: p.area)
        g = g.buffer(0).simplify(0.0003, preserve_topology=True)  # ~30 m, una celda de Copernicus
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda p: p.area)
        out[str(sr.record["gauge_id"])] = [list(map(float, p)) for p in g.exterior.coords]
    return out


async def main():
    obs = {o["id"]: o for o in json.load(open(SAL / "observado.json", encoding="utf-8"))}
    hechos = set()
    if SALIDA.exists():
        for l in open(SALIDA, encoding="utf-8"):
            hechos.add(json.loads(l)["id"])
    ids = sys.argv[1:] or [i for i in obs if i not in hechos]
    pol = poligonos()
    servidor()
    async with async_playwright() as p:
        nav = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await nav.new_context()
        await ctx.route("**/app/_banco.html", lambda r: r.fulfill(path=str(BANCO), content_type="text/html"))
        await ctx.route("**/cop/**", entregar_datos)
        await ctx.route("**/wc/**", entregar_datos)
        await ctx.route("**/suelo", entregar_suelo)
        await ctx.route("**/entradas", entregar_entradas)
        for k, gid in enumerate(ids):
            o = obs[gid]
            t0 = time.time()
            pg = await ctx.new_page()
            errores = []
            pg.on("pageerror", lambda e: errores.append(str(e)))
            try:
                await pg.goto(f"http://127.0.0.1:{PUERTO}/app/_banco.html", wait_until="load")
                await pg.wait_for_function("window.listo === true", timeout=60000)
                r = await pg.evaluate("([a, e, ab]) => correr(a, e, ['A', 'B', 'C', 'D', 'M', 'N'], ab)", [pol[gid], [o["lon"], o["lat"]], ABRIR])
                fila = {"id": gid, "ok": True, **r}
                print(f"[{k + 1}/{len(ids)}] {gid} {o['nombre'][:30]:30} {o['area_km2']:6.0f} km² → salida {r['areaSalida_km2']:6.0f} km²  "
                      f"Q10(C)={r['res']['C']['10']['qSalida']:8.1f} obs Qi10={o['qi']['10']:8.1f}  {time.time() - t0:5.0f} s", flush=True)
            except Exception as e:
                fila = {"id": gid, "ok": False, "error": str(e)[:500], "errores": errores[:3]}
                print(f"[{k + 1}/{len(ids)}] {gid} ERROR {str(e)[:160]}", flush=True)
            finally:
                await pg.close()
            with open(SALIDA, "a", encoding="utf-8") as f:
                f.write(json.dumps(fila, ensure_ascii=False) + "\n")
        await nav.close()


if __name__ == "__main__":
    asyncio.run(main())
