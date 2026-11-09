"""Recorta GPEX (Gründemann et al. 2021, CC BY 4.0) a Chile continental y lo guarda en teselas de 1°×1°.

Uso: .venv/Scripts/python tools/gpex_chile.py data_build/GPEX_extremes.nc web/data/gpex [estimador]

Cada tesela {S34W071}.bin tiene 10×10 celdas de 0,1° (fila 0 = norte). Cada celda trae
len(RETORNOS)·len(DURACIONES) valores Uint16 little-endian en décimas de mm (orden: retorno, luego duración).
0xFFFF = sin dato (mar).
"""
import sys
from pathlib import Path
import numpy as np
import h5py

DURACIONES = [3, 6, 12, 24, 48, 72]
RETORNOS = [2, 5, 10, 20, 50, 100]
LAT_N, LAT_S = -17.0, -56.0   # Chile continental
LON_O, LON_E = -76.0, -66.0

origen, destino = Path(sys.argv[1]), Path(sys.argv[2])
estimador = sys.argv[3] if len(sys.argv) > 3 else "gev_estimate"
destino.mkdir(parents=True, exist_ok=True)

with h5py.File(origen, "r") as f:
    lat = f["lat"][:]
    lon = f["lon"][:]
    dur = list(f["dur"][:].astype(int))
    tr = list(np.round(f["tr"][:]).astype(int))
    var = f[estimador]
    print(estimador, var.shape, var.dims and [d.label for d in var.dims], "dur", dur, "tr", tr)
    ilat = np.where((lat <= LAT_N) & (lat >= LAT_S))[0]
    ilon = np.where((lon >= LON_O) & (lon <= LON_E))[0]
    # orden de ejes del archivo: se detecta por tamaño
    shape = var.shape
    ejes = {}
    for k, n in enumerate(shape):
        if n == len(lat): ejes["lat"] = k
        elif n == len(lon): ejes["lon"] = k
        elif n == len(dur): ejes["dur"] = k
        elif n == len(tr): ejes["tr"] = k
    print("ejes", ejes)
    sl = [slice(None)] * len(shape)
    sl[ejes["lat"]] = slice(ilat.min(), ilat.max() + 1)
    sl[ejes["lon"]] = slice(ilon.min(), ilon.max() + 1)
    bloque = var[tuple(sl)].astype("float64")
    fill = var.attrs.get("_FillValue")
    # reordenar a (lat, lon, tr, dur)
    orden = [ejes["lat"], ejes["lon"], ejes["tr"], ejes["dur"]]
    bloque = np.transpose(bloque, orden)
    if fill is not None:
        bloque[bloque == float(np.asarray(fill).ravel()[0])] = np.nan
    lat_c = lat[ilat.min(): ilat.max() + 1]
    lon_c = lon[ilon.min(): ilon.max() + 1]

kt = [tr.index(t) for t in RETORNOS]
kd = [dur.index(d) for d in DURACIONES]
bloque = bloque[:, :, kt, :][:, :, :, kd]          # (lat, lon, 6, 6)
print("rango (mm):", np.nanmin(bloque), np.nanmax(bloque))

nt = 0
for la in range(int(np.floor(LAT_S)), int(np.floor(LAT_N)) + 1):
    for lo in range(int(np.floor(LON_O)), int(np.floor(LON_E)) + 1):
        out = np.full((10, 10, len(RETORNOS) * len(DURACIONES)), 0xFFFF, dtype="<u2")
        hay = False
        for r in range(10):
            cy = la + 1 - 0.05 - 0.1 * r
            i = np.argmin(np.abs(lat_c - cy))
            if abs(lat_c[i] - cy) > 0.01: continue
            for c in range(10):
                cx = lo + 0.05 + 0.1 * c
                j = np.argmin(np.abs(lon_c - cx))
                if abs(lon_c[j] - cx) > 0.01: continue
                v = bloque[i, j].ravel()
                if np.all(np.isfinite(v)) and np.all(v > 0):
                    out[r, c] = np.clip(np.round(v * 10), 0, 65534)
                    hay = True
        if hay:
            n = f"{'S' if la < 0 else 'N'}{abs(la):02d}{'W' if lo < 0 else 'E'}{abs(lo):03d}"
            (destino / f"{n}.bin").write_bytes(out.tobytes())
            nt += 1
print("teselas:", nt)
