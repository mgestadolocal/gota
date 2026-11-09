// GeoTIFF mínimo: una banda Float32, sin compresión, una sola franja, little-endian.
// (geotiff.js solo escribe 8 bits.)
export function geotiffFloat32(valores, w, h, { epsg, x0, y0, rx, ry, nodata = -9999 }) {
  const geo = epsg === 4326;
  const claves = [1, 1, 0, 3, 1024, 0, 1, geo ? 2 : 1, 1025, 0, 1, 1, geo ? 2048 : 3072, 0, 1, epsg];
  const nd = String(nodata) + "\0";
  // [tag, tipo, cantidad, valor | arreglo]   tipos: 2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE
  const tags = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, 0 /* se completa */], [277, 3, 1, 1], [278, 4, 1, h], [279, 4, 1, w * h * 4],
    [284, 3, 1, 1], [339, 3, 1, 3],
    [33550, 12, 3, [rx, ry, 0]], [33922, 12, 6, [0, 0, 0, x0, y0, 0]],
    [34735, 3, claves.length, claves], [42113, 2, nd.length, nd],
  ];
  const tam = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifd = 8, ifdLen = 2 + tags.length * 12 + 4;
  let extra = ifd + ifdLen;
  const externos = [];
  for (const t of tags) {
    const bytes = tam[t[1]] * t[2];
    if (bytes > 4) { externos.push([t, extra]); extra += bytes + (bytes % 2); }
  }
  const datos = extra + (extra % 4 ? 4 - (extra % 4) : 0);
  tags.find((t) => t[0] === 273)[3] = datos;

  const buf = new ArrayBuffer(datos + w * h * 4);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true);
  dv.setUint16(ifd, tags.length, true);
  const escribir = (t, pos) => {
    const [, tipo, , val] = t;
    const arr = typeof val === "string" ? [...val].map((ch) => ch.charCodeAt(0)) : Array.isArray(val) ? val : [val];
    arr.forEach((v, k) => {
      if (tipo === 2) dv.setUint8(pos + k, v);
      else if (tipo === 3) dv.setUint16(pos + 2 * k, v, true);
      else if (tipo === 4) dv.setUint32(pos + 4 * k, v, true);
      else dv.setFloat64(pos + 8 * k, v, true);
    });
  };
  tags.forEach((t, k) => {
    const p = ifd + 2 + k * 12;
    dv.setUint16(p, t[0], true); dv.setUint16(p + 2, t[1], true); dv.setUint32(p + 4, t[2], true);
    const ext = externos.find((e) => e[0] === t);
    if (ext) { dv.setUint32(p + 8, ext[1], true); escribir(t, ext[1]); }
    else escribir(t, p + 8);
  });
  dv.setUint32(ifd + 2 + tags.length * 12, 0, true);
  new Float32Array(buf, datos, w * h).set(valores);
  return buf;
}
