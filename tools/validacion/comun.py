"""Lectura de CAMELS-CL (Alvarez-Garreton et al. 2018, CC BY 4.0, doi:10.1594/PANGAEA.894885)."""
from pathlib import Path
import numpy as np

RAIZ = Path(__file__).resolve().parents[2]
CAM = RAIZ / "data_build" / "camels_cl" / "raw"
SAL = RAIZ / "data_build" / "validacion"
SAL.mkdir(parents=True, exist_ok=True)


def _limpia(s):
    return s.strip().strip('"').strip()


def atributos():
    """dict gauge_id -> dict atributo -> valor (float si se puede)."""
    filas = [l.rstrip("\n").split("\t") for l in open(CAM / "1_CAMELScl_attributes.txt", encoding="utf-8")]
    ids = [_limpia(x) for x in filas[0][1:]]
    out = {g: {} for g in ids}
    for f in filas:
        k = _limpia(f[0])
        for g, v in zip(ids, f[1:]):
            v = _limpia(v)
            try:
                out[g][k] = float(v)
            except ValueError:
                out[g][k] = None if v in ("NA", "") else v
    return out


def caudales():
    """(fechas np.datetime64[D], ids, matriz [dias, cuencas] con NaN)."""
    cache = SAL / "caudal_m3s.npz"
    if cache.exists():
        d = np.load(cache, allow_pickle=False)
        return d["fechas"], list(d["ids"]), d["q"]
    lin = open(CAM / "2_CAMELScl_streamflow_m3s.txt", encoding="utf-8").read().splitlines()
    ids = [_limpia(x) for x in lin[0].split("\t")[1:]]
    fechas, q = [], np.full((len(lin) - 1, len(ids)), np.nan, dtype=np.float32)
    for r, l in enumerate(lin[1:]):
        p = l.split("\t")
        fechas.append(_limpia(p[0]))
        for c, v in enumerate(p[1:]):
            v = _limpia(v)
            if v:
                q[r, c] = float(v)
    fechas = np.array(fechas, dtype="datetime64[D]")
    np.savez_compressed(cache, fechas=fechas, ids=np.array(ids), q=q)
    return fechas, ids, q
