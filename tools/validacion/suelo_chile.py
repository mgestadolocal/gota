"""Grupos hidrológicos de suelo HYSOGs250m (Ross et al. 2018, ORNL DAAC, doi:10.3334/ORNLDAAC/1566).
Códigos: 1 A, 2 B, 3 C, 4 D, 11 A/D, 12 B/D, 13 C/D, 14 D/D (dual = drenado / sin drenar).
- python suelo_chile.py RUTA_GLOBAL.tif  → recorta a Chile en data_build/validacion/hysogs_chile.tif
- muestrear(georef, w, h) → np.uint8 (w*h) con el código en el centro de cada celda (vecino más cercano)
"""
import sys
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from comun import SAL

CHILE = SAL / "hysogs_chile.tif"
CAJA = (-76.5, -56.5, -66.0, -17.0)
_ds = None


def recortar(ruta):
    with rasterio.open(ruta) as src:
        print(src.profile)
        win = from_bounds(*CAJA, transform=src.transform).round_offsets().round_lengths()
        a = src.read(1, window=win)
        perfil = src.profile.copy()
        perfil.update(width=a.shape[1], height=a.shape[0], transform=src.window_transform(win), compress="deflate", tiled=True,
                      blockxsize=512, blockysize=512, BIGTIFF="NO")
        with rasterio.open(CHILE, "w", **perfil) as dst:
            dst.write(a, 1)
    v, c = np.unique(a, return_counts=True)
    print({int(x): int(y) for x, y in zip(v, c)})


def muestrear(g, w, h):
    global _ds
    if _ds is None:
        _ds = rasterio.open(CHILE)
        _ds._arr = _ds.read(1)
    x = g["x0"] + (np.arange(w) + 0.5) * g["rx"]
    y = g["y0"] - (np.arange(h) + 0.5) * g["ry"]
    inv = ~_ds.transform
    cols = np.floor((x - _ds.transform.c) / _ds.transform.a).astype(int)
    rows = np.floor((y - _ds.transform.f) / _ds.transform.e).astype(int)
    cols = np.clip(cols, 0, _ds.width - 1); rows = np.clip(rows, 0, _ds.height - 1)
    return _ds._arr[rows[:, None], cols[None, :]].astype(np.uint8).ravel()


if __name__ == "__main__":
    recortar(sys.argv[1])
