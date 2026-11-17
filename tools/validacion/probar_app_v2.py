"""Prueba la app real (web/app) en local con y sin ?v2=1 en las dos demos: errores, nota de ríos y caudales."""
import asyncio
from playwright.async_api import async_playwright
import correr_modelo as cm

async def main():
    cm.servidor()
    async with async_playwright() as p:
        nav = await p.chromium.launch(channel="chrome", headless=True)
        for caso in ("macul", "aculeo"):
            for v2 in ("", "&v2=1"):
                pg = await nav.new_page(viewport={"width": 1400, "height": 900})
                errores = []
                pg.on("pageerror", lambda e: errores.append(str(e)))
                pg.on("console", lambda m: errores.append(m.text) if m.type == "error" else None)
                await pg.goto(f"http://127.0.0.1:{cm.PUERTO}/app/?demo={caso}{v2}", wait_until="load")
                try:
                    await pg.wait_for_function("document.getElementById('t-lluvia').checked", timeout=180000)
                except Exception as e:
                    errores.append("timeout " + str(e)[:80])
                await pg.wait_for_timeout(3000)
                nota = await pg.evaluate("() => document.getElementById('nota-osm')?.innerText || ''")
                res = await pg.evaluate("() => document.getElementById('res-tormenta')?.innerText || ''")
                await pg.screenshot(path=str(cm.SAL / f"app_{caso}{'_v2' if v2 else ''}.png"))
                print(f"== {caso} {'v2' if v2 else 'actual'} · errores: {[e[:120] for e in errores if 'favicon' not in e][:4]}")
                print("   nota:", nota[:400].replace("\n", " "))
                print("   tormenta:", res[:500].replace("\n", " | "))
                await pg.close()
        await nav.close()

asyncio.run(main())
