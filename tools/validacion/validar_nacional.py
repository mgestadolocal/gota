"""Validación de la capa nacional (HydroSHEDS 15") contra las estaciones DGA de CAMELS-CL.

En cada estación se elige la celda de 15" a <= 2,5 km cuya área aportante se parece más al área DGA
(práctica estándar para ubicar estaciones en una red ráster). Con sus atributos (área, CN medio, largo y
desnivel del recorrido más largo, centro de la cuenca) se calcula el caudal punta con las MISMAS fórmulas
de web/app/analisis.js (racional, tc California, C de la escorrentía SCS a 24 h) y las lluvias GPEX de la app
(promedio ponderado de las 4 celdas más cercanas al centro de la cuenca, ajuste a·D^n con 3–24 h).
Salida: data_build/validacion/nacional.jsonl y resumen en pantalla.
"""
import json, math
import numpy as np
from comun import SAL, RAIZ

CU = RAIZ / "data_build/cuencas"
GPEX = RAIZ / "web/app/data/gpex"
DUR = [3, 6, 12, 24, 48, 72]
RETS = [2, 5, 10, 20, 50, 100]
NV = len(DUR) * len(RETS)
_tes = {}


def tesela(la, lo):
    n = f"{'S' if la < 0 else 'N'}{abs(la):02d}{'W' if lo < 0 else 'E'}{abs(lo):03d}"
    if n not in _tes:
        f = GPEX / f"{n}.bin"
        _tes[n] = np.fromfile(f, dtype="<u2") if f.exists() else None
    return _tes[n]


def lluvias(lon, lat):
    kx = math.cos(math.radians(lat)); cand = []
    for dla in (-1, 0, 1):
        for dlo in (-1, 0, 1):
            la, lo = math.floor(lat) + dla, math.floor(lon) + dlo
            t = tesela(la, lo)
            if t is None: continue
            for r in range(10):
                for c in range(10):
                    cy, cx = la + 1 - 0.05 - 0.1 * r, lo + 0.05 + 0.1 * c
                    d = math.hypot((cx - lon) * kx, cy - lat)
                    if d > 0.25: continue
                    b = (r * 10 + c) * NV
                    if t[b] == 0xFFFF: continue
                    cand.append((d, t[b:b + NV].astype(float) / 10))
    if not cand: return None
    cand.sort(key=lambda x: x[0]); u = cand[:4]
    p = np.array([1 / max(1e-6, d) ** 2 for d, _ in u]); p /= p.sum()
    prom = sum(pi * v for pi, (_, v) in zip(p, u))
    return {T: prom[k * len(DUR):(k + 1) * len(DUR)] for k, T in enumerate(RETS)}


def ajuste_idf(fila):
    xs = [math.log(DUR[j]) for j in range(4) if fila[j] > 0]; ys = [math.log(fila[j]) for j in range(4) if fila[j] > 0]
    mx, my = np.mean(xs), np.mean(ys)
    e = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    e = min(0.9, max(0.1, e))
    return math.exp(my - e * mx), e


def qscs(P, CN):
    S = 25400 / CN - 254; Ia = 0.2 * S
    return (P - Ia) ** 2 / (P - Ia + S) if P > Ia else 0.0


def caudal(A, CN, Lkm, H, P24, a, n):
    """Igual que analisis.js: tc California (h, mín. 10 min), i = P(tc)/tc, C = Q_SCS(P24)/P24."""
    Lkm = max(Lkm, 0.03)
    H = max(H, 0.001 * Lkm * 1000, 0.1)
    tc = max(1 / 6, 0.95 * (Lkm ** 3 / H) ** 0.385)
    i = a * tc ** n / tc
    C = qscs(P24, CN) / P24
    return C * i * A / 3.6


class Capa:
    def __init__(self):
        m = json.load(open(CU / "meta.json"))
        self.x0, self.y0, self.res = m["x0"], m["y0"], m["res"]
        self.v = {k: np.load(CU / f"{k}.npy", mmap_mode="r") for k in ("A", "CN", "L", "Z0", "z", "CX", "CY")}
        self.h, self.w = self.v["A"].shape

    def celda(self, lon, lat):
        return int((self.y0 - lat) / self.res), int((lon - self.x0) / self.res)

    def ubicar(self, lon, lat, area, radio_km=2.5):
        r0, c0 = self.celda(lon, lat)
        k = int(math.ceil(radio_km / (self.res * 111.32))) + 1
        mejor, best = None, 9e9
        for r in range(max(0, r0 - k), min(self.h, r0 + k + 1)):
            for c in range(max(0, c0 - k), min(self.w, c0 + k + 1)):
                la = self.y0 - (r + 0.5) * self.res; lo = self.x0 + (c + 0.5) * self.res
                d = math.hypot((lo - lon) * math.cos(math.radians(lat)), la - lat) * 111.32
                if d > radio_km: continue
                A = float(self.v["A"][r, c])
                if A <= 0: continue
                s = abs(math.log(A / area)) + 0.02 * d
                if s < best: best, mejor = s, (r, c)
        return mejor

    def atributos(self, r, c):
        g = {k: float(self.v[k][r, c]) for k in self.v}
        g["H"] = g["Z0"] - g["z"]
        return g


def main():
    obs = json.load(open(SAL / "observado.json", encoding="utf-8"))
    capa = Capa()
    filas = []
    with open(SAL / "nacional.jsonl", "w", encoding="utf-8") as f:
        for o in obs:
            rc = capa.ubicar(o["lon"], o["lat"], o["area_km2"])
            if rc is None: continue
            g = capa.atributos(*rc)
            P = lluvias(g["CX"], g["CY"])
            if P is None: continue
            q = {}
            for T in RETS:
                a, n = ajuste_idf(P[T])
                q[str(T)] = caudal(g["A"], g["CN"], g["L"], g["H"], P[T][3], a, n)
            fila = {"id": o["id"], "rel_area": g["A"] / o["area_km2"], **{k: g[k] for k in ("A", "CN", "L", "H")}, "q": q}
            filas.append((o, fila))
            f.write(json.dumps(fila) + "\n")
    ok = [(o, f) for o, f in filas if 0.8 <= f["rel_area"] <= 1.2]
    print(f"estaciones ubicadas: {len(filas)} · área ±20 %: {len(ok)}")
    for T in ("10", "20", "100"):
        for nz, l0, l1 in (("todas", -90, 0), ("semiárida 32–35", -35, -32), ("centro-sur 35–43", -43, -35)):
            r = np.array([f["q"][T] / o["qi"][T] for o, f in ok if l0 <= o["lat"] < l1])
            print(f"  T={T:>3} {nz:18} n={len(r):3d} dentro x2 {np.mean((r >= .5) & (r <= 2)):4.0%}  sesgo {np.median(r):5.2f}  "
                  f"error típico {np.median(np.abs(r - 1)):4.0%}")


if __name__ == "__main__":
    main()
