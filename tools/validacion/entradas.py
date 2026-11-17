"""Ríos que entran a una grilla local desde fuera, según la capa nacional (HydroSHEDS 15").

entradas(georef, w, h, area_min_km2) → lista de dicts {lon, lat, area_km2, cn, L_km, z0}
Una entrada es una celda de 15" FUERA de la caja de la grilla cuyo receptor D8 cae DENTRO de la caja.
Su área aportante, CN medio y recorrido más largo vienen de la capa precalculada.
"""
import json, math
import numpy as np
import rasterio
from rasterio.windows import Window
from comun import RAIZ

CU = RAIZ / "data_build/cuencas"
DIR = RAIZ / "data_build/hydrosheds/raw/hyd_sa_dir_15s.tif"
D8 = {1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1), 64: (-1, 0), 128: (-1, 1)}
_c = {}


def _capa():
    if not _c:
        m = json.load(open(CU / "meta.json"))
        _c.update(m)
        _c["v"] = {k: np.load(CU / f"{k}.npy", mmap_mode="r") for k in ("A", "CN", "L", "Z0")}
        _c["dir"] = rasterio.open(DIR)
    return _c


def entradas(g, w, h, area_min_km2=1.0):
    c = _capa()
    x0, y0, res = c["x0"], c["y0"], c["res"]
    lon0, lon1 = g["x0"], g["x0"] + w * g["rx"]
    lat1, lat0 = g["y0"], g["y0"] - h * g["ry"]
    dentro = lambda lo, la: lon0 <= lo <= lon1 and lat0 <= la <= lat1
    # celdas 15" que cubren la caja + 1 celda
    c0 = int((lon0 - x0) / res) - 1; c1 = int((lon1 - x0) / res) + 2
    r0 = int((y0 - lat1) / res) - 1; r1 = int((y0 - lat0) / res) + 2
    ds = c["dir"]
    # desfase entre la capa (recortada a CAJA) y el GeoTIFF continental
    oc = int(round((x0 - ds.transform.c) / res)); orr = int(round((ds.transform.f - y0) / res))
    # ventana amplia (para seguir los ríos aguas abajo y descartar reentradas)
    M = 60
    W0c, W0r = c0 - M, r0 - M
    d = ds.read(1, window=Window(W0c + oc, W0r + orr, c1 - c0 + 2 * M, r1 - r0 + 2 * M), boundless=True, fill_value=0)
    dget = lambda r, cc: int(d[r - W0r, cc - W0c]) if 0 <= r - W0r < d.shape[0] and 0 <= cc - W0c < d.shape[1] else 0
    out = []
    for r in range(r0, r1):
        for cc in range(c0, c1):
            la, lo = y0 - (r + 0.5) * res, x0 + (cc + 0.5) * res
            if dentro(lo, la):
                continue
            code = dget(r, cc)
            if code not in D8:
                continue
            dr, dc = D8[code]
            la2, lo2 = y0 - (r + dr + 0.5) * res, x0 + (cc + dc + 0.5) * res
            if not dentro(lo2, la2):
                continue
            A = float(c["v"]["A"][r, cc])
            if A < area_min_km2:
                continue
            out.append({"_rc": (r, cc), "lon": lo2, "lat": la2, "area_km2": A, "cn": float(c["v"]["CN"][r, cc]),
                        "L_km": float(c["v"]["L"][r, cc]) + res * 111.32 * (1 if dr == 0 or dc == 0 else math.sqrt(2)),
                        "z0": float(c["v"]["Z0"][r, cc])})
    # un río que sale y vuelve a entrar se contaría dos veces: se descarta la entrada cuyo recorrido aguas
    # abajo pasa por otra celda de entrada (esa ya trae toda su cuenca)
    claves = {e["_rc"] for e in out}
    final = []
    for e in out:
        r, cc = e["_rc"]
        repetida = False
        for _ in range(2000):
            code = dget(r, cc)
            if code not in D8:
                break
            r, cc = r + D8[code][0], cc + D8[code][1]
            if (r, cc) in claves:
                repetida = True
                break
        if not repetida:
            final.append({k: v for k, v in e.items() if k != "_rc"})
    return final
