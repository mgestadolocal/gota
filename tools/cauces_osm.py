"""Ríos y esteros de OpenStreetMap (Geofabrik, Chile) -> teselas JSON de 0,2° para la app.
Uso: python tools/cauces_osm.py data_build/osm/chile-latest.osm.pbf web/app/data/cauces
Datos © OpenStreetMap contributors, ODbL 1.0.
"""
import sys, json, math, os
from collections import defaultdict
import osmium
from shapely.geometry import LineString

PBF, OUT = sys.argv[1], sys.argv[2]
PASO = 0.2
TOL = 0.00004  # ~4 m
teselas = defaultdict(list)

class H(osmium.SimpleHandler):
    n = 0
    def way(self, w):
        t = w.tags.get("waterway")
        if t not in ("river", "stream"):
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2:
            return
        ls = LineString(pts).simplify(TOL, preserve_topology=False)
        c = [[round(x, 5), round(y, 5)] for x, y in ls.coords]
        o, s_, e, n_ = ls.bounds
        reg = {"id": w.id, "t": "r" if t == "river" else "s", "n": w.tags.get("name", ""), "c": c}
        for i in range(math.floor(o / PASO), math.floor(e / PASO) + 1):
            for j in range(math.floor(s_ / PASO), math.floor(n_ / PASO) + 1):
                teselas[(i, j)].append(reg)
        self.n += 1

h = H()
h.apply_file(PBF, locations=True, idx="flex_mem")
os.makedirs(OUT, exist_ok=True)
total = 0
for (i, j), regs in teselas.items():
    p = os.path.join(OUT, f"{i}_{j}.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(regs, f, ensure_ascii=False, separators=(",", ":"))
    total += os.path.getsize(p)
with open(os.path.join(OUT, "LEEME.txt"), "w", encoding="utf-8") as f:
    f.write("Ríos y esteros (waterway=river|stream) de OpenStreetMap para Chile, en teselas de 0,2° ({lon/0.2}_{lat/0.2}.json).\n"
            "© OpenStreetMap contributors. Base de datos disponible bajo la Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/\n"
            "Generado con tools/cauces_osm.py desde el extracto de Geofabrik.\n")
print(f"{h.n} cauces, {len(teselas)} teselas, {total/1e6:.1f} MB")
