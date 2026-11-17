"""Paso 3: compara el caudal punta de Gotyx con el observado en estaciones DGA (CAMELS-CL).

Control de calidad: la cuenca que el modelo ve en la salida debe tener ±20 % del área DGA.
Métricas por período de retorno y tipo de suelo, contra la punta instantánea estimada (Fuller) y contra el
máximo diario:
  - sesgo = mediana de Qmod/Qobs
  - dentro de x2 = % de cuencas con 0,5 <= Qmod/Qobs <= 2
  - error típico = mediana de |Qmod − Qobs| / Qobs
Salida: data_build/validacion/comparacion.csv y resumen.json
"""
import csv, json, math, sys
import numpy as np
from comun import SAL

RETS = ["2", "5", "10", "20", "50", "100"]
SUELOS = "ABCD"


def metricas(mod, obs):
    r = np.array(mod) / np.array(obs)
    r = r[np.isfinite(r) & (r > 0)]
    if not len(r):
        return None
    return {
        "n": int(len(r)),
        "sesgo": float(np.median(r)),
        "dentro_x2": float(np.mean((r >= 0.5) & (r <= 2))),
        "error_tipico": float(np.median(np.abs(r - 1))),
        "error_log": float(np.exp(np.median(np.abs(np.log(r))))),  # factor típico (1,5 = ±50 %)
    }


def main():
    obs = {o["id"]: o for o in json.load(open(SAL / "observado.json", encoding="utf-8"))}
    mod = {}
    for l in open(SAL / (sys.argv[1] if len(sys.argv) > 1 else "modelo.jsonl"), encoding="utf-8"):
        m = json.loads(l)
        mod[m["id"]] = m  # la última corrida manda
    filas, malas = [], []
    for gid, m in mod.items():
        o = obs[gid]
        if not m.get("ok"):
            malas.append((gid, o["nombre"], "error: " + m["error"][:80])); continue
        rel = m["areaSalida_km2"] / o["area_km2"]
        if not 0.8 <= rel <= 1.2:
            malas.append((gid, o["nombre"], f"área en la salida {m['areaSalida_km2']:.0f} vs DGA {o['area_km2']:.0f} km²")); continue
        f = {"id": gid, "nombre": o["nombre"], "lat": o["lat"], "lon": o["lon"], "area_km2": o["area_km2"], "anios": o["anios"],
             "nieve": o["nieve"], "bosque": o["bosque"], "pend_media": o["pend_media"], "tipo": o["tipo"],
             "rel_area": rel, "P24_100": m["lluvia"]["100"][3], "gpex_km": m["gpexDistKm"], "osm_km": m["osmKm"]}
        for T in RETS:
            f[f"qi_{T}"] = o["qi"][T]; f[f"qd_{T}"] = o["qd"][T]
            for s in SUELOS:
                f[f"m{s}_{T}"] = m["res"][s][T]["qSalida"]
            f[f"cn_C"] = m["res"]["C"]["10"]["cnMedio"]
        filas.append(f)

    with open(SAL / "comparacion.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()), delimiter=";")
        w.writeheader(); w.writerows(filas)

    res = {"n_corridas": len(mod), "n_validas": len(filas), "descartadas": malas, "global": {}, "por_area": {}, "por_zona": {}}
    for s in SUELOS:
        for T in RETS:
            res["global"][f"{s}_{T}_inst"] = metricas([f[f"m{s}_{T}"] for f in filas], [f[f"qi_{T}"] for f in filas])
            res["global"][f"{s}_{T}_diario"] = metricas([f[f"m{s}_{T}"] for f in filas], [f[f"qd_{T}"] for f in filas])
    clases_area = [(0, 100), (100, 300), (300, 700), (700, 1600)]
    zonas = [("Valparaíso–O'Higgins (32–35° S)", -35, -32), ("Maule–Ñuble (35–37° S)", -37, -35),
             ("Biobío–Araucanía (37–39,5° S)", -39.5, -37), ("Los Ríos–Los Lagos (39,5–43° S)", -43, -39.5)]
    for T in ("10", "100"):
        for a0, a1 in clases_area:
            sel = [f for f in filas if a0 <= f["area_km2"] < a1]
            res["por_area"][f"C_{T}_{a0}-{a1}"] = metricas([f[f"mC_{T}"] for f in sel], [f[f"qi_{T}"] for f in sel])
        for nom, l0, l1 in zonas:
            sel = [f for f in filas if l0 <= f["lat"] < l1]
            res["por_zona"][f"C_{T}_{nom}"] = metricas([f[f"mC_{T}"] for f in sel], [f[f"qi_{T}"] for f in sel])
    json.dump(res, open(SAL / "resumen.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"Cuencas corridas: {len(mod)} · válidas: {len(filas)} · descartadas: {len(malas)}")
    for d in malas: print("   descartada", *d)
    print("\nSuelo  T   | vs punta instantánea (Fuller)          | vs máximo diario")
    for s in SUELOS:
        for T in RETS:
            a, b = res["global"][f"{s}_{T}_inst"], res["global"][f"{s}_{T}_diario"]
            print(f"  {s}  {T:>4}  | sesgo {a['sesgo']:5.2f}  x2 {a['dentro_x2']:4.0%}  err {a['error_tipico']:4.0%}  fac {a['error_log']:4.2f} "
                  f"| sesgo {b['sesgo']:5.2f}  x2 {b['dentro_x2']:4.0%}  err {b['error_tipico']:4.0%}")
    for k in ("por_area", "por_zona"):
        print()
        for nom, a in res[k].items():
            if a: print(f"  {nom:48} n={a['n']:3d}  sesgo {a['sesgo']:5.2f}  x2 {a['dentro_x2']:4.0%}  err {a['error_tipico']:4.0%}")


if __name__ == "__main__":
    main()
