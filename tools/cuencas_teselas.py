"""Exporta la capa nacional de cuencas (tools/cuencas_nacionales.py) a teselas de 1° para la app.

web/app/data/cuencas/{S34W071}.bin — solo celdas de 15" con área aportante >= 1 km² (los cauces).
Formato (little endian, estructura de arreglos para que los Float32 queden alineados):
  uint32 N
  float32 A[N]   área aportante (km²)
  float32 L[N]   recorrido más largo aguas arriba (km)
  int16   Z0[N]  cota del inicio de ese recorrido (m)
  uint8   fila[N], col[N] dentro de la tesela (0–239, fila 0 = norte)
  uint8   dir[N] dirección D8 de HydroSHEDS (1 E, 2 SE, 4 S, 8 SO, 16 O, 32 NO, 64 N, 128 NE)
  uint8   cn[N]  número de curva medio aguas arriba (suelo C, WorldCover)
Fuentes: HydroSHEDS v1 (WWF, Lehner et al. 2008; uso comercial permitido con atribución), ESA WorldCover 2021.
"""
import json
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import from_bounds

RAIZ = Path(__file__).resolve().parents[1]
CU = RAIZ / "data_build/cuencas"
SAL = RAIZ / "web/app/data/cuencas"
SAL.mkdir(parents=True, exist_ok=True)
UMBRAL = 1.0


def main():
    m = json.load(open(CU / "meta.json"))
    x0, y0, res, h, w = m["x0"], m["y0"], m["res"], m["h"], m["w"]
    A = np.load(CU / "A.npy", mmap_mode="r"); L = np.load(CU / "L.npy", mmap_mode="r")
    Z0 = np.load(CU / "Z0.npy", mmap_mode="r"); CN = np.load(CU / "CN.npy", mmap_mode="r")
    with rasterio.open(RAIZ / "data_build/hydrosheds/raw/hyd_sa_dir_15s.tif") as s:
        win = from_bounds(x0, y0 - h * res, x0 + w * res, y0, transform=s.transform).round_offsets().round_lengths()
        D = s.read(1, window=win)
    k = int(round(1 / res))  # 240 celdas por grado
    total, n_tes = 0, 0
    for r0 in range(0, h, k):
        for c0 in range(0, w, k):
            a = np.asarray(A[r0:r0 + k, c0:c0 + k])
            sel = a >= UMBRAL
            n = int(sel.sum())
            if not n:
                continue
            ff, cc = np.nonzero(sel)
            la = round(y0 - r0 * res) - 1  # esquina sur de la tesela
            lo = round(x0 + c0 * res)
            nombre = f"{'S' if la < 0 else 'N'}{abs(la):02d}{'W' if lo < 0 else 'E'}{abs(lo):03d}"
            z0 = np.nan_to_num(np.asarray(Z0[r0:r0 + k, c0:c0 + k])[sel], nan=0)
            partes = [np.array([n], "<u4").tobytes(),
                      a[sel].astype("<f4").tobytes(),
                      np.asarray(L[r0:r0 + k, c0:c0 + k])[sel].astype("<f4").tobytes(),
                      np.clip(z0, -32000, 32000).astype("<i2").tobytes(),
                      ff.astype(np.uint8).tobytes(), cc.astype(np.uint8).tobytes(),
                      D[r0:r0 + k, c0:c0 + k][sel].astype(np.uint8).tobytes(),
                      np.clip(np.round(np.asarray(CN[r0:r0 + k, c0:c0 + k])[sel]), 0, 100).astype(np.uint8).tobytes()]
            b = b"".join(partes)
            (SAL / f"{nombre}.bin").write_bytes(b)
            total += len(b); n_tes += 1
    print(f"{n_tes} teselas, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
