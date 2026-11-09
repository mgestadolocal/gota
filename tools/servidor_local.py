"""Servidor de prueba: sirve web/ y replica la ruta /cop/{tesela} del Worker (lecturas por rango a Copernicus).
Uso: python tools/servidor_local.py   ->  http://localhost:8790/?api=http://localhost:8790
"""
import re
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"
TESELA = re.compile(r"^/cop/(Copernicus_DSM_COG_10_[NS]\d{2}_00_[EW]\d{3}_00_DEM)$")
RANGO = re.compile(r"^bytes=\d{1,10}-\d{0,10}$")


class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.end_headers()

    def do_GET(self):
        m = TESELA.match(self.path.split("?")[0])
        if not m:
            return super().do_GET()
        rango = self.headers.get("Range", "")
        if not RANGO.match(rango):
            self.send_response(416); self.end_headers(); return
        nombre = m.group(1)
        req = urllib.request.Request(f"{BUCKET}/{nombre}/{nombre}.tif", headers={"Range": rango})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                cuerpo = r.read()
                self.send_response(r.status)
                for k in ("Content-Type", "Content-Range", "Accept-Ranges"):
                    if r.headers.get(k):
                        self.send_header(k, r.headers[k])
                self.send_header("Content-Length", str(len(cuerpo)))
                self.end_headers()
                self.wfile.write(cuerpo)
        except urllib.error.HTTPError as e:
            self.send_response(404 if e.code in (403, 404) else 502)
            self.end_headers()


if __name__ == "__main__":
    print("http://localhost:8790/?api=http://localhost:8790")
    ThreadingHTTPServer(("127.0.0.1", 8790), Manejador).serve_forever()
