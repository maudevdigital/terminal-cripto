import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";

/* Calendario economico de FTMO (el de ftmo.com/calendar), en hora local. Marca
   las noticias restringidas: en las cuentas fondeadas FTMO no deja abrir ni
   cerrar operaciones del instrumento afectado 2 minutos antes y despues. */

const ZONA = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const IMPACTOS = [["high", "Alto"], ["medium", "Medio"], ["low", "Bajo"]];
const NIVEL = { high: 3, medium: 2, low: 1 };
const CLAVE = "terminal-cripto:calendario";

const d2 = (n) => String(n).padStart(2, "0");
const aFecha = (f) => `${f.getFullYear()}-${d2(f.getMonth() + 1)}-${d2(f.getDate())}`;
/** El lunes (hora local) de la semana de `f`, corrido `semanas`. */
function lunes(f, semanas = 0) {
  const x = new Date(f.getFullYear(), f.getMonth(), f.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7) + semanas * 7);
  return x;
}
const hora = (ms) => new Date(ms).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dia = (ms) => new Date(ms).toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "2-digit" });
const falta = (ms) => {
  const m = Math.round((ms - Date.now()) / 60_000);
  if (m < 1) return "ahora";
  if (m < 60) return `en ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `en ${h} h ${m % 60} min` : `en ${Math.floor(h / 24)} d`;
};

function cargar() {
  try { return { impactos: ["high", "medium", "low"], restringidas: false, monedas: [], pasados: true, ...JSON.parse(localStorage.getItem(CLAVE) || "{}") }; }
  catch { return { impactos: ["high", "medium", "low"], restringidas: false, monedas: [], pasados: true }; }
}

/** La proxima noticia importante (restringida o de alto impacto) en USD, para la
 *  barra del grafico: los mercados de la terminal cotizan todos en dolares. */
export function proximaNoticia(noticias, ahora = Date.now()) {
  return (noticias ?? []).find((e) => e.moneda === "USD" && e.t >= ahora - 2 * 60_000) ?? null;
}

export function AvisoNoticia({ noticias, onAbrir }) {
  const [, refrescar] = useState(0);
  useEffect(() => { const t = setInterval(() => refrescar((x) => x + 1), 20_000); return () => clearInterval(t); }, []);
  const n = proximaNoticia(noticias);
  if (!n) return null;
  const min = (n.t - Date.now()) / 60_000;
  const urgente = n.restringido && min <= 15;
  return (
    <button className={`aviso-noticia${urgente ? " urgente" : ""}${n.restringido ? " restringida" : ""}`} onClick={onAbrir}
            title={`${n.restringido ? "Noticia restringida por FTMO: en cuentas fondeadas no se puede abrir ni cerrar 2 minutos antes y después.\n" : ""}${dia(n.t)} ${hora(n.t)}`}>
      <Icon name="calendario" size={13} />
      <b>{n.moneda}</b> {n.titulo} · {falta(n.t)}{n.restringido ? " · restringida" : ""}
    </button>
  );
}

export default function Calendario({ onCerrar }) {
  const [semana, setSemana] = useState(0);
  const [f, setF] = useState(cargar);
  const [datos, setDatos] = useState({ cargando: true, eventos: [], error: null });
  const [, refrescar] = useState(0);
  const desde = lunes(new Date(), semana);
  const hasta = new Date(desde); hasta.setDate(hasta.getDate() + 6);
  const rango = `${aFecha(desde)}|${aFecha(hasta)}`;

  useEffect(() => { try { localStorage.setItem(CLAVE, JSON.stringify(f)); } catch { /* sin almacenamiento */ } }, [f]);
  useEffect(() => {
    let vivo = true;
    const [a, b] = rango.split("|");
    const traer = async () => {
      try {
        const r = await fetch(`/api/calendario?desde=${a}&hasta=${b}&zona=${encodeURIComponent(ZONA)}`);
        const j = await r.json();
        if (vivo) setDatos({ cargando: false, eventos: j.eventos ?? [], error: j.error ?? null });
      } catch {
        if (vivo) setDatos((d) => ({ ...d, cargando: false, error: "No se pudo hablar con el servidor" }));
      }
    };
    setDatos((d) => ({ ...d, cargando: true }));
    void traer();
    const t = setInterval(traer, 5 * 60_000);
    return () => { vivo = false; clearInterval(t); };
  }, [rango]);
  useEffect(() => { const t = setInterval(() => refrescar((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const tecla = (e) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onCerrar]);

  const monedas = useMemo(() => {
    const m = [...new Set(datos.eventos.map((e) => e.moneda).filter(Boolean))];
    return m.sort((a, b) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)));
  }, [datos.eventos]);
  const ahora = Date.now();
  // FTMO corta las semanas en su zona horaria: se dejan solo las de la semana local.
  const fin = new Date(hasta); fin.setDate(fin.getDate() + 1);
  const visibles = datos.eventos.filter((e) => e.t >= desde.getTime() && e.t < fin.getTime() && f.impactos.includes(e.impacto)
    && (!f.restringidas || e.restringido)
    && (!f.monedas.length || f.monedas.includes(e.moneda))
    && (f.pasados || e.t >= ahora - 60 * 60_000));
  const siguiente = visibles.find((e) => e.t >= ahora - 2 * 60_000);
  const porDia = [];
  for (const e of visibles) {
    const k = new Date(e.t).toDateString();
    const u = porDia[porDia.length - 1];
    if (u && u.k === k) u.eventos.push(e); else porDia.push({ k, t: e.t, eventos: [e] });
  }
  const alternar = (campo, v) => setF((x) => ({ ...x, [campo]: x[campo].includes(v) ? x[campo].filter((y) => y !== v) : [...x[campo], v] }));
  // Al abrir (o cambiar de semana), baja hasta la proxima noticia.
  const cuerpo = useRef(null);
  const bajado = useRef("");
  useEffect(() => {
    if (datos.cargando || bajado.current === rango) return;
    bajado.current = rango;
    const fila = cuerpo.current?.querySelector(".cal-siguiente");
    if (fila) fila.scrollIntoView({ block: "center" });
  }, [datos.cargando, rango]);
  const fCorta = (x) => x.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" });

  return (
    <section className="historial calendario-eco" aria-label="Calendario económico">
      <div className="historial-barra">
        <h2>Calendario económico · FTMO</h2>
        <div className="segmento" role="group" aria-label="Semana">
          <button onClick={() => setSemana((s) => s - 1)} title="Semana anterior">‹</button>
          <button className={semana === 0 ? "activo" : ""} onClick={() => setSemana(0)}>Esta semana</button>
          <button onClick={() => setSemana((s) => s + 1)} title="Semana siguiente">›</button>
        </div>
        <span className="tenue">{fCorta(desde)} al {fCorta(hasta)} · hora local ({ZONA})</span>
        <a className="cal-fuente" href="https://ftmo.com/es/calendar/" target="_blank" rel="noreferrer">ftmo.com/calendar</a>
        <button className="historial-cerrar" onClick={onCerrar} title="Volver al gráfico (Escape)"><Icon name="x" size={14} /></button>
      </div>
      <div className="cal-filtros">
        <span className="tenue">Impacto</span>
        {IMPACTOS.map(([k, t]) => (
          <button key={k} className={`chip${f.impactos.includes(k) ? " activo" : ""}`} onClick={() => alternar("impactos", k)}>
            <Impacto nivel={k} /> {t}
          </button>
        ))}
        <span className="estilo-sep" />
        <button className={`chip${f.restringidas ? " activo" : ""}`} onClick={() => setF((x) => ({ ...x, restringidas: !x.restringidas }))}
                title="Las que FTMO marca como restringidas">Solo restringidas</button>
        <button className={`chip${!f.pasados ? " activo" : ""}`} onClick={() => setF((x) => ({ ...x, pasados: !x.pasados }))}>Ocultar pasadas</button>
        <span className="estilo-sep" />
        <span className="tenue">Monedas</span>
        <button className={`chip${!f.monedas.length ? " activo" : ""}`} onClick={() => setF((x) => ({ ...x, monedas: [] }))}>Todas</button>
        {monedas.map((m) => (
          <button key={m} className={`chip${f.monedas.includes(m) ? " activo" : ""}`} onClick={() => alternar("monedas", m)}
                  title={m === "USD" ? "Mueve todos tus mercados: BTC, oro, plata y los índices de EE. UU. cotizan en dólares" : undefined}>{m}</button>
        ))}
      </div>
      <div ref={cuerpo} className={`historial-cuerpo${datos.cargando ? " cargando" : ""}`}>
        {datos.error && <span className="op-error">Calendario de FTMO: {datos.error}</span>}
        <p className="tenue cal-ayuda">
          <span className="cal-restringida">Restringida</span> FTMO no deja abrir ni cerrar operaciones del instrumento afectado
          2 minutos antes y 2 después de la noticia, en las cuentas fondeadas.
        </p>
        {!datos.cargando && !porDia.length && <div className="historial-vacio tenue">No hay eventos con estos filtros.</div>}
        {porDia.map((g) => (
          <div key={g.k} className="historial-tarjeta cal-dia">
            <div className="historial-titulo"><b className="cal-nombre-dia">{dia(g.t)}</b><span className="tenue">{g.eventos.length} eventos</span></div>
            <table className="historial-tabla cal-tabla">
              <thead><tr><th>Hora</th><th>Moneda</th><th>Impacto</th><th>Evento</th><th className="num">Actual</th><th className="num">Pronóstico</th><th className="num">Previo</th></tr></thead>
              <tbody>
                {g.eventos.map((e) => {
                  const pasado = e.t < ahora - 2 * 60_000;
                  const esSiguiente = e === siguiente;
                  return (
                    <tr key={`${e.t}|${e.moneda}|${e.titulo}`} className={`${pasado ? "cal-pasado" : ""}${esSiguiente ? " cal-siguiente" : ""}`}>
                      <td className="cal-hora">{hora(e.t)}{esSiguiente && <span className="cal-falta"> · {falta(e.t)}</span>}</td>
                      <td className="cal-moneda"><b className={e.moneda === "USD" ? "cal-usd" : ""}>{e.moneda}</b></td>
                      <td className="cal-impacto"><Impacto nivel={e.impacto} /> <span className="tenue">{IMPACTOS.find(([k]) => k === e.impacto)?.[1] ?? e.impacto}</span></td>
                      <td className="cal-evento">{e.titulo}{e.restringido && <span className="cal-restringida">Restringida</span>}{e.tipo === "holiday" && <span className="tenue"> · feriado</span>}</td>
                      <td className="num cal-v" data-l="Actual">
                        <b>{e.actual ?? "—"}</b>
                        {e.fuenteActual === "mt5" && (
                          <span title="FTMO todavía no lo publica: el dato viene del calendario de MT5"
                                className="ml-1.5 rounded border border-borde px-1 align-[1px] text-[9.5px] font-semibold text-apagado">MT5</span>
                        )}
                      </td>
                      <td className="num cal-v" data-l="Pronóstico">{e.pronostico ?? "—"}</td>
                      <td className="num tenue cal-v" data-l="Previo">{e.previo ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Tres barritas, como en el calendario de FTMO: cuantas llenas = impacto. */
function Impacto({ nivel }) {
  const n = NIVEL[nivel] ?? 1;
  return (
    <span className={`impacto i${n}`} role="img" aria-label={`impacto ${nivel}`}>
      {[1, 2, 3].map((k) => <i key={k} className={k <= n ? "lleno" : ""} />)}
    </span>
  );
}
