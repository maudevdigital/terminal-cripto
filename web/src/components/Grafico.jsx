import { useCallback, useEffect, useRef, useState } from "react";
import { ChartEngine } from "../chart/ChartEngine.js";
import { COLORES, PALETA, IZQ_LIBRE } from "../chart/Dibujos.js";
import { NOMBRE_HERRAMIENTA } from "./BarraDibujo.jsx";
import Icon from "./Icon.jsx";
import CambioOrden, { CambioBinance } from "./CambioOrden.jsx";
import { enviar, enviarBinance } from "../lib/operativa.js";
import { AvisoNoticia } from "./Calendario.jsx";
import { C, CAPAS } from "../lib/constants.js";
import SelectorTemporalidad from "./SelectorTemporalidad.jsx";
import { etiqueta, segundos } from "../lib/temporalidades.js";
import { RANGOS } from "../chart/ChartEngine.js";
import { fmt, fmtNum, localFmt } from "../lib/format.js";
import { estadoHorario } from "../lib/horario.js";
import { armarGrafico, desdeGrafico } from "../lib/graficoVelas.js";

// La barra de dibujo flotante del celular: [herramienta, nombre, atajo]. En la compu
// va la barra acoplada (BarraDibujo), con todas las herramientas.
const HERRAMIENTAS = [
  ["cursor", "Cursor", "Esc"],
  ["hline", "Línea horizontal", "Alt+H"],
  ["linea", "Línea de tendencia (con Shift, horizontal)", "Alt+T"],
  ["rect", "Recuadro con su línea central", "Alt+R"],
];
// Alt + tecla: las herramientas.
const ATAJO_HERRAMIENTA = { KeyH: "hline", KeyT: "linea", KeyR: "rect", KeyV: "vline", KeyC: "cruz" };
const claveDibujos = (symbol) => `terminal-cripto:dibujos:${symbol}`;
function cargarDibujos(symbol) {
  try {
    const lista = JSON.parse(localStorage.getItem(claveDibujos(symbol)) || "[]");
    return Array.isArray(lista) ? lista : [];
  } catch { return []; }
}

// En la barra, mensual, semanal y diario van con una letra (como en TradingView).
const CORTO = { "1M": "M", "1w": "S", "1d": "D" };

/** Grafico con sus controles: temporalidad, capas y el panel inferior. El motor
 *  se crea una vez; la data le llega directo desde App. */
export default function Grafico({
  cfg, interval, onInterval, capas, onCapa, vp, onVp, completo, onCompleto, engineRef, payload, symbol, aviso, onSymbol, presentacion, onPresentacion, onHistorial, onCalendario,
  replay, onReplay, barraReplay, onMasHistoria, zonas, onZonas, conRail, onBuscar, onMoverBorrador, onOrdenEnPrecio,
  // Varios graficos: el activo recibe los atajos del teclado; los compactos (los
  // extra de la grilla) van sin barra de dibujo ni rangos, con mercado y temporalidad.
  activo = true, compacto = false, diseno, onDiseno,
  // En la compu la barra de dibujo es una sola, la de la grilla (App): sus ajustes
  // llegan aca y la herramienta de este grafico se le avisa cuando es el activo.
  ajustes = null, onHerramientaActiva, rangos = true,
  // Las temporalidades fijadas: botones en la barra, al lado del menu.
  fijas = [], onFijas,
}) {
  const priceRef = useRef(null), oscRef = useRef(null), canvasRef = useRef(null), fondoRef = useRef(null);
  const lineasRef = useRef(null), dibujoRef = useRef(null), posRef = useRef(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  // Las velas anteriores (al llegar al borde izquierdo) las trae App: aca solo el aviso.
  const masRef = useRef(onMasHistoria);
  masRef.current = onMasHistoria;
  // La orden que se arma en Operar, arrastrada en el grafico: el precio va al formulario.
  const moverRef = useRef(onMoverBorrador);
  moverRef.current = onMoverBorrador;
  // El boton + del eje (como en TradingView): sigue a la cruz y arma una orden
  // limite a ese precio en Operar. Mientras el mouse esta sobre el, no se mueve.
  const [cruz, setCruz] = useState(null);
  const sobreMas = useRef(false);
  // La ✕ de la etiqueta de una operacion: la cierra a mercado (o cancela la orden) de
  // una, y avisa el resultado arriba al centro.
  const [cierre, setCierre] = useState(null);   // { enviando, ok, texto }
  const cerrarOperacion = useCallback(async (x) => {
    setCierre({ enviando: true, texto: `${x.accion === "cancelar" ? "Cancelando" : "Cerrando"} la ${x.nombre}…` });
    const r = x.binance
      ? await enviarBinance({ accion: x.accion, symbol: x.symbol, lado: x.lado })
      : await enviar(x.accion === "cancelar" ? { accion: "cancelar", ticket: x.ticket } : { accion: "cerrar", ticket: x.ticket, volumen: 0 });
    setCierre({ ok: r.ok, texto: r.mensaje ?? (r.ok ? "Listo" : "No se pudo") });
  }, []);
  const cerrarRef = useRef(cerrarOperacion);
  cerrarRef.current = cerrarOperacion;
  useEffect(() => {
    if (!cierre || cierre.enviando) return undefined;
    const t = setTimeout(() => setCierre(null), cierre.ok ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [cierre]);
  const [cargandoViejas, setCargandoViejas] = useState(false);
  const [herramienta, setHerramienta] = useState("cursor");
  // En el celular la barra de dibujo va plegada (un lapiz), para no tapar el grafico.
  const [barraAbierta, setBarraAbierta] = useState(false);
  // El dibujo seleccionado (para la barra de estilo): { id, tipo, color, ancho }.
  const [seleccion, setSeleccion] = useState(null);
  const [iman, setIman] = useState(() => { try { return localStorage.getItem("terminal-cripto:iman") !== "0"; } catch { return true; } });
  // La escala del precio invertida (Alt+I).
  const [invertido, setInvertido] = useState(() => { try { return localStorage.getItem("terminal-cripto:invertido") === "1"; } catch { return false; } });
  // Todos los dibujos bloqueados: no se mueven ni se borran.
  const [bloqueo, setBloqueo] = useState(() => { try { return localStorage.getItem("terminal-cripto:bloqueo-dibujos") === "1"; } catch { return false; } });
  // Seguir dibujando (la herramienta queda despues de cada dibujo), los dibujos ocultos y la barra plegada.
  const guardado = (k) => { try { return localStorage.getItem(`terminal-cripto:${k}`) === "1"; } catch { return false; } };
  const [seguir] = useState(() => guardado("seguir-dibujando"));
  const [ocultos] = useState(() => guardado("dibujos-ocultos"));
  // Con la barra de la grilla mandan sus ajustes; si no (celular), los de aca.
  const imanV = ajustes ? ajustes.iman : iman, bloqueoV = ajustes ? ajustes.bloqueo : bloqueo;
  const seguirV = ajustes ? ajustes.seguir : seguir, ocultosV = ajustes ? ajustes.ocultos : ocultos;
  const [vela, setVela] = useState(null);
  const [siguiendo, setSiguiendo] = useState(true);
  // SL, TP o precio arrastrado en el grafico, esperando confirmacion.
  const [cambio, setCambio] = useState(null);

  useEffect(() => {
    const engine = new ChartEngine(
      {
        price: priceRef.current, osc: oscRef.current, canvas: canvasRef.current, fondo: fondoRef.current,
        lineas: lineasRef.current, dibujo: dibujoRef.current, posiciones: posRef.current,
      },
      {
        onCrosshair: setVela, onSeguir: setSiguiendo, onModificar: setCambio, onHerramienta: setHerramienta,
        onMasHistoria: (t) => masRef.current?.(t), onCargando: setCargandoViejas,
        onMoverBorrador: (x) => moverRef.current?.(x),
        onCruz: (c) => { if (!sobreMas.current) setCruz(c); },
        onCerrarOperacion: (x) => cerrarRef.current?.(x),
        recalcularGrafico: (velas) => armarGrafico(velas.map(desdeGrafico), cfg),
        onSeleccion: (d) => setSeleccion(d ? { id: d.id, tipo: d.tipo, color: d.color, ancho: d.ancho, bloqueado: Boolean(d.bloqueado) } : null),
        // Los dibujos se guardan por mercado: en tiempo y precio, valen en todas las temporalidades.
        onDibujos: (lista) => { try { localStorage.setItem(claveDibujos(symbolRef.current), JSON.stringify(lista)); } catch { /* sin almacenamiento */ } },
      },
    );
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, [engineRef]);

  useEffect(() => { engineRef.current?.setCapas(capas, { ...vp, filas: cfg.vp_filas }); }, [engineRef, capas, vp, cfg.vp_filas]);
  useEffect(() => { engineRef.current?.setZonas(zonas); }, [engineRef, zonas]);
  useEffect(() => {
    // Mientras llega la nueva foto no se muestran velas ni precios del mercado anterior.
    engineRef.current?.vaciar();
    setVela(null);
    setCruz(null);
    setCierre(null);
    sobreMas.current = false;
  }, [engineRef, symbol, interval]);
  const cerrarCambio = useCallback((mandado) => {
    engineRef.current?.resolverCambio(mandado);
    setCambio(null);
  }, [engineRef]);
  // Otro mercado: lo que se estaba por confirmar se descarta.
  useEffect(() => { cerrarCambio(false); }, [symbol, presentacion, cerrarCambio]);
  useEffect(() => { engineRef.current?.dibujos?.set(cargarDibujos(symbol)); }, [engineRef, symbol]);
  useEffect(() => {
    engineRef.current?.dibujos?.setIman(imanV);
    try { localStorage.setItem("terminal-cripto:iman", imanV ? "1" : "0"); } catch { /* sin almacenamiento */ }
  }, [engineRef, imanV]);
  useEffect(() => {
    engineRef.current?.setInvertido(invertido);
    try { localStorage.setItem("terminal-cripto:invertido", invertido ? "1" : "0"); } catch { /* sin almacenamiento */ }
  }, [engineRef, invertido]);
  useEffect(() => {
    engineRef.current?.dibujos?.setBloqueo(bloqueoV);
    try { localStorage.setItem("terminal-cripto:bloqueo-dibujos", bloqueoV ? "1" : "0"); } catch { /* sin almacenamiento */ }
  }, [engineRef, bloqueoV]);
  useEffect(() => {
    engineRef.current?.dibujos?.setSeguir(seguirV);
    engineRef.current?.dibujos?.setOcultos(ocultosV);
  }, [engineRef, seguirV, ocultosV]);
  // La herramienta de este grafico, para la barra de la grilla (cuando es el activo).
  useEffect(() => { if (activo) onHerramientaActiva?.(herramienta); }, [activo, herramienta, onHerramientaActiva]);
  // Con la barra acoplada (la compu) no tapa el grafico: las etiquetas empiezan en el borde.
  useEffect(() => {
    const e = engineRef.current;
    if (e) { e.izqLibre = conRail ? 6 : IZQ_LIBRE; e.agendarDibujo(); }
  }, [engineRef, conRail]);
  const activoRef = useRef(activo);
  activoRef.current = activo;
  const borrarTodos = () => {
    const hayFijos = engineRef.current?.dibujos?.lista.some((d) => d.bloqueado);
    if (window.confirm(`¿Borrar los dibujos de este mercado?${hayFijos ? " Los bloqueados quedan." : ""}`)) engineRef.current?.dibujos?.borrarTodo();
  };
  useEffect(() => {
    const tecla = (e) => {
      if (!activoRef.current) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.key === "Escape") engineRef.current?.dibujos?.cancelar();
      // Alt+I da vuelta la escala del precio, como en TradingView.
      if (e.altKey && e.code === "KeyI") { e.preventDefault(); setInvertido((x) => !x); return; }
      // Alt+H, Alt+T y Alt+R: las herramientas de dibujo.
      if (e.altKey && ATAJO_HERRAMIENTA[e.code]) { e.preventDefault(); engineRef.current?.dibujos?.setHerramienta(ATAJO_HERRAMIENTA[e.code]); return; }
      // Supr o Backspace borran el dibujo seleccionado, como en TradingView.
      if ((e.key === "Delete" || e.key === "Backspace") && engineRef.current?.dibujos?.borrarSeleccion()) e.preventDefault();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [engineRef]);
  const elegirHerramienta = (h) => engineRef.current?.dibujos?.setHerramienta(h);
  useEffect(() => { engineRef.current?.setNivelAdx(cfg.adx_clave); }, [engineRef, cfg.adx_clave]);

  const mercado = cfg.mercados[symbol];
  const cripto = mercado?.tipo === "cripto";
  const esUsdtd = symbol === "USDT.D";

  const ultima = payload?.grafico?.velas?.at(-1);
  const digitos = engineRef.current?.decimals ?? 2;
  // El ADX de la vela bajo el puntero (o el de la ultima).
  const adx = vela?.adx ?? payload?.grafico?.fuerza?.at(-1)?.value;
  const v = vela || ultima;
  const nombreCorto = esUsdtd ? "USDT.D" : mercado?.nombre ?? symbol;
  const nombre = esUsdtd ? "USDT.D" : cripto ? `${mercado.nombre}/USDT`
    : mercado?.tipo === "materia" ? `${mercado.nombre} · ${mercado.fuente}` : mercado?.nombre ?? symbol;
  // Una cotización antigua puede ser un mercado cerrado o una interrupción de datos.
  // El horario real del broker se muestra aparte cuando está disponible.
  const ultimoDato = payload?.fuente?.ultimoDato;
  const cerrado = !payload?.replay && payload?.fuente && (!ultimoDato || Date.now() - ultimoDato > (payload.fuente.broker ? 5 : 25) * 60_000);
  // Cotizacion del broker cuando el grafico es de otra fuente (Binance o Yahoo).
  const br = payload?.symbol === symbol ? payload?.broker : null;
  const conBroker = br?.disponible && br.vivo && br.simbolo && br.bid !== null && !br.graficoBroker;
  // Abierto, cierra pronto o cerrado en FTMO (sesiones de MT5).
  const hor = br?.disponible ? estadoHorario(br.horario) : null;

  const boton = (i, habilitado) => (
    <button key={i} className={i === interval ? "activo" : ""} disabled={!habilitado} onClick={() => onInterval(i)}
            title={cfg.interval_labels[i]}>
      {CORTO[i] ?? cfg.interval_labels[i]}
    </button>
  );

  return (
    <section className="grafico @container">
      {/* En la compu la barra es una sola, arriba de la grilla (BarraPrincipal, en App);
          aca, la del celular. */}
      {!conRail && (
        <div className="grafico-barra">
          <div className="temporalidades">
            <div className="segmento">
              {cfg.intervals.map((i) => boton(i, !esUsdtd || cfg.usdtd.intervals.includes(i)))}
            </div>
          </div>
          <div className="capas">
            <div className="segmento chico vista" title="Vista del gráfico">
              <button onClick={() => engineRef.current?.verTodo()} title="Toda la historia cargada">
                <Icon name="todo" size={13} /> Ver todo
              </button>
              <button className={completo ? "activo" : ""} onClick={onCompleto} title={completo ? "Volver al panel" : "Gráfico completo"}>
                <Icon name={completo ? "contraer" : "expandir"} size={13} /> {completo ? "Salir" : "Completo"}
              </button>
              {onReplay && (
                <button className={replay ? "activo" : ""} onClick={onReplay} title={replay ? "Salir del replay" : "Replay"}>
                  <Icon name="replay" size={13} /> Replay
                </button>
              )}
              <button onClick={onCalendario} title="Calendario económico de FTMO, con las noticias restringidas">
                <Icon name="calendario" size={13} /> Calendario
              </button>
              {!presentacion && (
                <button onClick={onHistorial} title="Historial de operaciones, métricas y Google Sheets">
                  <Icon name="historial" size={13} /> Historial
                </button>
              )}
              {/* Para grabar: oculta la cuenta, las posiciones y los montos (Shift+P). */}
              <button className={presentacion ? "activo presentacion-on" : ""} onClick={onPresentacion}
                      title={presentacion ? "Modo presentación: tu cuenta y tus operaciones están ocultas" : "Modo presentación: oculta tu cuenta y tus operaciones para grabar"}>
                <Icon name={presentacion ? "oculto" : "visible"} size={13} />
              </button>
            </div>
            <MenuCapas lista={CAPAS} capas={capas} onCapa={onCapa}
                       vp={vp} onVp={onVp} zonas={zonas} onZonas={onZonas} filas={cfg.vp_filas} />
            <AvisoNoticia noticias={payload?.noticias} onAbrir={onCalendario} />
          </div>
        </div>
      )}
      {barraReplay}

      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="panel-precio">
        <canvas className="capa-fondo" ref={fondoRef} />
        <div className="leyendas">
          <div className="leyenda">
            <b>{nombre}</b>
            <span className="tenue">{cfg.interval_labels[interval] ?? etiqueta(interval)}</span>
            {v && (
              <span className={`ohlc ${v.close >= v.open ? "pos" : "neg"}`}>
                <i>A</i>{fmt(v.open, digitos)} <i>M</i>{fmt(v.high, digitos)} <i>m</i>{fmt(v.low, digitos)} <i>C</i>{fmt(v.close, digitos)}
              </span>
            )}
            {payload?.fuente && (
              <span className="tenue">
                {payload.fuente.nombre}{cerrado ? " · sin datos recientes" : ""}
                {ultimoDato && (cerrado || !payload.fuente.broker) ? ` · último dato ${localFmt.format(new Date(ultimoDato))}` : ""}
              </span>
            )}
            {hor && (
              <span className={`horario-mercado ${hor.estado}`} title="Horario de trading del símbolo en el broker (MT5). Con el mercado cerrado no se puede cancelar ni modificar nada.">
                <i />{br.simbolo} · {hor.texto}
              </span>
            )}
            {conBroker && (
              <span className="tenue leyenda-broker" title="Cotización del broker en MT5 y cuánto se separa del precio del gráfico">
                {br.simbolo} <b>{fmt(br.bid, br.digitos ?? undefined)}</b>
                {br.diferencia !== null ? ` · dif ${br.diferencia >= 0 ? "+" : ""}${fmt(br.diferencia, br.digitos ?? undefined)}` : ""}
              </span>
            )}
            {invertido && <span className="neg">Escala invertida · Alt+I para volver</span>}
            {capas.medias && (
              <span className="leyenda-medias">
                {cfg.ema.map((n, i) => <span key={n}><i style={{ background: C.emas[i] }} />EMA {n}</span>)}
              </span>
            )}
          </div>
        </div>
        <div className="lienzo" ref={priceRef} />
        <canvas className="capa-canvas" ref={canvasRef} />
        <canvas className="capa-posiciones" ref={posRef} />
        <div className="capa-lineas" ref={lineasRef} />
        {/* En el celular el grafico completo no tiene barras: este boton lo deja. */}
        {completo && (
          <button className="salir-completo" onClick={onCompleto} title="Salir del gráfico completo">
            <Icon name="contraer" size={16} /> Salir
          </button>
        )}
        <div className="capa-dibujo" ref={dibujoRef} />
        {!conRail && <div className={`barra-dibujo${barraAbierta ? " abierta" : ""}`} role="toolbar" aria-label="Herramientas de dibujo">
          <button className={`alternar${barraAbierta ? " activo" : ""}`} aria-expanded={barraAbierta}
                  title={barraAbierta ? "Plegar las herramientas" : "Herramientas de dibujo"} onClick={() => setBarraAbierta((x) => !x)}>
            <Icon name={barraAbierta ? "x" : "linea"} size={15} />
          </button>
          {HERRAMIENTAS.map(([id, ayuda, atajo]) => (
            <button key={id} className={herramienta === id ? "activo" : ""} data-tip={ayuda} data-atajo={atajo} data-lado="derecha"
                    aria-label={ayuda} aria-pressed={herramienta === id}
                    onClick={() => elegirHerramienta(id)}>
              <Icon name={id} size={15} />
            </button>
          ))}
          <span className="barra-dibujo-sep" />
          <button className={`iman${iman ? " activo" : ""}`} onClick={() => setIman((x) => !x)} aria-pressed={iman} data-lado="derecha"
                  data-tip={iman ? "Imán: cada punto se pega al OHLC de la vela" : "Imán apagado"} aria-label="Imán">
            <Icon name="iman" size={15} />
          </button>
          <button className={bloqueo ? "activo" : ""} onClick={() => setBloqueo((x) => !x)} aria-pressed={bloqueo} data-lado="derecha" aria-label="Bloquear los dibujos"
                  data-tip={bloqueo ? "Dibujos bloqueados: no se mueven ni se borran" : "Bloquear todos los dibujos"}>
            <Icon name={bloqueo ? "candado" : "candadoAbierto"} size={15} />
          </button>
          <button aria-label="Borrar los dibujos" disabled={bloqueo} onClick={borrarTodos}>
            <Icon name="papelera" size={15} />
          </button>
        </div>}
        {seleccion && (
          <div className="estilo-dibujo" role="toolbar" aria-label={`Estilo: ${NOMBRE_HERRAMIENTA[seleccion.tipo] ?? "dibujo"}`}>
            <span className="tenue">{NOMBRE_HERRAMIENTA[seleccion.tipo] ?? "Dibujo"}</span>
            {seleccion.tipo === "texto" && (
              <button title="Cambiar el texto" onClick={() => {
                const t = window.prompt("Texto", engineRef.current?.dibujos?.seleccionado()?.texto ?? "");
                if (t?.trim()) engineRef.current?.dibujos?.setEstilo({ texto: t.trim() });
              }}>Editar</button>
            )}
            {PALETA.map((col) => {
              const actual = (seleccion.color ?? COLORES[seleccion.tipo]) === col;
              return (
                <button key={col} className={`muestra${actual ? " activo" : ""}`} style={{ background: col }} aria-pressed={actual}
                        title="Color" onClick={() => engineRef.current?.dibujos?.setEstilo({ color: col })} />
              );
            })}
            <span className="estilo-sep" />
            {[1, 2, 3].map((g) => {
              const actual = Math.round(seleccion.ancho ?? (seleccion.tipo === "hline" ? 1.6 : 1.8)) === g;
              return (
                <button key={g} className={`grosor${actual ? " activo" : ""}`} title={`Grosor ${g}`} aria-pressed={actual}
                        onClick={() => engineRef.current?.dibujos?.setEstilo({ ancho: g })}>
                  <i style={{ height: g + 0.5 }} />
                </button>
              );
            })}
            <span className="estilo-sep" />
            <button className={seleccion.bloqueado ? "activo" : ""} aria-pressed={seleccion.bloqueado}
                    title={seleccion.bloqueado ? "Bloqueado: no se mueve ni se borra (click para desbloquear)" : "Bloquear: que no se mueva ni se borre"}
                    onClick={() => engineRef.current?.dibujos?.setEstilo({ bloqueado: !seleccion.bloqueado })}>
              <Icon name={seleccion.bloqueado ? "candado" : "candadoAbierto"} size={14} />
            </button>
            <button title="Duplicar" onClick={() => engineRef.current?.dibujos?.duplicar()}><Icon name="copy" size={14} /></button>
            <button title={seleccion.bloqueado || bloqueo ? "Desbloquéalo para borrarlo" : "Borrar (Supr)"} disabled={seleccion.bloqueado || bloqueo}
                    onClick={() => engineRef.current?.dibujos?.borrarSeleccion()}><Icon name="papelera" size={14} /></button>
          </div>
        )}
        {cambio && (cambio.item?.binance ? (
          <CambioBinance cambio={cambio} binance={payload?.binance ?? null} alto={priceRef.current?.clientHeight} onCerrar={cerrarCambio} />
        ) : (
          <CambioOrden cambio={cambio} broker={payload?.symbol === symbol ? payload.broker : null}
                       alto={priceRef.current?.clientHeight} onCerrar={cerrarCambio} />
        ))}
        {aviso && <div className="aviso-grafico">{aviso}</div>}
        {cierre && (
          <div className={`absolute top-3 left-1/2 z-[8] -translate-x-1/2 animate-entra rounded-md border px-3 py-1.5 text-[12px] shadow-desk
                           ${cierre.enviando ? "border-borde bg-vidrio text-tenue" : cierre.ok ? "border-[rgba(var(--rgb-sube),.5)] bg-vidrio text-sube" : "border-[rgba(var(--rgb-baja),.5)] bg-vidrio text-baja"}`}>
            {cierre.enviando ? cierre.texto : `${cierre.ok ? "✓" : "✗"} ${cierre.texto}`}
          </div>
        )}
        {onOrdenEnPrecio && cruz && herramienta === "cursor" && (
          <button onClick={() => { onOrdenEnPrecio(cruz.precio); sobreMas.current = false; setCruz(null); }}
                  onMouseEnter={() => { sobreMas.current = true; }} onMouseLeave={() => { sobreMas.current = false; setCruz(null); }}
                  data-tip={`Orden límite a ${fmt(cruz.precio, digitos)}`} data-lado="izquierda" aria-label="Orden límite a este precio"
                  style={{ top: cruz.y - 10, left: cruz.borde - 24 }}
                  className="absolute z-[7] grid size-5 cursor-pointer place-items-center rounded border border-borde bg-panel-3 p-0 text-texto shadow-desk hover:bg-texto hover:text-fondo">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        )}
        {cargandoViejas && <div className="cargando-viejas">Cargando velas anteriores…</div>}
        {!siguiendo && (
          <button className="volver" onClick={() => engineRef.current?.volverAlPrecio()}>Volver al precio</button>
        )}
      </div>

      <div className={`panel-osc${capas.osc ? "" : " oculto"}`}>
        <div className="leyenda">
          <span title="Squeeze Momentum de LazyBear, con multiplicadores BB y KC independientes">SQZ <span className="tenue ayuda-oscilador">LazyBear · momentum</span></span>
          <span><i style={{ background: C.adx["#E8EAED"] }} />ADX <b>{Number.isFinite(adx) ? fmtNum(adx, 1) : "—"}</b>
            <span className="tenue ayuda-oscilador" title="El ADX va en la escala del SQZ para que se muevan juntos; aquí se lee su valor real"> · referencia {cfg.adx_clave}</span></span>
          <span className="tenue ayuda-oscilador"><i className="punto" style={{ background: C.compresion["#FF9800"] }} />compresión</span>
        </div>
        <div className="lienzo" ref={oscRef} />
      </div>
      </div>
      </div>
      {conRail && !compacto && rangos && (
        <div className="flex h-8 flex-none items-center gap-0.5 border-t border-borde px-2">
          {RANGOS.map(([nom, i, rango]) => {
            const ok = !esUsdtd || cfg.usdtd.intervals.includes(i);
            return (
              <button key={nom} disabled={!ok} title={`${nom === "Todo" ? "Toda la historia" : `Último ${nom}`} en ${cfg.interval_labels[i]}`}
                      onClick={() => { if (i !== interval) onInterval(i); engineRef.current?.setRango(rango, i); }}
                      className="h-6 cursor-pointer rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-tenue hover:bg-hover hover:text-texto disabled:cursor-default disabled:opacity-35">
                {nom}
              </button>
            );
          })}
          <span className="flex-1" />
          <Reloj />
        </div>
      )}
    </section>
  );
}

/** Las capas del grafico en un menu (en vez de un chip por capa): cada una con su
 *  ayuda y, debajo, sus opciones (los perfiles de volumen y los FVG). */
function MenuCapas({ lista, capas, onCapa, vp, onVp, zonas, onZonas, filas }) {
  const [abierto, setAbierto] = useState(false);
  // Hacia donde se abre: a la izquierda del boton si hay lugar dentro del grafico; si
  // no (un grafico angosto de la grilla, con el boton a la izquierda), hacia la derecha.
  const [haciaDerecha, setHaciaDerecha] = useState(false);
  const caja = useRef(null);
  const alternar = () => {
    if (!abierto) {
      const b = caja.current?.getBoundingClientRect();
      const g = caja.current?.closest("section.grafico")?.getBoundingClientRect();
      setHaciaDerecha(Boolean(b && g && b.right - 250 < g.left));
    }
    setAbierto((a) => !a);
  };
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (!caja.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === "Escape") setAbierto(false); };
    window.addEventListener("pointerdown", fuera);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", fuera); window.removeEventListener("keydown", esc); };
  }, [abierto]);
  const prendidas = lista.filter((c) => capas[c.id]).length;
  return (
    <div className="relative" ref={caja}>
      <button className={`chip inline-flex items-center gap-1.5${abierto ? " activo" : ""}`} onClick={alternar} aria-expanded={abierto}
              data-tip="Capas del gráfico">
        <Icon name="capas" size={13} /> <span className="@max-3xl:hidden">Capas</span>
        <em className="font-mono text-[10.5px] text-apagado not-italic">{prendidas}/{lista.length}</em>
      </button>
      {abierto && (
        <div role="menu"
             className={`absolute top-[calc(100%+6px)] ${haciaDerecha ? "left-0" : "right-0"} z-40 flex min-w-[240px] animate-entra flex-col gap-0.5 rounded-[10px] border border-borde bg-vidrio p-1.5 shadow-desk`}>
          {[...lista.filter((c) => ["estructura", "ob", "osc", "fvg", "posiciones"].includes(c.id)),
            ...lista.filter((c) => !["estructura", "ob", "osc", "fvg", "posiciones"].includes(c.id))].map((c, index) => (
            <div key={c.id} className="flex flex-col gap-1.5 rounded-md px-2 py-1.5 hover:bg-hover">
              {index === 5 && <span className="border-t border-borde pt-2 text-[10.5px] text-tenue">Opciones avanzadas</span>}
              <label title={c.ayuda} className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-texto">
                <input type="checkbox" checked={Boolean(capas[c.id])} onChange={() => onCapa(c.id)} className="m-0 accent-texto" />
                <span>{c.nombre}</span>
              </label>
              {c.id === "volumen" && capas.volumen && (
                <div className="segmento chico ml-[22px] self-start">
                  {/* Independientes: se pueden ver los dos a la vez, como en TradingView. */}
                  <button className={vp.vpvr ? "activo" : ""} onClick={() => onVp({ ...vp, vpvr: !vp.vpvr })}
                          title={`Perfil del rango visible (VPVR) · ${filas} filas, área de valor 70 %`}>VPVR</button>
                  <button className={vp.vpsv ? "activo" : ""} onClick={() => onVp({ ...vp, vpsv: !vp.vpsv })}
                          title={`Un perfil por sesión (VPSV) · ${filas} filas, área de valor 70 %`}>VPSV</button>
                  {vp.vpsv && (
                    <button className={vp.extPoc ? "activo" : ""} onClick={() => onVp({ ...vp, extPoc: !vp.extPoc })}
                            title="Extender el POC de cada sesión hacia la derecha hasta que el precio lo toque. Los que nadie tocó (POC vírgenes) llegan al borde con su precio en el eje">
                      POC ⟶
                    </button>
                  )}
                </div>
              )}
              {c.id === "estructura" && capas.estructura && (
                <div className="segmento chico ml-[22px] self-start">
                  <button className={zonas.estrSwing !== false ? "activo" : ""} onClick={() => onZonas({ ...zonas, estrSwing: zonas.estrSwing === false })}
                          title="La estructura principal: giros de 50 velas, con HH/HL/LH/LL y el máximo y el mínimo fuerte o débil">Swing</button>
                  <button className={zonas.estrInterna ? "activo" : ""} onClick={() => onZonas({ ...zonas, estrInterna: !zonas.estrInterna })}
                          title="La estructura interna: giros de 5 velas, punteada">Interna</button>
                </div>
              )}
              {c.id === "fvg" && capas.fvg && (
                <div className="segmento chico ml-[22px] self-start">
                  <button className={zonas.fvg ? "activo" : ""} onClick={() => onZonas({ ...zonas, fvg: !zonas.fvg })}
                          title="Los FVG que el precio todavía no barre: verde alcista, rojo bajista">FVG</button>
                  <button className={zonas.ifvg ? "activo" : ""} onClick={() => onZonas({ ...zonas, ifvg: !zonas.ifvg })}
                          title="Los FVG que una vela atravesó con su cierre: invertidos (color contrario y borde punteado), hasta que una mecha los atraviesa de vuelta">IFVG</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** La hora de esta PC (la del eje del grafico), al segundo. */
function Reloj() {
  const [ahora, setAhora] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setAhora(new Date()), 1000); return () => clearInterval(t); }, []);
  const zona = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop().replace(/_/g, " ");
  return (
    <span className="px-2 font-mono text-[12px] text-texto tabular-nums" title={`Hora local (${zona}): la del eje del gráfico`}>
      {RELOJ.format(ahora)} <span className="text-apagado">{zona}</span>
    </span>
  );
}
const RELOJ = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// Los disenos de la grilla: columnas x filas.
export const DISENOS = {
  "1": { n: 1, cols: 1, filas: 1, nombre: "Un gráfico" },
  "2": { n: 2, cols: 2, filas: 1, nombre: "Dos, lado a lado" },
  "2v": { n: 2, cols: 1, filas: 2, nombre: "Dos, uno arriba del otro" },
  "3": { n: 3, cols: 3, filas: 1, nombre: "Tres, lado a lado" },
  "4": { n: 4, cols: 2, filas: 2, nombre: "Cuatro (2 × 2)" },
  "6": { n: 6, cols: 3, filas: 2, nombre: "Seis (3 × 2)" },
};

/** El selector del diseno: cuantos graficos y como se reparten. */
function SelectorDiseno({ diseno, onDiseno }) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef(null);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (!caja.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener("pointerdown", fuera);
    return () => window.removeEventListener("pointerdown", fuera);
  }, [abierto]);
  const Mini = ({ d, tam = 16 }) => (
    <svg width={tam} height={tam} viewBox="0 0 16 16" aria-hidden="true">
      {Array.from({ length: d.cols * d.filas }, (_, k) => {
        const w = (14 - (d.cols - 1)) / d.cols, h = (14 - (d.filas - 1)) / d.filas;
        return <rect key={k} x={1 + (k % d.cols) * (w + 1)} y={1 + Math.floor(k / d.cols) * (h + 1)} width={w} height={h} rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />;
      })}
    </svg>
  );
  const actual = DISENOS[diseno] ?? DISENOS["1"];
  return (
    <div className="relative" ref={caja}>
      <button onClick={() => setAbierto((a) => !a)} data-tip={`Diseño: ${actual.nombre}`} aria-label="Diseño de los gráficos" aria-expanded={abierto}
              className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-tenue hover:bg-hover hover:text-texto">
        <Mini d={actual} />
      </button>
      {abierto && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-40 w-[220px] animate-entra rounded-[10px] border border-borde bg-vidrio p-2 shadow-desk">
          <h4 className="m-0 px-1.5 pt-0.5 pb-2 text-[10.5px] font-semibold tracking-[.08em] text-apagado uppercase">Diseño</h4>
          <div className="grid grid-cols-3 gap-1.5">
            {Object.entries(DISENOS).map(([id, d]) => (
              <button key={id} onClick={() => { onDiseno(id); setAbierto(false); }} title={d.nombre}
                      className={`flex h-12 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border text-[10.5px]
                                  ${id === diseno ? "border-borde bg-panel-3 text-texto" : "border-linea bg-panel-2 text-tenue hover:text-texto"}`}>
                <Mini d={d} tam={18} />
                {d.cols} × {d.filas}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** La barra de arriba de la grilla: una sola para todos los graficos,
 *  sobre el ACTIVO (el ultimo tocado): su mercado, su temporalidad y Ver todo; y lo de
 *  todos: el diseno, Completo, el replay (del principal), las capas y la noticia. */
export function BarraPrincipal({
  cfg, symbol, interval, onInterval, onBuscar, fijas = [], onFijas, diseno, onDiseno, onVerTodo,
  completo, onCompleto, replay, onReplay, capas, onCapa, vp, onVp, zonas, onZonas, noticias, onCalendario, varios,
}) {
  const esUsdtd = symbol === "USDT.D";
  const mercado = cfg.mercados[symbol];
  const nombreCorto = esUsdtd ? "USDT.D" : mercado?.nombre ?? symbol;
  return (
    <div className="grafico-barra @container">
      <div className="flex items-center gap-1">
        <button onClick={onBuscar} data-tip={varios ? "Buscar mercado (gráfico activo)" : "Buscar mercado"} data-atajo="A-Z"
                className="flex h-[30px] cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-[13.5px] font-semibold tracking-tight text-texto hover:bg-hover">
          <Icon name="buscar" size={14} className="text-tenue" />{nombreCorto}
        </button>
        <span className="mx-1 h-4 w-px bg-borde" />
        {fijas.length > 0 && (
          <div className="flex items-center gap-0.5">
            {[...fijas].sort((a, b) => (segundos(b) ?? 2.7e6) - (segundos(a) ?? 2.7e6)).map((i) => (
              <span key={i} className="group relative">
                <button onClick={() => onInterval(i)} disabled={esUsdtd && !cfg.usdtd.intervals.includes(i)}
                        className={`h-[26px] min-w-[30px] cursor-pointer rounded-md border-0 px-1.5 text-[12.5px] font-semibold disabled:cursor-default disabled:opacity-35
                                    ${i === interval ? "bg-panel-3 text-texto" : "bg-transparent text-tenue hover:bg-hover hover:text-texto"}`}>
                  {etiqueta(i)}
                </button>
                {onFijas && (
                  <button onClick={() => onFijas(fijas.filter((x) => x !== i))} aria-label={`Sacar ${etiqueta(i)} de la barra`} title="Sacar de la barra"
                          className="absolute -top-1 -right-1 hidden size-3.5 cursor-pointer place-items-center rounded-full border-0 bg-panel-3 p-0 text-tenue group-hover:grid hover:text-texto">
                    <Icon name="x" size={8} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {/* USDT.D sale de CoinGecko hora por hora: no hay semanal ni intradia corto. */}
        <SelectorTemporalidad intervals={cfg.intervals} interval={interval} onInterval={onInterval} atajos
                              fijas={fijas} onFijas={onFijas} habilitado={(i) => !esUsdtd || cfg.usdtd.intervals.includes(i)} />
        <span className="mx-1 h-4 w-px bg-borde" />
        <SelectorDiseno diseno={diseno} onDiseno={onDiseno} />
      </div>
      <div className="capas">
        <div className="segmento chico vista" title="Vista del gráfico">
          <button onClick={onVerTodo} data-tip={varios ? "Toda la historia cargada (gráfico activo)" : "Toda la historia cargada"}>
            <Icon name="todo" size={13} /> <span className="@max-4xl:hidden">Ver todo</span>
          </button>
          <button className={completo ? "activo" : ""} onClick={onCompleto}
                  data-tip={completo ? "Volver al panel" : "Gráfico completo, sin el panel"} data-atajo="Shift+F">
            <Icon name={completo ? "contraer" : "expandir"} size={13} /> <span className="@max-4xl:hidden">{completo ? "Salir" : "Completo"}</span>
          </button>
          {onReplay && (
            <button className={replay ? "activo" : ""} onClick={onReplay}
                    data-tip={replay ? "Salir del replay y volver al precio en vivo" : "Replay del gráfico principal: elegir una vela y avanzar desde ahí"}>
              <Icon name="replay" size={13} /> <span className="@max-4xl:hidden">Replay</span>
            </button>
          )}
        </div>
        <MenuCapas lista={CAPAS} capas={capas} onCapa={onCapa} vp={vp} onVp={onVp} zonas={zonas} onZonas={onZonas} filas={cfg.vp_filas} />
        <AvisoNoticia noticias={noticias} onAbrir={onCalendario} />
      </div>
    </div>
  );
}
