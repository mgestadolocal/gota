// Informe imprimible (A4, 3 hojas). Recibe los resultados ya calculados y devuelve el HTML.
// Las hojas tienen tamaño fijo para que el PDF quede siempre igual, sin cortes de página al azar.

const fmt = (v, d = 0) => Number(v).toLocaleString("es-CL", { maximumFractionDigits: d, minimumFractionDigits: d });
const ha = (m2) => (m2 >= 100000 ? fmt(m2 / 10000, 0) : fmt(m2 / 10000, m2 >= 10000 ? 1 : 2)) + " ha";
const m3 = (v) => fmt(Math.round(v)) + " m³";
const caudal = (q) => (q >= 1 ? `${fmt(q, 1)} m³/s` : `${fmt(q * 1000)} L/s`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NIVELES = ["Bajo", "Medio", "Alto"];
const nivel = (v, a, b) => (v < a ? 0 : v < b ? 1 : 2);

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5S6 13.6 6 20a10 10 0 0 0 20 0C26 13.6 16 2.5 16 2.5Z" fill="#5cc8ff"/><path d="M9.2 19.5c2.2-.9 3.8.8 6.3.1s3.8-1.6 6.5-.4" stroke="#04121c" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;

// indicadores con semáforo (referenciales) y textos de lectura
function indicadores(d) {
  const { st, t } = d;
  const s = t?.stats;
  const out = [];
  const areaAgua = s ? s.aCharcos : st.encArea;
  const fAgua = areaAgua / st.area;
  out.push({ nombre: "Acumulación de agua", valor: `${fmt(100 * fAgua, 1)} % del terreno`, n: nivel(fAgua, 0.01, 0.05),
    lectura: areaAgua ? `${ha(areaAgua)} quedan con más de 5 cm de agua${s ? "" : " (depresiones llenas)"}.` : "No se forman pozas relevantes." });
  out.push({ nombre: "Pendiente media", valor: `${fmt(st.pendMedia, 1)} %`, n: nivel(st.pendMedia, 5, 15),
    lectura: st.pendMedia < 5 ? "Terreno plano: el agua escurre lento y tiende a acumularse." : st.pendMedia < 15 ? "Pendiente moderada: escurrimiento ordenado." : "Pendiente fuerte: el agua baja rápido y puede erosionar." });
  if (s) {
    const coef = s.genera / s.llueve;
    out.push({ nombre: "Escorrentía", valor: `${fmt(100 * coef)} % de la lluvia`, n: nivel(coef, 0.25, 0.5),
      lectura: `${m3(s.genera)} escurren por la superficie; ${m3(s.infiltra)} se infiltran.` });
    const fEntra = s.entra / s.llueve;
    out.push({ nombre: "Agua desde vecinos", valor: s.entra ? m3(s.entra) : "—", n: nivel(fEntra, 0.1, 0.5),
      lectura: s.entra ? `Equivale al ${fmt(100 * fEntra)} % de la lluvia que cae sobre el terreno.` : "El terreno no recibe agua de predios vecinos." });
  }
  return out;
}

function recomendaciones(d, ind) {
  const { st, t, g } = d;
  const s = t?.stats;
  const r = [];
  const agua = ind[0], pend = ind[1];
  if (agua.n >= 1) r.push(`<b>Zonas de acumulación.</b> Evita emplazar construcciones, bodegas o acopios en las ${ha(s ? s.aCharcos : st.encArea)} donde se junta agua. Si necesitas usarlas, evalúa relleno o drenaje con un diseño específico.`);
  if (s && ind[2].n >= 1) r.push(`<b>Mucha escorrentía.</b> El ${fmt((100 * s.genera) / s.llueve)} % de la lluvia escurre. Considera obras de infiltración o retención (zanjas, pozos o lagunas de retención, cubierta vegetal) y conserva los cauces naturales.`);
  if (pend.n === 2) r.push(`<b>Laderas.</b> Con ${fmt(st.pendMedia)} % de pendiente media, protege taludes, evita cortes en ladera sin drenaje y controla la erosión en caminos y huellas.`);
  if (pend.n === 0 && agua.n === 0) r.push(`<b>Terreno plano.</b> Aunque hoy no se acumula agua, cualquier relleno o pavimento puede cambiar el drenaje: proyecta pendientes mínimas hacia una salida.`);
  if (s && ind[3].n >= 1) r.push(`<b>Aporte externo.</b> Tu terreno recibe ${m3(s.entra)} desde predios vecinos aguas arriba. Revisa por dónde entra esa agua y deja libres esos pasos.`);
  if (s) r.push(`<b>Cauce principal.</b> En el peak de la tormenta puede llevar hasta ${caudal(t.qVis ?? s.qMax)}. No construyas sobre él ni lo estreches; define una franja de protección a cada lado.`);
  else r.push(`<b>Tormentas.</b> Simula una tormenta en Gotyx para estimar volúmenes y caudales de diseño.`);
  r.push(`<b>Siguiente paso.</b> Para diseñar drenaje, nivelación o tramitar permisos, valida estos resultados con un levantamiento topográfico (dron o LiDAR) y un estudio hidrológico.${g.esDSM ? " El modelo usado es satelital de 30 m e incluye árboles y edificios." : ""}`);
  return r;
}

const kpi = (v, t, extra = "") => `<div class="kpi ${extra}"><b>${v}</b><span>${t}</span></div>`;
const pie = (d, n) => `<footer class="hoja-pie"><span class="marca-pie">${LOGO}<span>Got<i>yx</i></span></span><span>Informe ${esc(d.id)} · ${esc(d.fecha)}</span><span>gotyx.cl · ${n} / ${d.hojas}</span></footer>`;
const figura = (src, titulo, nota = "") => src
  ? `<figure><img src="${src}" alt="${esc(titulo)}"/><figcaption><b>${esc(titulo)}</b>${nota ? ` · ${nota}` : ""}</figcaption></figure>`
  : "";

export function informeHTML(d) {
  const { st, t, g, imgs, clasesPend, idf } = d;
  const s = t?.stats;
  const ind = indicadores(d);
  const general = Math.max(...ind.map((i) => i.n));
  const rec = recomendaciones(d, ind);
  d.hojas = 3;

  const resumen = s
    ? `Con una tormenta de <b>${t.T} años</b> (${fmt(t.P24)} mm en 24 horas), sobre las <b>${ha(st.area)}</b> del terreno caen <b>${m3(s.llueve)}</b> de agua. De ellos, <b>${m3(s.genera)}</b> escurren por la superficie, ${s.aCharcos ? `<b>${m3(s.enCharcos)}</b> quedan en pozas que cubren ${ha(s.aCharcos)}` : "no se forman pozas relevantes"} y el cauce principal alcanza un caudal máximo de <b>${caudal(t.qVis ?? s.qMax)}</b>.`
    : `El terreno tiene <b>${ha(st.area)}</b>, un desnivel de <b>${fmt(st.zmax - st.zmin, 1)} m</b> y una pendiente media de <b>${fmt(st.pendMedia, 1)} %</b>. ${st.encArea ? `Hay depresiones que pueden acumular hasta <b>${m3(st.encVol)}</b> en ${ha(st.encArea)}.` : "No se detectan depresiones relevantes."} Simula una tormenta para estimar volúmenes y caudales.`;

  // ---------- hoja 1: portada ----------
  const h1 = `<section class="hoja portada">
    <header class="cab">
      <div class="cab-marca">${LOGO}<span>Got<i>yx</i></span></div>
      <div class="cab-meta"><b>Informe hidrológico de terreno</b><span>${esc(d.id)} · ${esc(d.fecha)}</span></div>
    </header>
    <div class="titulo">
      <div class="sobre">Prediagnóstico · escurrimiento, acumulación y tormentas de diseño</div>
      <h1>${esc(d.lugar)}</h1>
      <p class="coords">${fmt(d.lat, 5)}°, ${fmt(d.lon, 5)}° · ${esc(g.fuente)} · celda ${fmt(g.dx, 1)} m</p>
    </div>
    ${imgs.vista ? `<div class="hero"><img src="${imgs.vista}" alt="Vista del terreno"/><span class="chip">${s ? `Tormenta de ${t.T} años` : "Vista del terreno"}</span></div>` : ""}
    <div class="kpis">
      ${kpi(ha(st.area), "Superficie")}
      ${kpi(`${fmt(st.zmax - st.zmin, 0)} m`, "Desnivel")}
      ${kpi(`${fmt(st.pendMedia, 1)} %`, "Pendiente media")}
      ${s ? kpi(caudal(t.qVis ?? s.qMax), "Caudal máximo", "agua") : kpi(st.encArea ? m3(st.encVol) : "—", "Agua retenida", "agua")}
    </div>
    <div class="resumen">
      <div class="atencion n${general}"><span>Nivel de atención</span><b>${NIVELES[general]}</b><i><u></u><u></u><u></u></i></div>
      <div><h2>Resumen</h2><p>${resumen}</p></div>
    </div>
    ${pie(d, 1)}
  </section>`;

  // ---------- hoja 2: terreno y mapas ----------
  const maxClase = Math.max(...st.clases, 0.0001);
  const h2 = `<section class="hoja">
    <h2 class="sec"><span>01</span>Terreno</h2>
    <div class="dos">
      <table class="datos">
        <tr><td>Superficie</td><td>${ha(st.area)}</td></tr>
        <tr><td>Cota mínima</td><td>${fmt(st.zmin, 1)} m s.n.m.</td></tr>
        <tr><td>Cota máxima</td><td>${fmt(st.zmax, 1)} m s.n.m.</td></tr>
        <tr><td>Desnivel</td><td>${fmt(st.zmax - st.zmin, 1)} m</td></tr>
        <tr><td>Pendiente media</td><td>${fmt(st.pendMedia, 1)} %</td></tr>
        <tr><td>Mayor cuenca que lo cruza</td><td>${ha(st.accMax)}</td></tr>
      </table>
      <div class="barras">
        <div class="mini-tit">Distribución de pendientes</div>
        ${clasesPend.map((k, i) => `<div class="barra"><span><i style="background:${k.color}"></i>${esc(k.txt)}</span><em><u style="width:${(100 * st.clases[i]) / maxClase}%;background:${k.color}"></u></em><b>${fmt(100 * st.clases[i])} %</b></div>`).join("")}
      </div>
    </div>
    <h2 class="sec"><span>02</span>Por dónde corre y dónde se acumula el agua</h2>
    <div class="mapas">
      ${figura(imgs.escurrimiento, "Escurrimiento", s ? "grosor según el caudal en el peak" : "grosor según la superficie que drena")}
      ${figura(imgs.encharcamiento, "Acumulación de agua", "celeste 5–30 cm · azul > 30 cm")}
    </div>
    <div class="dos notas">
      <p><b>Cauces.</b> Las líneas muestran los caminos naturales del agua, calculados sobre el modelo de elevación. Más gruesas y oscuras indican más agua.</p>
      <p><b>Pozas.</b> ${st.encArea ? `Las depresiones sin salida pueden retener hasta ${m3(st.encVol)} en ${ha(st.encArea)}, con una profundidad máxima de ${fmt(st.encMax, 2)} m.` : "No se detectan depresiones relevantes dentro del terreno."}</p>
    </div>
    <div class="metodo">
      <b>Metodología y fuentes.</b> Elevación: ${esc(g.fuente)}. Dirección de flujo D8 sobre el modelo con depresiones rellenadas (Priority-Flood); pendiente por el método de Horn.
      ${s ? `Lluvias extremas: GPEX (Gründemann et al. 2021, CC BY 4.0), base satelital de ~10 km. Escorrentía: número de curva SCS con cobertura ESA WorldCover 2021 (CC BY 4.0) y suelo tipo ${esc(t.suelo)} (CN medio ${fmt(s.cnMedio)}). Caudal: método racional con tiempo de concentración de California.` : ""}
      Resultado referencial de prediagnóstico: no reemplaza un levantamiento topográfico ni un estudio hidrológico firmado por un profesional.
    </div>
    ${pie(d, 2)}
  </section>`;

  // ---------- hoja 3: tormenta, indicadores y recomendaciones ----------
  let tormenta = `<p class="vacio">No se simuló una tormenta. En Gotyx, elige un período de retorno y presiona «Simular tormenta» para incluir volúmenes y caudales.</p>`;
  if (s) {
    const maxIdf = Math.max(...idf.map((x) => x[1]));
    const pGen = (100 * s.genera) / s.llueve, pInf = (100 * s.infiltra) / s.llueve;
    tormenta = `<div class="dos">
      <div>
        <div class="mini-tit">Lluvia de ${t.T} años en este punto</div>
        ${idf.map(([n, v]) => `<div class="barra"><span>${n}</span><em><u style="width:${(100 * v) / maxIdf}%"></u></em><b>${fmt(v, v < 10 ? 1 : 0)} mm</b></div>`).join("")}
        <div class="mini-tit" style="margin-top:5mm">Qué pasa con la lluvia</div>
        <div class="balance"><u class="b-esc" style="width:${pGen}%"></u><u class="b-inf" style="width:${pInf}%"></u></div>
        <div class="balance-ley"><span><i class="b-esc"></i>Escurre ${fmt(pGen)} %</span><span><i class="b-inf"></i>Se infiltra ${fmt(pInf)} %</span></div>
      </div>
      <table class="datos">
        <tr><td>Lluvia en 24 h</td><td>${fmt(t.P24, 1)} mm</td></tr>
        <tr><td>Agua que cae</td><td>${m3(s.llueve)}</td></tr>
        <tr><td>Escurre</td><td>${m3(s.genera)}</td></tr>
        <tr><td>Se infiltra</td><td>${m3(s.infiltra)}</td></tr>
        <tr><td>Queda en pozas</td><td>${s.aCharcos ? `${m3(s.enCharcos)} · ${ha(s.aCharcos)}` : "no se forman"}</td></tr>
        <tr><td>Sale del terreno</td><td>${m3(s.sale)}</td></tr>
        <tr><td>Entra desde vecinos</td><td>${m3(s.entra)}</td></tr>
        <tr class="fuerte"><td>Caudal máximo</td><td>${caudal(t.qVis ?? s.qMax)}</td></tr>
      </table>
    </div>`;
  }
  const h3 = `<section class="hoja">
    <h2 class="sec"><span>03</span>${s ? `Tormenta de ${t.T} años` : "Tormenta de diseño"}</h2>
    ${tormenta}
    <h2 class="sec"><span>04</span>Indicadores</h2>
    <table class="semaforo">
      ${ind.map((i) => `<tr><td><b>${i.nombre}</b><small>${i.lectura}</small></td><td>${i.valor}</td><td><span class="n${i.n}">${NIVELES[i.n]}</span></td></tr>`).join("")}
    </table>
    <h2 class="sec"><span>05</span>Recomendaciones</h2>
    <ol class="recs">${rec.map((x) => `<li>${x}</li>`).join("")}</ol>
    ${pie(d, 3)}
  </section>`;

  return h1 + h2 + h3;
}
