"""Paso 1: cuencas candidatas y caudales de crecida observados (estaciones DGA en CAMELS-CL).

Filtros: sin embalse grande, nieve < 15 % de la lluvia, 5–1.500 km², entre 32° y 43° S, sin desagüe de lago,
>= 15 años hidrológicos (abril–marzo) con >= 330 días medidos.
Máximo anual del caudal MEDIO DIARIO → GEV por L-momentos (Hosking 1990) → Q_T diario.
Punta instantánea estimada con Fuller (1914): Qi/Qd = 1 + 2,66·A^-0,3 (A km²). Es una aproximación:
CAMELS-CL no trae caudales instantáneos.
Salida: data_build/validacion/observado.json
"""
import json, math
import numpy as np
from comun import atributos, caudales, SAL

T_LIST = [2, 5, 10, 20, 50, 100]  # los mismos períodos de la app


def lmom(x):
    x = np.sort(np.asarray(x, float)); n = len(x); j = np.arange(n)
    b0 = x.mean()
    b1 = np.sum(j / (n - 1) * x) / n
    b2 = np.sum(j * (j - 1) / ((n - 1) * (n - 2)) * x) / n
    return b0, 2 * b1 - b0, 6 * b2 - 6 * b1 + b0  # l1, l2, l3


def gev_lmom(x):
    l1, l2, l3 = lmom(x); t3 = l3 / l2
    c = 2 / (3 + t3) - math.log(2) / math.log(3)
    k = 7.8590 * c + 2.9554 * c * c
    g = math.gamma(1 + k)
    a = l2 * k / ((1 - 2 ** -k) * g)
    u = l1 - a * (1 - g) / k
    return u, a, k


def gev_q(par, T):
    u, a, k = par; y = -math.log(1 - 1 / T)
    return u + a / k * (1 - y ** k)


def main():
    at = atributos(); fechas, ids, q = caudales()
    anio = fechas.astype("datetime64[Y]").astype(int) + 1970
    mes = fechas.astype("datetime64[M]").astype(int) % 12 + 1
    ahid = np.where(mes >= 4, anio, anio - 1)  # año hidrológico abril–marzo
    sal = []
    for c, g in enumerate(ids):
        v = at[g]
        nombre = v["gauge_name"]
        if not (v["big_dam"] == 0 and (v["frac_snow_cr2met"] if v["frac_snow_cr2met"] is not None else 1) < 0.15
                and 5 <= v["area"] <= 1500 and -43 <= v["gauge_lat"] <= -32):
            continue
        if any(s in nombre.lower() for s in ("desague", "desag", "lago", "embalse", "captacion", "canal")):
            continue
        maxs = []
        for y in np.unique(ahid):
            sel = ahid == y; s = q[sel, c]
            if np.isfinite(s).sum() >= 330:
                maxs.append((int(y), float(np.nanmax(s))))
        if len(maxs) < 15:
            continue
        am = np.array([m for _, m in maxs])
        par = gev_lmom(am)
        fuller = 1 + 2.66 * v["area"] ** -0.3
        sal.append({
            "id": g, "nombre": nombre, "lat": v["gauge_lat"], "lon": v["gauge_lon"], "area_km2": v["area"],
            "elev_media": v["elev_mean"], "pend_media": v["slope_mean"], "nieve": v["frac_snow_cr2met"],
            "interv": v["interv_degree"], "bosque": v["forest_frac"], "cultivo": v["crop_frac"], "tipo": v["location_type"],
            "p_media_mm_d": v["p_mean_cr2met"], "anios": len(am), "periodo": [maxs[0][0], maxs[-1][0]],
            "max_anuales": maxs, "gev": par, "fuller": fuller,
            "qd": {T: gev_q(par, T) for T in T_LIST},
            "qi": {T: gev_q(par, T) * fuller for T in T_LIST},
        })
    json.dump(sal, open(SAL / "observado.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(len(sal), "cuencas")
    for s in sal:
        print(f'{s["id"]:>9} {s["nombre"][:34]:34} {s["area_km2"]:7.0f} km² {s["anios"]:3d} años  Qd10={s["qd"][10]:7.1f}  Qi10={s["qi"][10]:7.1f}  Qi100={s["qi"][100]:7.1f}')


if __name__ == "__main__":
    main()
