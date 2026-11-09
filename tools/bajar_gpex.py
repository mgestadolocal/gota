"""Descarga solo GPEX_extremes.nc (dentro de data.zip v1 de GPEX, CC BY 4.0) por rango y lo descomprime al vuelo."""
import sys, zlib, urllib.request
URL = "https://data.4tu.nl/file/9c547b34-f9d0-410c-be38-f0bdb46318cf/18d10265-17b3-4ec6-8170-d43c17e84b6c"
INI, LARGO, CRC = 46, 1299998529, 3893522790
salida = sys.argv[1]
req = urllib.request.Request(URL, headers={"Range": f"bytes={INI}-{INI + LARGO - 1}", "User-Agent": "cota-terreno/0.1"})
d = zlib.decompressobj(-15); crc = 0; n = 0
with urllib.request.urlopen(req, timeout=120) as r, open(salida, "wb") as f:
    while True:
        b = r.read(1 << 20)
        if not b: break
        n += len(b)
        x = d.decompress(b); crc = zlib.crc32(x, crc); f.write(x)
        if n % (100 << 20) < (1 << 20): print(f"{n/1e6:.0f} MB", flush=True)
    x = d.flush(); crc = zlib.crc32(x, crc); f.write(x)
print("CRC OK" if crc == CRC else f"CRC MAL {crc}")
