"""Prueba 3: ¿qué ve Gotyx cuando el usuario dibuja un predio (no la cuenca completa) junto a un río?

En cada estación válida se dibuja un cuadrado de LADO km centrado en la estación y se corre el mismo motor
(apertura de pozas config 1, suelo C). Se registra: área aportante que el modelo ve en el río (vs. la cuenca real),
caudal en el río (vs. el observado), si la app marca el río como «externo» (aviso al usuario) y el caudal
máximo que mostraría la app (qVis, que excluye ríos externos).
Uso: python predios.py 2 5      → data_build/validacion/predios.jsonl
"""
import asyncio, json, math, sys
from playwright.async_api import async_playwright
import correr_modelo as cm
from comun import SAL

ABRIR = {"radio": 20, "alto": 15}
import os
CON_ENTRADAS = os.environ.get("ENTRADAS", "") == "1"


def cuadrado(lon, lat, lado_km):
    dy = lado_km / 2 / 111.32
    dx = dy / math.cos(math.radians(lat))
    return [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]


async def main():
    lados = [float(x) for x in sys.argv[1:]] or [2, 5]
    obs = {o["id"]: o for o in json.load(open(SAL / "observado.json", encoding="utf-8"))}
    # cuencas válidas en la corrida completa (salida coincide con la estación)
    validas = []
    for l in open(SAL / "modelo_abrir_20_15.jsonl", encoding="utf-8"):
        m = json.loads(l)
        if m.get("ok") and 0.8 <= m["areaSalida_km2"] / obs[m["id"]]["area_km2"] <= 1.2:
            validas.append((m["id"], m))
    sal = SAL / ("predios_entradas.jsonl" if CON_ENTRADAS else "predios.jsonl")
    cm.PUERTO = 8792  # la corrida de suelos usa el 8791
    cm.servidor()
    async with async_playwright() as p:
        nav = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await nav.new_context()
        await ctx.route("**/app/_banco.html", lambda r: r.fulfill(path=str(cm.BANCO), content_type="text/html"))
        await ctx.route("**/cop/**", cm.entregar_datos)
        await ctx.route("**/wc/**", cm.entregar_datos)
        await ctx.route("**/suelo", cm.entregar_suelo)
        await ctx.route("**/entradas", cm.entregar_entradas)
        with open(sal, "w", encoding="utf-8") as f:
            for k, (gid, completo) in enumerate(validas):
                o = obs[gid]
                # predio centrado sobre el río (la salida que encontró el modelo de cuenca completa): las coordenadas
                # de CAMELS-CL vienen redondeadas al minuto (±1 km) y a veces caen fuera del cauce
                centro = completo["salida"]
                for lado in lados:
                    pg = await ctx.new_page()
                    try:
                        await pg.goto(f"http://127.0.0.1:{cm.PUERTO}/app/_banco.html")
                        await pg.wait_for_function("window.listo === true")
                        r = await pg.evaluate("([a, e, ab, en, ar]) => correr(a, e, ['C'], ab, en, ar)",
                                              [cuadrado(*centro, lado), centro, ABRIR, CON_ENTRADAS, o["area_km2"]])
                        fila = {"id": gid, "lado_km": lado, "ok": True, "area_cuenca": o["area_km2"],
                                "area_vista": r["areaSalida_km2"], "rios_externos": r["riosExternos"], "entradas": r.get("entradas"),
                                "q_rio": {T: r["res"]["C"][T]["qEst"] for T in ("10", "100")}, "area_est_modelo": r["areaEstModelo"],
                                "q_app": {T: r["res"]["C"][T]["qVis"] for T in ("10", "100")},
                                "q_completo": {T: completo["res"]["C"][T]["qSalida"] for T in ("10", "100")},
                                "qi": {T: o["qi"][T] for T in ("10", "100")}}
                        print(f"[{k + 1}/{len(validas)}] {gid} {lado:g} km: ve {r['areaSalida_km2']:7.1f} de {o['area_km2']:6.0f} km² · "
                              f"Q10 río {fila['q_rio']['10']:7.1f} · app {fila['q_app']['10']:6.1f} · completo {fila['q_completo']['10']:7.1f} · "
                              f"obs {o['qi']['10']:7.1f} · externos {r['riosExternos'][:2]}", flush=True)
                    except Exception as e:
                        fila = {"id": gid, "lado_km": lado, "ok": False, "error": str(e)[:300]}
                        print(gid, lado, "ERROR", str(e)[:120], flush=True)
                    finally:
                        await pg.close()
                    f.write(json.dumps(fila, ensure_ascii=False) + "\n"); f.flush()
        await nav.close()

if __name__ == "__main__":
    asyncio.run(main())
