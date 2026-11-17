"""Diagnóstico de un predio con entradas: python diag_predio.py ID LADO_KM"""
import asyncio, json, sys
from playwright.async_api import async_playwright
import correr_modelo as cm
from predios import cuadrado, ABRIR
from comun import SAL

async def main():
    gid, lado = sys.argv[1], float(sys.argv[2])
    o = {x["id"]: x for x in json.load(open(SAL / "observado.json", encoding="utf-8"))}[gid]
    cm.servidor()
    async with async_playwright() as p:
        nav = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await nav.new_context()
        await ctx.route("**/app/_banco.html", lambda r: r.fulfill(path=str(cm.BANCO), content_type="text/html"))
        await ctx.route("**/cop/**", cm.entregar_datos); await ctx.route("**/wc/**", cm.entregar_datos)
        await ctx.route("**/suelo", cm.entregar_suelo)
        pg = await ctx.new_page()
        await pg.goto(f"http://127.0.0.1:{cm.PUERTO}/app/_banco.html"); await pg.wait_for_function("window.listo === true")
        r = await pg.evaluate("([a, e, ab, ar]) => correr(a, e, ['C'], ab, true, ar)", [cuadrado(o["lon"], o["lat"], lado), [o["lon"], o["lat"]], ABRIR, o["area_km2"]])
        print(o["nombre"], "estación", o["lon"], o["lat"], "área", o["area_km2"])
        print("área modelo en estación", r["areaEstModelo"], "Q10", r["res"]["C"]["10"]["qEst"], "obs", o["qi"]["10"])
        for e in r["entradas"]: print("  ", e)
        await nav.close()
asyncio.run(main())
