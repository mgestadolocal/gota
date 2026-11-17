"""Capa nacional de cuencas aportantes (tipo StreamStats) sobre HydroSHEDS v1 15" (~450 m).

Para cada celda calcula, acumulando aguas abajo (Kahn vectorizado con numpy):
  A    área aportante (km²)
  CN   número de curva medio aguas arriba (ESA WorldCover 2021 con suelo C, misma tabla que web/app/lluvia.js)
  L    largo del recorrido más largo (km) y Z0 cota de su inicio (m) → H = Z0 − z (para el tiempo de concentración)
  CX, CY centro de gravedad de la cuenca (para leer las lluvias GPEX, igual que la app usa el centro del polígono)
Dominio: 76–66° O, 56–17° S (Chile + nacientes argentinas de los ríos del Pacífico). Se procesa en franjas de
8° de latitud con 3° de traslape a cada lado (una cuenca chilena cabe entera) y se escribe a disco (.npy).
Fuentes: HydroSHEDS v1 (Lehner et al. 2008, WWF; libre para uso comercial con atribución),
         ESA WorldCover 2021 v200 (CC BY 4.0).
Uso: python tools/cuencas_nacionales.py   → data_build/cuencas/{A,CN,L,Z0,z,CX,CY}.npy + meta.json
"""
import os, sys, time
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import from_bounds

RAIZ = Path(__file__).resolve().parents[1]
HS = RAIZ / "data_build/hydrosheds/raw"
SAL = RAIZ / "data_build/cuencas"
SAL.mkdir(parents=True, exist_ok=True)
CAJA = (-76.0, -56.0, -66.0, -17.0)
RES = 15 / 3600

# misma tabla que web/app/lluvia.js, columna C
CN_C = {10: 73, 20: 70, 30: 79, 40: 85, 50: 90, 60: 91, 70: 98, 80: 98, 90: 85, 95: 83, 100: 86}
CN_DEFECTO = 85  # sin dato de cobertura → cultivo (igual que la app)

# HydroSHEDS / ESRI D8: 1 E, 2 SE, 4 S, 8 SO, 16 O, 32 NO, 64 N, 128 NE (0 = sumidero o mar)
D8 = {1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1), 64: (-1, 0), 128: (-1, 1)}


def leer(nombre):
    with rasterio.open(HS / nombre) as s:
        w = from_bounds(*CAJA, transform=s.transform).round_offsets().round_lengths()
        return s.read(1, window=w), s.window_transform(w), s.nodata


def cobertura(h, w, tr):
    """Clase WorldCover por celda de 15" (muestreo de las vistas reducidas del COG, vía HTTP por rangos)."""
    cache = SAL / "worldcover_15s.npy"
    if cache.exists():
        return np.load(cache)
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
    clase = np.zeros((h, w), np.uint8)
    x0, y0 = tr.c, tr.f
    for la in range(-57, -16, 3):
        for lo in range(-78, -63, 3):
            n = f"ESA_WorldCover_10m_2021_v200_{'S' if la < 0 else 'N'}{abs(la):02d}{'W' if lo < 0 else 'E'}{abs(lo):03d}_Map"
            url = f"/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/{n}.tif"
            # celdas de la grilla 15" dentro de esta tesela de 3°
            c0 = max(0, int(round((lo - x0) / RES))); c1 = min(w, int(round((lo + 3 - x0) / RES)))
            r0 = max(0, int(round((y0 - (la + 3)) / RES))); r1 = min(h, int(round((y0 - la) / RES)))
            if c1 <= c0 or r1 <= r0:
                continue
            try:
                with rasterio.open(url) as s:
                    win = from_bounds(x0 + c0 * RES, y0 - r1 * RES, x0 + c1 * RES, y0 - r0 * RES, transform=s.transform)
                    a = s.read(1, window=win, out_shape=(r1 - r0, c1 - c0), resampling=rasterio.enums.Resampling.mode)
                clase[r0:r1, c0:c1] = a
                print("  cobertura", n, a.shape, flush=True)
            except rasterio.errors.RasterioIOError:
                pass  # tesela de mar
    np.save(cache, clase)
    return clase


def procesar(d, z, znd, clase, lat, lon):
    """Acumulación aguas abajo en una franja. Devuelve arreglos (h, w) float32."""
    h, w = d.shape
    n = h * w
    kx = np.cos(np.radians(lat))
    area_c = (RES * 111.32) ** 2 * kx
    cn_tab = np.full(256, CN_DEFECTO, np.float32)
    for k, v in CN_C.items():
        cn_tab[k] = v
    df = d.ravel()
    filas = np.repeat(np.arange(h, dtype=np.int32), w); cols = np.tile(np.arange(w, dtype=np.int32), h)
    rec = np.full(n, -1, np.int32)
    dist = np.zeros(n, np.float32)
    for code, (dr, dc) in D8.items():
        m = df == code
        rr, cc = filas[m] + dr, cols[m] + dc
        ok = (rr >= 0) & (rr < h) & (cc >= 0) & (cc < w)
        idx = np.nonzero(m)[0]
        rec[idx[ok]] = rr[ok] * w + cc[ok]
        ky = RES * 111.32; kxx = ky * kx[filas[idx]]
        dist[idx] = kxx if dr == 0 else (ky if dc == 0 else np.hypot(kxx, ky))
    valido = df != 255
    rec[~valido] = -1
    rec[(rec >= 0) & ~valido[np.maximum(rec, 0)]] = -1
    del filas, cols

    A = np.where(valido, np.repeat(area_c, w), 0).astype(np.float64)
    CNA = A * cn_tab[clase.ravel()]
    SX = A * np.tile(lon, h); SY = A * np.repeat(lat, w)
    L = np.zeros(n, np.float32)
    zf = z.ravel().astype(np.float32); zf[z.ravel() == znd] = np.nan
    Z0 = zf.copy()

    indeg = np.bincount(rec[rec >= 0], minlength=n).astype(np.int32)
    frente = np.nonzero(valido & (indeg == 0))[0]
    it = 0
    while len(frente):
        it += 1
        r = rec[frente]
        ok = r >= 0
        f, r = frente[ok], r[ok]
        np.add.at(A, r, A[f]); np.add.at(CNA, r, CNA[f]); np.add.at(SX, r, SX[f]); np.add.at(SY, r, SY[f])
        cand = L[f] + dist[f]
        np.maximum.at(L, r, cand)
        gana = cand >= L[r] - 1e-6
        Z0[r[gana]] = Z0[f[gana]]
        np.subtract.at(indeg, r, 1)
        u = np.unique(r)
        frente = u[indeg[u] == 0]
    sA = np.maximum(A, 1e-12)
    out = {"A": A, "CN": CNA / sA, "L": L, "Z0": Z0, "z": zf, "CX": SX / sA, "CY": SY / sA}
    return {k: v.reshape(h, w).astype(np.float32) for k, v in out.items()}, it


def main():
    import json
    t0 = time.time()
    d, tr, _ = leer("hyd_sa_dir_15s.tif")
    z, _, znd = leer("hyd_sa_dem_15s.tif")
    h, w = d.shape
    print("grilla", h, w, h * w, flush=True)
    lat = tr.f - (np.arange(h) + 0.5) * RES
    lon = tr.c + (np.arange(w) + 0.5) * RES
    clase = cobertura(h, w, tr)
    out = {k: np.lib.format.open_memmap(SAL / f"{k}.npy", mode="w+", dtype=np.float32, shape=(h, w))
           for k in ("A", "CN", "L", "Z0", "z", "CX", "CY")}
    NUCLEO, MARGEN = int(8 / RES), int(3 / RES)
    for c0 in range(0, h, NUCLEO):
        c1 = min(h, c0 + NUCLEO)
        b0, b1 = max(0, c0 - MARGEN), min(h, c1 + MARGEN)
        res, it = procesar(d[b0:b1], z[b0:b1], znd, clase[b0:b1], lat[b0:b1], lon)
        for k, v in res.items():
            out[k][c0:c1] = v[c0 - b0:c1 - b0]
        del res
        print(f"  franja {lat[c0]:.1f}..{lat[c1 - 1]:.1f}: {it} iteraciones, {time.time() - t0:.0f} s", flush=True)
    for v in out.values():
        v.flush()
    json.dump({"x0": tr.c, "y0": tr.f, "res": RES, "h": h, "w": w}, open(SAL / "meta.json", "w"))
    # control: área propia vs. área HydroSHEDS (ACA, km²) en celdas grandes
    aca, _, nd = leer("hyd_sa_aca_15s.tif")
    acaf = aca.astype(np.float32); acaf[aca == nd] = np.nan
    if np.nanmax(acaf) > 1e8:
        acaf /= 1e6
    m = (out["A"] > 100) & np.isfinite(acaf)
    rel = out["A"][m] / acaf[m]
    print(f"control área propia / ACA (celdas > 100 km²): mediana {np.median(rel):.3f}, p5 {np.percentile(rel, 5):.3f}, "
          f"p95 {np.percentile(rel, 95):.3f}")
    print(f"listo en {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
