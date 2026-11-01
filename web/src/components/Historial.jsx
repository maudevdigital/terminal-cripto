import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle, HistogramSeries, LineSeries } from "lightweight-charts";
import { fmt, fmtNum } from "../lib/format.js";
import { C } from "../lib/constants.js";
import Icon from "./Icon.jsx";
import { CabinaRiesgo, hora } from "./Riesgo.jsx";

// Ganancia y perdida: el verde va un paso mas oscuro que el de las velas para
// separarse del rojo tambien con daltonismo. El color nunca va solo: cada valor
// lleva su signo y las barras crecen hacia arriba o hacia abajo del cero.
const VERDE = C.sube, ROJO = C.baja, AZUL = "#5B8DEF";
const RANGOS = [[7, "7 días"], [30, "30 días"], [90, "90 días"], [0, "Todo"]];
const MOTIVO = { sl: "Stop loss", tp: "Take profit", manual: "A mano", stop_out: "Stop out", otro: "Otro" };
const DIAS = ["L", "M", "M", "J", "V", "S", "D"];

const signo = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), d)}`);
const corto = (x) => {
  const a = Math.abs(x);
  return `${x >= 0 ? "+" : "−"}${a >= 10_000 ? `${fmtNum(a / 1000, 0)}K` : a >= 1000 ? `${fmtNum(a / 1000, 1)}K` : fmtNum(a, 0)}`;
};
const fechaHora = (ms) => new Date(ms).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "2026-10-20" (un dia de la firma) -> "20-10-2026", como lo escribe es-CL. */
const fechaDia = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString("es-CL", { timeZone: "UTC" });
const duracion = (min) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${fmtNum(min / 1440, 1)} días`);
const haceCuanto = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? "recién" : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
};

async function pedirSheets() {
  try {
    const r = await fetch("/api/historial/sheets", { method: "POST", headers: { "x-terminal": "operativa" } });
    return await r.json();
  } catch {
    return null;
  }
}

/** Historial de la cuenta: metricas, curva, resultado por dia, calendario,
 *  mercados, resultados en R y cada operacion. El periodo de arriba filtra todo. */
export default function Historial({ onCerrar }) {
  const [rango, setRango] = useState(() => {
    try { return Number(localStorage.getItem("terminal-cripto:historial-rango") ?? 30); } catch { return 30; }
  });
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [todas, setTodas] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("terminal-cripto:historial-rango", String(rango)); } catch { /* sin almacenamiento */ }
    let vivo = true;
    const traer = async () => {
      setCargando(true);
      try {
        const r = await fetch(`/api/historial?dias=${rango}`);
        const j = await r.json();
        if (vivo) setDatos(j);
      } catch {
        if (vivo) setDatos((d) => d ?? { disponible: false, motivo: "No se pudo hablar con el servidor" });
      } finally {
        if (vivo) setCargando(false);
      }
    };
    void traer();
    const t = setInterval(traer, 15_000);
    return () => { vivo = false; clearInterval(t); };
  }, [rango]);

  useEffect(() => {
    const tecla = (e) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onCerrar]);

  const d = datos;
  const m = d?.metricas;
  const moneda = d?.moneda ?? "USD";
  // Las series de los graficos cambian solo con datos nuevos (no con cada render).
  const series = useMemo(() => (d?.disponible ? {
    curva: curvaDiaria(d.dias),
    refCurva: d.riesgo?.maxima ? [{ precio: d.riesgo.maxima.piso, titulo: "Pérdida máxima", color: ROJO }] : [],
    dias: d.dias.map((x) => ({ time: x.fecha, value: x.resultado, color: x.resultado >= 0 ? VERDE : ROJO })),
    refDias: d.riesgo?.diaria ? [{ precio: -d.riesgo.diaria.limite, titulo: "Límite diario", color: ROJO }] : [],
  } : null), [d]);
  return (
    <section className="historial" aria-label="Historial de operaciones">
      <div className="historial-barra">
        <h2>Historial de operaciones</h2>
        <div className="segmento" role="group" aria-label="Período">
          {RANGOS.map(([n, t]) => (
            <button key={n} className={rango === n ? "activo" : ""} onClick={() => setRango(n)}>{t}</button>
          ))}
        </div>
        <EstadoSheets sheets={d?.sheets} onEstado={(s) => setDatos((x) => (x ? { ...x, sheets: s } : x))} />
        <button className="historial-cerrar" onClick={onCerrar} title="Volver al gráfico (Escape)"><Icon name="x" size={14} /></button>
      </div>

      {!d ? <div className="historial-vacio tenue">Cargando el historial…</div>
        : !d.disponible ? <div className="historial-vacio"><b>Sin historial todavía</b><span className="tenue">{d.motivo}</span></div>
        : (
          <div className={`historial-cuerpo${cargando ? " cargando" : ""}`}>
            {d.riesgo && (
              <div className="historial-riesgo">
                <span className="tenue">Cuenta de fondeo · balance inicial {fmtNum(d.riesgo.inicial, 2)} {moneda}</span>
                <CabinaRiesgo riesgo={d.riesgo} moneda={moneda} />
              </div>
            )}
            <Tiles m={m} moneda={moneda} />
            {m.operaciones === 0 ? (
              <div className="historial-vacio tenue">No hay operaciones cerradas en este período.</div>
            ) : (
              <>
                <div className="historial-fila dos">
                  <Tarjeta titulo="Curva de la cuenta" detalle="Balance al cierre de cada día de la firma">
                    <SerieDiaria tipo="linea" datos={series.curva} referencias={series.refCurva} moneda={moneda} />
                  </Tarjeta>
                  <Tarjeta titulo="Resultado de cada día" detalle="Lo cerrado en el día, con comisiones y swap">
                    <SerieDiaria tipo="columnas" datos={series.dias} referencias={series.refDias} moneda={moneda} />
                  </Tarjeta>
                </div>
                <div className="historial-fila tres">
                  <Tarjeta titulo="Calendario" detalle={d.riesgo ? `Días de la firma: cortan a las ${hora(d.riesgo.proximoCorte)} de acá` : "Días de la firma"}>
                    <Calendario dias={d.dias} moneda={moneda} />
                  </Tarjeta>
                  <Tarjeta titulo="Por mercado" detalle="Dónde ganás y dónde perdés">
                    <Mercados filas={m.porMercado} moneda={moneda} />
                  </Tarjeta>
                  <Tarjeta titulo="Resultados en R" detalle={`Veces lo arriesgado · ${m.conR} de ${m.operaciones} con SL inicial`}>
                    <Distribucion tramos={m.distribucionR} />
                    <Cierres motivos={m.porMotivo} total={m.operaciones} />
                  </Tarjeta>
                </div>
                <Tarjeta titulo="Operaciones" detalle={`${d.operaciones.length} cerradas · la más nueva arriba`}>
                  <TablaOperaciones ops={todas ? [...d.operaciones].reverse() : [...d.operaciones].reverse().slice(0, 25)} moneda={moneda} />
                  {d.operaciones.length > 25 && (
                    <button className="historial-mas" onClick={() => setTodas((x) => !x)}>
                      {todas ? "Ver solo las últimas 25" : `Ver las ${d.operaciones.length}`}
                    </button>
                  )}
                </Tarjeta>
              </>
            )}
          </div>
        )}
    </section>
  );
}

/** Estado de Google Sheets: sin configurar, sincronizado, o el error. */
function EstadoSheets({ sheets, onEstado }) {
  const [, refrescar] = useState(0);
  useEffect(() => { const t = setInterval(() => refrescar((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  if (!sheets) return null;
  if (!sheets.configurado) {
    return <span className="historial-sheets tenue" title="Poné GOOGLE_CREDENCIALES y SHEETS_ID en el .env (ver README)">Google Sheets sin configurar</span>;
  }
  return (
    <span className={`historial-sheets${sheets.error ? " error" : ""}`}>
      <span title={sheets.error ?? ""}>
        Google Sheets · {sheets.sincronizando ? "sincronizando…" : sheets.error ? `error: ${sheets.error}`
          : sheets.ultimo ? `${haceCuanto(sheets.ultimo)} · ${sheets.filas ?? 0} operaciones` : "pendiente"}
      </span>
      {sheets.url && <a href={sheets.url} target="_blank" rel="noreferrer">Abrir</a>}
      <button onClick={async () => { const s = await pedirSheets(); if (s) onEstado(s); }} disabled={sheets.sincronizando}>Sincronizar</button>
    </span>
  );
}

function Tarjeta({ titulo, detalle, children }) {
  return (
    <div className="historial-tarjeta">
      <div className="historial-titulo"><b>{titulo}</b>{detalle && <span className="tenue">{detalle}</span>}</div>
      {children}
    </div>
  );
}

/** Las metricas, cada una con como se lee. */
function Tiles({ m, moneda }) {
  const tiles = [
    ["Resultado neto", `${signo(m.neto)} ${moneda}`, `${m.operaciones} operaciones · ${m.ganadas} ganadas · ${m.perdidas} perdidas`, m.neto >= 0 ? "pos" : "neg", true],
    ["Ganadoras", m.pctGanadoras === null ? "—" : `${fmtNum(m.pctGanadoras, 1)} %`, "de cada 10, cuántas cerraron en positivo"],
    ["Factor de beneficio", m.factorBeneficio === null ? (m.operaciones ? "sin pérdidas" : "—") : fmtNum(m.factorBeneficio, 2),
      m.factorBeneficio === null ? "" : `ganaste ${fmtNum(m.factorBeneficio, 2)} por cada 1 perdido`],
    ["Expectativa", m.expectativaR !== null ? `${signo(m.expectativaR)} R` : `${signo(m.expectativa)} ${moneda}`,
      m.expectativaR === null ? "lo que suma en promedio cada operación"
        : `en promedio cada operación ${m.expectativaR >= 0 ? "suma" : "pierde"} el ${fmtNum(Math.abs(m.expectativaR) * 100, 0)} % de lo que arriesga`],
    ["Caída máxima", `−${fmtNum(m.caidaMax, 2)}`, `${fmtNum(m.caidaMaxPct, 2)} % desde un máximo de la cuenta`],
    ["Ganancia y pérdida media",
      `${m.gananciaMedia === null ? "—" : signo(m.gananciaMedia)} / ${m.perdidaMedia === null ? "—" : `−${fmtNum(m.perdidaMedia, 2)}`}`,
      "si perdés más de lo que ganás, necesitás acertar más"],
    ["Costos", `${signo(m.costos)} ${moneda}`, "comisiones y swap pagados"],
    ["Disciplina", m.conSl === null ? "—" : `${fmtNum(m.conSl, 0)} % con SL`, `racha máx. ${m.rachaGanadora} ganadas / ${m.rachaPerdedora} perdidas`],
  ];
  return (
    <div className="historial-tiles">
      {tiles.map(([titulo, valor, ayuda, clase = "", heroe = false]) => (
        <div key={titulo} className={`tile${heroe ? " heroe" : ""}`}>
          <span className="tile-titulo">{titulo}</span>
          <b className={`tile-valor ${clase}`}>{valor}</b>
          {ayuda && <span className="tile-ayuda">{ayuda}</span>}
        </div>
      ))}
    </div>
  );
}

/** Balance al cierre de cada dia, arrancando por el que habia el dia anterior al
 *  primero (asi la curva muestra tambien como termino ese primer dia). */
function curvaDiaria(dias) {
  const puntos = dias.map((x) => ({ time: x.fecha, value: x.balance }));
  if (puntos.length) {
    const f = new Date(`${puntos[0].time}T12:00:00Z`);
    f.setUTCDate(f.getUTCDate() - 1);
    puntos.unshift({ time: f.toISOString().slice(0, 10), value: Math.round((dias[0].balance - dias[0].resultado) * 100) / 100 });
  }
  return puntos;
}

/** Una serie por dia con lightweight-charts: linea (la cuenta) o columnas (el
 *  resultado). Arriba, el valor del dia bajo el puntero (o el ultimo). */
function SerieDiaria({ tipo, datos, referencias = [], moneda }) {
  const caja = useRef(null);
  const motor = useRef(null);
  const [lectura, setLectura] = useState(null);

  useEffect(() => {
    const el = caja.current;
    const ch = createChart(el, {
      height: 230,
      layout: { background: { type: "solid", color: "transparent" }, textColor: C.tenue, fontFamily: 'Geist, Inter, "Segoe UI", system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grilla } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: C.cruzLinea, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
      localization: { locale: "es-CL", priceFormatter: (p) => fmtNum(p, 0) },
      handleScroll: false, handleScale: false,
    });
    const serie = tipo === "linea"
      ? ch.addSeries(LineSeries, { color: AZUL, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4 })
      : ch.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, base: 0 });
    motor.current = { ch, serie, lineas: [] };
    ch.subscribeCrosshairMove((p) => {
      const v = p.time !== undefined ? p.seriesData.get(serie) : null;
      setLectura(v ? { time: p.time, value: v.value } : null);
    });
    const ro = new ResizeObserver(() => ch.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { ro.disconnect(); ch.remove(); motor.current = null; };
  }, [tipo]);

  useEffect(() => {
    const mo = motor.current;
    if (!mo) return;
    mo.serie.setData(datos);
    for (const l of mo.lineas) mo.serie.removePriceLine(l);
    mo.lineas = referencias.map((r) => mo.serie.createPriceLine({
      price: r.precio, color: r.color, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: r.titulo,
    }));
    mo.ch.timeScale().fitContent();
  }, [datos, referencias]);

  const actual = lectura ?? (datos.length ? datos[datos.length - 1] : null);
  return (
    <div className="serie">
      <div className="serie-lectura">
        {actual && (
          <>
            <b className={tipo === "columnas" ? (actual.value >= 0 ? "pos" : "neg") : ""}>
              {tipo === "columnas" ? signo(actual.value) : fmt(actual.value, 2)} {moneda}
            </b>
            <span className="tenue">{typeof actual.time === "string" ? fechaDia(actual.time) : ""}</span>
          </>
        )}
      </div>
      <div ref={caja} className="serie-grafico" />
    </div>
  );
}

/** Las ultimas 8 semanas, de lunes a domingo; cada dia con su resultado. */
function Calendario({ dias, moneda }) {
  const porFecha = useMemo(() => new Map(dias.map((x) => [x.fecha, x])), [dias]);
  const max = Math.max(1, ...dias.map((x) => Math.abs(x.resultado)));
  const hoy = new Date();
  const lunes = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7) - 7 * 7);
  const celdas = [];
  for (let i = 0; i < 56; i++) {
    const f = new Date(lunes);
    f.setUTCDate(lunes.getUTCDate() + i);
    const clave = f.toISOString().slice(0, 10);
    celdas.push({ clave, dia: f.getUTCDate(), x: porFecha.get(clave) });
  }
  return (
    <div className="calendario">
      {DIAS.map((t, i) => <span key={i} className="calendario-cab">{t}</span>)}
      {celdas.map(({ clave, dia, x }) => {
        const v = x?.resultado ?? 0;
        const alfa = x ? 0.18 + 0.6 * (Math.abs(v) / max) : 0;
        const fondo = x ? `rgba(${v >= 0 ? "8,153,129" : "200,71,59"},${alfa.toFixed(2)})` : undefined;
        return (
          <span key={clave} className={`calendario-dia${x ? " con" : ""}`} style={{ background: fondo }}
                title={x ? `${fechaDia(clave)}: ${signo(v)} ${moneda} · ${x.operaciones} operaciones` : fechaDia(clave)}>
            <small>{dia}</small>
            {x && <b>{corto(v)}</b>}
          </span>
        );
      })}
    </div>
  );
}

/** Resultado por mercado, con una barra que crece desde el centro. */
function Mercados({ filas, moneda }) {
  const max = Math.max(1, ...filas.map((x) => Math.abs(x.neto)));
  return (
    <table className="historial-tabla compacta">
      <thead><tr><th>Mercado</th><th>Op.</th><th>Ganadoras</th><th className="num">Resultado</th></tr></thead>
      <tbody>
        {filas.map((x) => (
          <tr key={x.simbolo}>
            <td>{x.simbolo}</td>
            <td>{x.operaciones}</td>
            <td>{fmtNum(x.pctGanadoras, 0)} %</td>
            <td className="num">
              <span className="barra-centro" aria-hidden="true">
                <i className={x.neto >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(x.neto) / max) * 50}%`, [x.neto >= 0 ? "left" : "right"]: "50%" }} />
              </span>
              {signo(x.neto)} {moneda}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Cuantas operaciones cayeron en cada tramo de R: a la izquierda del 0 las que
 *  perdieron (en rojo), a la derecha las que ganaron. */
function Distribucion({ tramos }) {
  const max = Math.max(1, ...tramos.map((t) => t.n));
  const ancho = 360, alto = 130, base = 104, paso = ancho / tramos.length, barra = Math.min(24, paso - 8);
  return (
    <svg className="distribucion" viewBox={`0 0 ${ancho} ${alto}`} role="img"
         aria-label={tramos.map((t) => `${t.rotulo} R: ${t.n}`).join(", ")}>
      <line x1="0" x2={ancho} y1={base + 0.5} y2={base + 0.5} stroke={C.borde} />
      {tramos.map((t, i) => {
        const h = (t.n / max) * (base - 18);
        const x = i * paso + (paso - barra) / 2;
        return (
          <g key={t.rotulo}>
            <title>{`${t.rotulo} R: ${t.n} operaciones`}</title>
            {t.n > 0 && <path d={`M${x},${base} v${-(h - 4)} q0,-4 4,-4 h${barra - 8} q4,0 4,4 v${h - 4} z`} fill={t.desde < 0 ? ROJO : VERDE} />}
            {t.n > 0 && <text x={x + barra / 2} y={base - h - 5} textAnchor="middle" className="distribucion-valor">{t.n}</text>}
            <text x={i * paso + paso / 2} y={alto - 8} textAnchor="middle" className="distribucion-eje">{t.rotulo.replace(" a ", "…")}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Como se cerraron: por SL, por TP, a mano o por stop out. */
function Cierres({ motivos, total }) {
  const filas = Object.entries(motivos).filter(([, n]) => n > 0);
  return (
    <div className="cierres">
      {filas.map(([k, n]) => (
        <span key={k} className="cierre">
          <span>{MOTIVO[k] ?? k}</span>
          <span className="cierre-barra" aria-hidden="true"><i style={{ width: `${(n / Math.max(1, total)) * 100}%` }} /></span>
          <b>{n}</b>
        </span>
      ))}
    </div>
  );
}

function TablaOperaciones({ ops, moneda }) {
  return (
    <div className="historial-tabla-caja">
      <table className="historial-tabla">
        <thead>
          <tr>
            <th>Cierre</th><th>Mercado</th><th>Lado</th><th className="num">Volumen</th><th className="num">Entrada</th>
            <th className="num">Salida</th><th className="num">Resultado</th><th className="num">R</th><th className="num">Pips</th>
            <th>Cerrada por</th><th>Duración</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((o) => (
            <tr key={o.ticket} title={`Ticket ${o.ticket}${o.desdeTerminal ? " · abierta desde la terminal" : ""} · abierta ${fechaHora(o.apertura)}`}>
              <td>{fechaHora(o.cierre)}</td>
              <td>{o.simbolo}</td>
              <td className={o.lado === "compra" ? "lado-compra" : "lado-venta"}>{o.lado === "compra" ? "▲ compra" : "▼ venta"}</td>
              <td className="num">{fmtNum(o.volumen, 2)}</td>
              <td className="num">{fmt(o.entrada, 2)}</td>
              <td className="num">{fmt(o.salida, 2)}</td>
              <td className={`num ${o.resultado >= 0 ? "pos" : "neg"}`}><b>{signo(o.resultado)}</b> <span className="tenue">{moneda}</span></td>
              <td className="num">{o.r === null ? "—" : `${signo(o.r)} R`}</td>
              <td className="num">{o.pips === null ? "—" : signo(o.pips, 1)}</td>
              <td>{MOTIVO[o.cerradaPor] ?? o.cerradaPor}</td>
              <td>{duracion(o.minutos)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
