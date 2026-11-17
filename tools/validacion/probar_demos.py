"""Efecto de la apertura de pozas en los casos de la demo (Aculeo debe seguir reteniendo la laguna).
Uso: python probar_demos.py "20,15" "40,25" ...   (siempre incluye la configuración de producción)"""
import asyncio, sys
from playwright.async_api import async_playwright
import correr_modelo as cm

DEMOS = {
    "macul": [[-70.528, -33.47], [-70.46, -33.468], [-70.458, -33.53], [-70.53, -33.532], [-70.528, -33.47]],
    "aculeo": [[-70.975, -33.805], [-70.855, -33.80], [-70.85, -33.885], [-70.97, -33.89], [-70.975, -33.805]],
}

async def main():
    confs = [None] + [{"radio": int(c.split(",")[0]), "alto": float(c.split(",")[1])} for c in sys.argv[1:]]
    cm.servidor()
    async with async_playwright() as p:
        nav = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await nav.new_context()
        await ctx.route("**/app/_banco.html", lambda r: r.fulfill(path=str(cm.BANCO), content_type="text/html"))
        await ctx.route("**/cop/**", cm.entregar_datos)
        await ctx.route("**/wc/**", cm.entregar_datos)
        for caso, anillo in DEMOS.items():
            for ab in confs:
                pg = await ctx.new_page()
                await pg.goto(f"http://127.0.0.1:{cm.PUERTO}/app/_banco.html")
                await pg.wait_for_function("window.listo === true")
                r = await pg.evaluate("([a, ab]) => correr(a, [0, 0], ['C'], ab)", [anillo, ab])
                t = r["res"]["C"]["100"]
                print(f"{caso:7} abrir={str(ab):32} depresiones {r['encharca'] / 1e6:6.2f} M m³ · pozas T100 {t['enCharcos'] / 1e6:6.2f} M m³ · "
                      f"caudal visible T100 {t['qVis']:6.1f} m³/s", flush=True)
                await pg.close()
        await nav.close()

asyncio.run(main())
