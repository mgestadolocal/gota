"""Paso 4: calibración del caudal punta con los ingredientes de cada cuenca (diag del Worker).

Reproduce en Python el método de analisis.js (tormenta):
  Q = C · i(tc) · A / 3,6     tc = 0,95·(L³/H)^0,385 (California, h; mín. 10 min)
  i(tc) = a·tc^n / tc         C = Q_SCS(P24, CN) / P24 (Ia = 0,2·S)
y prueba variantes. Cada variante se evalúa con validación cruzada dejando una cuenca fuera (LOO):
los parámetros se ajustan sin esa cuenca y se mide el error en ella. Así el error reportado es el
que se espera en un lugar nuevo, no el del ajuste.

Observado: punta instantánea estimada (Fuller) y máximo diario (cota inferior).
"""
import json, math, sys
import numpy as np
from scipy.optimize import minimize
from comun import SAL

RETS = ["2", "5", "10", "20", "50", "100"]
T_CAL = ["5", "10", "20", "50"]  # períodos con estimación observada razonable (registros de 15–80 años)


def qscs(P, CN, lam=0.2):
    S = 25400 / CN - 254; Ia = lam * S
    return (P - Ia) ** 2 / (P - Ia + S) if P > Ia else 0.0


def arf(A_km2, D_h):
    """Factor de reducción areal (Leclerc y Schaake 1972, la curva de NOAA Atlas 2)."""
    A_mi = A_km2 / 2.59
    e = math.exp(-1.1 * D_h ** 0.25)
    return max(0.3, 1 - e + math.exp(-1.1 * D_h ** 0.25 - 0.01 * A_mi))


def cn_seco(cn):  # condición de humedad antecedente I (seca)
    return 4.2 * cn / (10 - 0.058 * cn)


def q_modelo(d, idf, P24, lam=0.2, usar_arf=False, amc=2, k_tc=1.0):
    A = d["area"] / 1e6
    Lkm = d["L"] / 1000
    H = max(d["H"], 0.001 * Lkm * 1000, 0.1)
    tc = max(1 / 6, k_tc * 0.95 * (Lkm ** 3 / H) ** 0.385)
    a, n = idf["a"], idf["n"]
    f = arf(A, tc) if usar_arf else 1.0
    f24 = arf(A, 24) if usar_arf else 1.0
    PD = a * tc ** n * f
    cn = d["cn"] if amc == 2 else cn_seco(d["cn"])
    P = P24 * f24
    C = qscs(P, cn, lam) / P if P > 0 else 0
    return C * (PD / tc) * A / 3.6


def cargar():
    obs = {o["id"]: o for o in json.load(open(SAL / "observado.json", encoding="utf-8"))}
    filas = []
    for l in open(SAL / "modelo.jsonl", encoding="utf-8"):
        m = json.loads(l)
        if not m.get("ok"):
            continue
        o = obs[m["id"]]
        if not 0.8 <= m["areaSalida_km2"] / o["area_km2"] <= 1.2:
            continue
        filas.append((o, m))
    return filas


def evaluar(nombre, pred, obs_key, filas, suelo="C", log=None):
    """pred(o, m, T, suelo) -> Q. Devuelve métricas por T en T_CAL juntando cuencas."""
    r = []
    for o, m in filas:
        for T in T_CAL:
            q = pred(o, m, T, suelo)
            r.append(q / o[obs_key][T])
    r = np.array(r)
    out = {"sesgo": float(np.median(r)), "x2": float(np.mean((r >= 0.5) & (r <= 2))),
           "err": float(np.median(np.abs(r - 1))), "fac": float(np.exp(np.median(np.abs(np.log(r)))))}
    print(f"  {nombre:58} sesgo {out['sesgo']:5.2f}  dentro x2 {out['x2']:4.0%}  error típico {out['err']:4.0%}  factor {out['fac']:4.2f}")
    return out


def main():
    filas = cargar()
    print(f"{len(filas)} cuencas válidas\n")

    # 0) chequeo: la réplica en Python reproduce el qp del Worker
    dif = []
    for o, m in filas:
        for T in RETS:
            rr = m["res"]["C"][T]
            q = q_modelo(rr["diag"], rr["idf"], m["lluvia"][T][3])
            if rr["diag"]["qp"] > 0: dif.append(abs(q / rr["diag"]["qp"] - 1))
    print(f"Réplica Python vs Worker: error máx {max(dif):.2e}\n")

    base = lambda o, m, T, s, **kw: q_modelo(m["res"][s][T]["diag"], m["res"][s][T]["idf"], m["lluvia"][T][3], **kw)

    for obs_key, titulo in (("qi", "contra la PUNTA INSTANTÁNEA estimada (Fuller)"), ("qd", "contra el MÁXIMO DIARIO (cota inferior)")):
        print(f"== {titulo} · T = {', '.join(T_CAL)} años ==")
        for s in "ABCD":
            evaluar(f"Gotyx hoy, suelo {s}", lambda o, m, T, s_: base(o, m, T, s_), obs_key, filas, s)
        evaluar("suelo C + reducción areal de la lluvia (ARF)", lambda o, m, T, s: base(o, m, T, s, usar_arf=True), obs_key, filas)
        evaluar("suelo C + ARF + humedad antecedente seca", lambda o, m, T, s: base(o, m, T, s, usar_arf=True, amc=1), obs_key, filas)
        evaluar("suelo B + ARF", lambda o, m, T, s: base(o, m, T, "B", usar_arf=True), obs_key, filas)
        print()

    # 1) corrección regional con LOO: log(Qobs/Qmod) = b0 + b1·log(P24_T2/60) + b2·log(A/300)
    #    P24 de 2 años (GPEX) y el área son datos que la app ya tiene en cualquier lugar.
    print("== corrección regional (validación cruzada dejando una cuenca fuera) ==")
    for obs_key in ("qi", "qd"):
        for variante, kw in (("C", {}), ("C+ARF", {"usar_arf": True})):
            X, Y, G = [], [], []
            for g, (o, m) in enumerate(filas):
                for T in T_CAL:
                    q = base(o, m, T, "C", **kw)
                    if q <= 0: continue
                    X.append([1, math.log(m["lluvia"]["2"][3] / 60), math.log(o["area_km2"] / 300)])
                    Y.append(math.log(o[obs_key][T] / q)); G.append(g)
            X, Y, G = np.array(X), np.array(Y), np.array(G)
            pred = np.zeros_like(Y)
            for g in np.unique(G):
                tr = G != g
                b = np.linalg.lstsq(X[tr], Y[tr], rcond=None)[0]
                pred[G == g] = X[G == g] @ b
            b_todo = np.linalg.lstsq(X, Y, rcond=None)[0]
            r = np.exp(pred - Y)  # Qmod_corr / Qobs
            print(f"  {obs_key} · {variante:6} coef {np.round(b_todo, 3)}  sesgo {np.median(r):5.2f}  dentro x2 {np.mean((r >= .5) & (r <= 2)):4.0%}  "
                  f"error típico {np.median(np.abs(r - 1)):4.0%}  factor {np.exp(np.median(np.abs(np.log(r)))):4.2f}")


if __name__ == "__main__":
    main()
