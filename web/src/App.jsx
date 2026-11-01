import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Demo from "./components/Demo.jsx";
import Grafico, { BarraPrincipal, DISENOS } from "./components/Grafico.jsx";
import GraficoExtra from "./components/GraficoExtra.jsx";
import Operar from "./components/Operar.jsx";
import Historial from "./components/Historial.jsx";
import Calendario from "./components/Calendario.jsx";
import BarraReplay from "./components/BarraReplay.jsx";
import Backtest from "./components/Backtest.jsx";
import Icon from "./components/Icon.jsx";
import Rail from "./components/Rail.jsx";
import BarraDibujo from "./components/BarraDibujo.jsx";
import Estacion from "./components/Estacion.jsx";
import Lista from "./components/Lista.jsx";
import Buscador from "./components/Buscador.jsx";
import Tip from "./components/Tip.jsx";
import { useMarket } from "./hooks/useMarket.js";
import { cargarPrefs, guardarPrefs } from "./lib/prefs.js";
import { aceptable } from "./lib/temporalidades.js";
import { prepararSonidos, sonar, sonarLote } from "./lib/sonidos.js";
import { paso, Replay } from "./lib/replay.js";
import { armarGrafico } from "./lib/graficoVelas.js";
import { setDecimals } from "./lib/format.js";
import { avanzarOperaciones } from "./lib/simulacion.js";

/** La temporalidad que se puede ver en un par: USDT.D solo tiene 1H, 4H y diario. */
function temporalidadValida(cfg, symbol, interval) {
  if (symbol === "USDT.D") return cfg.usdtd.intervals.includes(interval) ? interval : "1d";
  // Las de siempre o una a medida (3m, 2h...: el servidor la arma con una de siempre).
  return aceptable(interval, cfg.intervals) ? interval : "1d";
}

/** Pantalla completa del navegador. Solo se puede pedir desde un click o una tecla. */
function pantallaCompleta(entrar) {
  try {
    if (entrar && !document.fullscreenElement) document.documentElement.requestFullscreen?.()?.catch(() => {});
    if (!entrar && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  } catch { /* el navegador no lo permite: queda el grafico agrandado */ }
}

/** Pantalla de celular (o ventana angosta): cambia a la vista de una columna. */
// Angosta (celular vertical) o baja (celular apaisado).
const CONSULTA_MOVIL = "(max-width: 820px), (max-height: 500px)";
function useMovil() {
  const [movil, setMovil] = useState(() => window.matchMedia?.(CONSULTA_MOVIL).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(CONSULTA_MOVIL);
    if (!m) return undefined;
    const cambio = () => setMovil(m.matches);
    m.addEventListener("change", cambio);
    return () => m.removeEventListener("change", cambio);
  }, []);
  return movil;
}

function Terminal({ cfg }) {
  const movil = useMovil();
  // En el celular se ve una cosa por vez: el grafico o el panel (Operar).
  const [pantalla, setPantalla] = useState("grafico");
  const [prefs, setPrefs] = useState(() => {
    const p = cargarPrefs();
    const symbol = cfg.symbols.includes(p.symbol) || (p.symbol === "USDT.D" && cfg.usdtd) ? p.symbol : cfg.symbols.includes(cfg.replay_simbolo) ? cfg.replay_simbolo : cfg.symbols[0];
    return { ...p, symbol, interval: temporalidadValida(cfg, symbol, p.interval) };
  });
  const engineRef = useRef(null);

  useEffect(() => guardarPrefs(prefs), [prefs]);

  const { interval, symbol } = prefs;
  const view = useMemo(() => ({ symbol, interval }), [symbol, interval]);
  // Con el replay andando, el grafico muestra el replay y no lo vivo.
  const enReplayRef = useRef(false);
  const onPayload = useCallback((p) => {
    if (!enReplayRef.current) {
      engineRef.current?.handlePayload(p);
      // Los paneles del principal usan su precisión; los otros gráficos tienen la propia.
      if (engineRef.current) setDecimals(engineRef.current.decimals);
    }
  }, []);
  const { payload, conectado, aviso, recargar } = useMarket({ view, onPayload });

  // Los sonidos de la operativa: las ejecuciones que manda el servidor y que esta
  // pestana todavia no sono (al abrirla no suenan las de antes).
  useEffect(() => { prepararSonidos(); }, []);
  const vistaEjRef = useRef(null);
  const sonidosRef = useRef(prefs.sonidos);
  sonidosRef.current = prefs.sonidos;
  useEffect(() => {
    const ej = payload?.ejecuciones;
    if (!Array.isArray(ej)) return;
    const max = ej.reduce((m, e) => Math.max(m, e.id), 0);
    // La primera vez no suena; si el servidor se reinicio, los numeros vuelven a empezar.
    if (vistaEjRef.current === null) { vistaEjRef.current = max; return; }
    if (max < vistaEjRef.current) vistaEjRef.current = 0;
    const nuevas = ej.filter((e) => e.id > vistaEjRef.current);
    vistaEjRef.current = Math.max(vistaEjRef.current, max);
    if (nuevas.length && sonidosRef.current !== false) sonarLote(nuevas);
  }, [payload]);
  const alternarSonidos = useCallback(() => {
    const prender = sonidosRef.current === false;
    setPrefs((p) => ({ ...p, sonidos: prender }));
    if (prender) sonar("abierta");   // para que se escuche como suena
  }, []);

  // ------------------------------------------------------------ replay
  // rp: { estado: cargando | elegir | activo | error, cursor, play, velocidad, sesion, eligiendo, alFinal }
  const motorRef = useRef(null);
  const cargaReplayRef = useRef(null);
  useEffect(() => () => cargaReplayRef.current?.abort(), []);
  const [rp, setRp] = useState(null);
  const [rpPayload, setRpPayload] = useState(null);
  const [rpAviso, setRpAviso] = useState(null);
  const enReplay = rp?.estado === "activo";
  enReplayRef.current = enReplay;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  // Las operaciones simuladas del backtest (guardadas en el servidor).
  const [simOps, setSimOps] = useState([]);
  const simCargadas = useRef(false);
  useEffect(() => {
    fetch("/api/backtest/operaciones").then((r) => r.json())
      .then((j) => { setSimOps(Array.isArray(j.operaciones) ? j.operaciones : []); })
      .catch(() => {})
      .finally(() => { simCargadas.current = true; });
  }, []);
  useEffect(() => {
    if (!simCargadas.current) return undefined;
    const t = setTimeout(() => {
      fetch("/api/backtest/operaciones", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ operaciones: simOps }) }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [simOps]);

  /** Dibuja el replay en el grafico (todo de nuevo o solo las ultimas velas). */
  const mostrarReplay = useCallback((tipo) => {
    const motor = motorRef.current;
    if (!motor) return;
    const p = motor.payload(intervalRef.current, tipo);
    // Sin velas en ese instante (1m antes de la historia de 1 minuto): el grafico
    // vacio y el aviso de hasta donde llega, en vez de las velas de la temporalidad anterior.
    if (p.ok) {
      engineRef.current?.handlePayload(p);
      if (engineRef.current) setDecimals(engineRef.current.decimals);
    }
    else engineRef.current?.vaciar();
    setRpPayload(p.ok ? p : null);
    setRpAviso(p.ok ? null : p.error);
  }, []);

  /** Las velas anteriores a `antes` (s), al llegar al borde izquierdo del grafico: en
   *  el replay, mas de la historia que ya esta en el navegador; en vivo, del servidor. */
  const masHistoria = useCallback(async (antes) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (enReplayRef.current) {
      const motor = motorRef.current;
      if (!motor?.masHistoria()) { engine.sinMas = true; return; }
      // Fuera del aviso de cambio de rango del grafico: si no, al terminarlo vuelve a
      // poner el rango de antes y la vista no queda corrida.
      await new Promise((r) => setTimeout(r, 0));
      const p = motor.payload(intervalRef.current, "snapshot");
      if (p.ok) engine.handlePayload({ ...p, conservarVista: true });
      return;
    }
    const s = symbolRef.current, i = intervalRef.current;
    const n = ["1m", "5m", "15m"].includes(i) ? 6000 : 2000;
    const r = await fetch(`/api/velas?symbol=${encodeURIComponent(s)}&interval=${i}&antes=${antes}&n=${n}`).then((x) => x.json()).catch(() => null);
    // Si mientras tanto cambio la vista, ya no sirve.
    if (!r?.ok || engine.symbol !== s || engine.interval !== i || engine.velas[0]?.time !== antes) return;
    engine.anteponer(r.velas, r.hayMas, (serie) => armarGrafico(serie, cfg));
  }, [cfg]);

  /** Empieza (o salta) el replay en un instante: lo que estaba abierto se cancela. */
  const irReplay = useCallback((t) => {
    const motor = motorRef.current;
    if (!motor) return;
    engineRef.current?.cancelarEleccion?.();
    motor.irA(t);
    setSimOps((xs) => xs.map((o) => (o.estado === "pendiente" || o.estado === "abierta" ? { ...o, estado: "cancelada", cerrada: o.creada } : o)));
    setRp((r) => ({ ...r, estado: "activo", eligiendo: false, play: false, cursor: motor.cursor, alFinal: motor.alFinal, sesion: Date.now() }));
    enReplayRef.current = true;
    mostrarReplay("snapshot");
  }, [mostrarReplay]);

  /** El proximo click en el grafico elige desde donde (la vela clickeada queda como la ultima). */
  const elegirEnGrafico = useCallback(() => {
    setRp((r) => ({ ...r, eligiendo: true }));
    engineRef.current?.elegirInstante((t) => irReplay(t + (paso(intervalRef.current) ?? 60)));
  }, [irReplay]);

  const abrirReplay = useCallback(async () => {
    if (motorRef.current) { elegirEnGrafico(); return; }
    cargaReplayRef.current?.abort();
    const controlador = new AbortController();
    cargaReplayRef.current = controlador;
    setRp({ estado: "cargando", velocidad: 1, play: false });
    try {
      const datos = await (await fetch(`/api/replay?symbol=${encodeURIComponent(cfg.replay_simbolo)}`, { signal: controlador.signal })).json();
      if (controlador.signal.aborted) return;
      if (!datos.ok) throw new Error(datos.error || "Sin datos para el replay");
      motorRef.current = new Replay(datos, cfg);
      setRp({ estado: "elegir", velocidad: 1, play: false, eligiendo: true });
      engineRef.current?.elegirInstante((t) => irReplay(t + (paso(intervalRef.current) ?? 60)));
    } catch (exc) {
      if (controlador.signal.aborted) return;
      setRp({ estado: "error", error: exc.message });
    }
  }, [cfg, irReplay, elegirEnGrafico]);

  const salirReplay = useCallback(() => {
    cargaReplayRef.current?.abort();
    engineRef.current?.cancelarEleccion?.();
    const estaba = enReplayRef.current;
    motorRef.current = null;
    enReplayRef.current = false;
    setRp(null);
    setRpPayload(null);
    setRpAviso(null);
    engineRef.current?.setSimulacion([]);
    if (estaba) engineRef.current?.vaciar();
    // Vuelve lo vivo: el grafico se rearma con una foto nueva.
    if (estaba) recargar();
  }, [recargar]);

  /** Una vela mas de la temporalidad del grafico (hasta que cierre la que esta en curso). */
  const pasoReplay = useCallback(() => {
    const motor = motorRef.current;
    if (!motor || motor.alFinal) return;
    const p = paso(intervalRef.current) ?? 60;
    const ult = motor.serie(intervalRef.current, 2).at(-1);
    const siguiente = ult && !ult.closed ? ult.t + p : motor.cursor + p;
    const velas = motor.avanzar(Math.max(60, siguiente - motor.cursor));
    setSimOps((xs) => avanzarOperaciones(xs, velas));
    mostrarReplay("update");
    setRp((r) => ({ ...r, cursor: motor.cursor, alFinal: motor.alFinal, play: r.play && !motor.alFinal }));
  }, [mostrarReplay]);

  useEffect(() => {
    if (!rp?.play) return undefined;
    const t = setInterval(pasoReplay, 1000 / (rp.velocidad || 1));
    return () => clearInterval(t);
  }, [rp?.play, rp?.velocidad, pasoReplay]);
  // Otra temporalidad en el replay: el grafico se rearma en el mismo instante.
  useEffect(() => {
    if (enReplayRef.current && symbol === cfg.replay_simbolo) mostrarReplay("snapshot");
  }, [interval, symbol, cfg.replay_simbolo, mostrarReplay]);
  // El replay es de un solo mercado: otro mercado lo cierra.
  useEffect(() => { if (symbol !== cfg.replay_simbolo && (motorRef.current || cargaReplayRef.current)) salirReplay(); }, [symbol, cfg.replay_simbolo, salirReplay]);
  const sesion = rp?.sesion ?? null;
  useEffect(() => {
    if (enReplay) engineRef.current?.setSimulacion(simOps.filter((o) => o.sesion === sesion));
  }, [enReplay, simOps, sesion]);

  const elegirSymbol = (s) => setPrefs((p) => ({ ...p, symbol: s, interval: temporalidadValida(cfg, s, p.interval) }));

  const elegirInterval = (i) => setPrefs((p) => ({ ...p, interval: i }));
  const toggleCapa = (id) => setPrefs((p) => ({ ...p, capas: { ...p.capas, [id]: !p.capas[id] } }));
  // Modo presentacion (para grabar): nada de la cuenta en pantalla.
  const presentacion = Boolean(prefs.presentacion);
  const alternarPresentacion = useCallback(() => setPrefs((p) => ({ ...p, presentacion: !p.presentacion })), []);
  // Historial de la cuenta: tapa el grafico y el panel; nunca en modo presentacion.
  const [historial, setHistorial] = useState(false);
  const verHistorial = historial && !presentacion;
  const alternarHistorial = useCallback(() => setHistorial((h) => !h), []);
  const cerrarHistorial = useCallback(() => setHistorial(false), []);
  // Calendario economico de FTMO (no es de la cuenta: se ve tambien en modo presentacion).
  const [calendario, setCalendario] = useState(false);
  const alternarCalendario = useCallback(() => { setHistorial(false); setCalendario((c) => !c); }, []);
  const cerrarCalendario = useCallback(() => setCalendario(false), []);
  // El panel de la derecha (en la compu), una estacion por vez: Operar (O) o la lista de
  // seguimiento (L). Cerrado, el grafico ocupa todo.
  const estacion = prefs.estacion ?? null;
  const alternarEstacion = useCallback((id) => setPrefs((p) => ({ ...p, estacion: p.estacion === id ? null : id })), []);
  const alternarPanel = useCallback(() => alternarEstacion("operar"), [alternarEstacion]);
  const alternarLista = useCallback(() => alternarEstacion("lista"), [alternarEstacion]);
  const alternarDemo = useCallback(() => alternarEstacion("demo"), [alternarEstacion]);
  // El buscador de mercados: la lupa o una letra sobre el grafico. Con
  // varios graficos, cambia el del grafico activo (panel 0 es el principal).
  const [buscar, setBuscar] = useState(null);   // null o { inicial, panel }

  // Varios graficos: el principal y los extra de la grilla, cada uno con
  // su mercado y su temporalidad. El activo (el ultimo tocado) recibe los atajos.
  const diseno = movil ? "1" : DISENOS[prefs.diseno] ? prefs.diseno : "1";
  const { n: nGraficos, cols, filas } = DISENOS[diseno];
  const paneles = useMemo(() => Array.from({ length: nGraficos - 1 }, (_, i) => {
    const guardado = prefs.paneles?.[i];
    if (guardado && (cfg.symbols.includes(guardado.symbol) || (guardado.symbol === "USDT.D" && cfg.usdtd))) {
      return { ...guardado, interval: temporalidadValida(cfg, guardado.symbol, guardado.interval) };
    }
    const otros = cfg.symbols.filter((s) => s !== prefs.symbol);
    const s = otros[i % Math.max(1, otros.length)] ?? prefs.symbol;
    return { symbol: s, interval: temporalidadValida(cfg, s, prefs.interval) };
  }), [nGraficos, prefs.paneles, prefs.symbol, prefs.interval, cfg]);
  const [activo, setActivo] = useState(0);
  const graficoActivo = activo < nGraficos ? activo : 0;
  const cambiarPanel = useCallback((i, cambio) => setPrefs((p) => {
    const lista = Array.from({ length: Math.max(p.paneles?.length ?? 0, i) }, (_, k) => p.paneles?.[k] ?? paneles[k]);
    const actual = lista[i - 1] ?? paneles[i - 1];
    const symbol = cambio.symbol ?? actual.symbol;
    lista[i - 1] = { symbol, interval: temporalidadValida(cfg, symbol, cambio.interval ?? actual.interval) };
    return { ...p, paneles: lista };
  }), [paneles, cfg]);
  const elegirDiseno = useCallback((d) => setPrefs((p) => ({ ...p, diseno: d })), []);

  // La barra de dibujo de la grilla (una sola a la izquierda): la
  // herramienta va al grafico activo; el iman, el bloqueo, seguir dibujando y ocultar
  // valen para todos.
  const extrasRef = useRef([]);
  const motorActivo = () => (graficoActivo === 0 ? engineRef.current : extrasRef.current[graficoActivo - 1]?.current);
  const leerAjuste = (k, def) => { try { const v = localStorage.getItem(`terminal-cripto:${k}`); return v === null ? def : v === "1"; } catch { return def; } };
  const [ajustesDibujo, setAjustesDibujo] = useState(() => ({
    iman: leerAjuste("iman", true), bloqueo: leerAjuste("bloqueo-dibujos", false),
    seguir: leerAjuste("seguir-dibujando", false), ocultos: leerAjuste("dibujos-ocultos", false),
  }));
  const [barraPlegada, setBarraPlegada] = useState(() => leerAjuste("barra-plegada", false));
  useEffect(() => {
    const g = (k, v) => { try { localStorage.setItem(`terminal-cripto:${k}`, v ? "1" : "0"); } catch { /* sin almacenamiento */ } };
    g("seguir-dibujando", ajustesDibujo.seguir); g("dibujos-ocultos", ajustesDibujo.ocultos); g("barra-plegada", barraPlegada);
  }, [ajustesDibujo, barraPlegada]);
  const alternarAjuste = (k) => setAjustesDibujo((a) => ({ ...a, [k]: !a[k] }));
  const [herramientaActiva, setHerramientaActiva] = useState("cursor");
  const borrarDibujos = () => {
    const d = motorActivo()?.dibujos;
    if (!d) return;
    const hayFijos = d.lista.some((x) => x.bloqueado);
    if (window.confirm(`¿Borrar los dibujos de este mercado?${hayFijos ? " Los bloqueados quedan." : ""}`)) d.borrarTodo();
  };
  const capasVista = useMemo(() => ({ ...prefs.capas, posiciones: prefs.capas.posiciones && !presentacion }),
    [prefs.capas, presentacion]);

  // Grafico completo: sin el panel de la derecha y con el navegador a pantalla
  // completa. F lo alterna y Escape sale.
  const completo = prefs.completo;
  const completoRef = useRef(completo);
  completoRef.current = completo;
  // En el celular no se usa la pantalla completa del navegador (el iPhone no la
  // tiene para paginas, y agregada al inicio ya no hay barra de Safari).
  const movilRef = useRef(movil);
  movilRef.current = movil;
  const alternarCompleto = useCallback(() => {
    const nuevo = !completoRef.current;
    if (!movilRef.current) pantallaCompleta(nuevo);
    setPrefs((p) => ({ ...p, completo: nuevo }));
  }, []);
  useEffect(() => {
    const tecla = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Una letra sola abre el buscador (como en TradingView); las secciones y
      // las vistas van con Shift.
      if (!e.shiftKey && /^[a-zA-Z]$/.test(e.key) && !document.querySelector(".capa-dibujo.activa")) { e.preventDefault(); setBuscar({ inicial: e.key, panel: graficoActivoRef.current }); }
      else if (e.shiftKey && e.code === "KeyF") alternarCompleto();
      else if (e.shiftKey && e.code === "KeyP") alternarPresentacion();
      else if (e.shiftKey && e.code === "KeyH" && !presentacion) { setCalendario(false); alternarHistorial(); }
      else if (e.shiftKey && e.code === "KeyC") alternarCalendario();
      else if (e.shiftKey && e.code === "KeyO" && !presentacion) alternarPanel();
      else if (e.shiftKey && e.code === "KeyL") alternarLista();
      else if (e.shiftKey && e.code === "KeyD" && !presentacion) alternarDemo();
      else if (enReplayRef.current && e.key === " ") { e.preventDefault(); setRp((r) => ({ ...r, play: !r.play && !r.alFinal })); }
      else if (enReplayRef.current && e.key === "ArrowRight") { e.preventDefault(); pasoReplay(); }
      // Escape primero cierra lo que este abierto (una confirmacion o el historial); si no hay nada, sale del grafico completo.
      else if (e.key === "Escape" && completo && !document.querySelector(".capa-dibujo.activa, .cambio-orden, .historial")) alternarCompleto();
    };
    // Si se sale de la pantalla completa del navegador (Escape), vuelve el panel.
    const cambio = () => { if (!movilRef.current && !document.fullscreenElement) setPrefs((p) => (p.completo ? { ...p, completo: false } : p)); };
    window.addEventListener("keydown", tecla);
    document.addEventListener("fullscreenchange", cambio);
    return () => {
      window.removeEventListener("keydown", tecla);
      document.removeEventListener("fullscreenchange", cambio);
    };
  }, [alternarCompleto, alternarPresentacion, alternarHistorial, alternarCalendario, alternarPanel, alternarLista, completo, presentacion, pasoReplay]);

  const graficoActivoRef = useRef(graficoActivo);
  graficoActivoRef.current = graficoActivo;
  const vivo = payload?.symbol === symbol && payload?.interval === interval ? payload : null;
  // Lo que se ve: el replay o lo vivo.
  const actual = enReplay ? rpPayload : vivo;
  const irA = (destino) => {
    setHistorial(false);
    setCalendario(false);
    if (destino === "grafico") setPantalla("grafico");
    else setPantalla("panel");
  };
  const freno = actual?.broker?.freno ?? null;
  // Lo abierto en todos los mercados (MT5 y Binance), para el rail.
  const abiertas = (vivo?.broker?.posiciones?.length ?? 0) + (vivo?.broker?.otras?.length ?? 0) + (vivo?.binance?.posiciones?.length ?? 0);
  const onBorrador = useCallback((b) => engineRef.current?.setBorrador(b), []);
  // Una linea de la orden que se arma, arrastrada en el grafico: { campo, precio, n }.
  const [ajusteBorrador, setAjusteBorrador] = useState(null);
  const moverBorrador = useCallback((x) => setAjusteBorrador((a) => ({ ...x, n: (a?.n ?? 0) + 1 })), []);
  // El + del eje: una orden limite a ese precio (del grafico), con el panel Operar abierto.
  const ordenEnPrecio = useCallback((precioGrafico) => {
    setPrefs((p) => (p.estacion === "operar" || p.estacion === "demo" ? p : { ...p, estacion: "operar" }));
    setAjusteBorrador((a) => ({ campo: "nueva", precioGrafico, n: (a?.n ?? 0) + 1 }));
  }, []);
  const onVista = useCallback((v) => engineRef.current?.setVistaOrden(v), []);
  // Las operaciones demo de este mercado, sobre las velas (al precio del grafico). Solo
  // se vuelven a pasar si cambia algo mas que el flotante.
  const opsDemo = vivo?.demo?.ops?.filter((o) => o.simbolo === symbol) ?? [];
  const difDemo = vivo?.broker?.graficoBroker ? 0 : vivo?.broker?.diferencia ?? 0;
  const claveDemo = `${difDemo}|${opsDemo.map((o) => `${o.id}:${o.estado}:${o.sl}:${o.tp}`).join(",")}`;
  useEffect(() => {
    if (enReplay) return;
    const g = (x) => (Number.isFinite(x) ? x - difDemo : x);
    engineRef.current?.setSimulacion(presentacion ? [] : opsDemo.map((o) => ({ ...o, etiqueta: "Demo", entrada: g(o.entrada), sl: g(o.sl), tp: g(o.tp), salida: g(o.salida) })));
  }, [enReplay, claveDemo, presentacion]);   // eslint-disable-line react-hooks/exhaustive-deps
  const nombrePrincipal = cfg.mercados[symbol]?.nombre ?? symbol;

  return (
    <div className={`app${completo ? " completo" : ""}${movil ? ` movil ver-${completo ? "grafico" : pantalla}` : ""}`}>
      <Header cfg={cfg} symbol={symbol} onSymbol={elegirSymbol} payload={vivo} conectado={conectado} movil={movil}
              sonidos={prefs.sonidos !== false} onSonidos={alternarSonidos} />
      <main className="cuerpo">
        {!movil && (
          <BarraDibujo herramienta={herramientaActiva} onHerramienta={(h) => motorActivo()?.dibujos?.setHerramienta(h)}
                       iman={ajustesDibujo.iman} onIman={() => alternarAjuste("iman")} seguir={ajustesDibujo.seguir} onSeguir={() => alternarAjuste("seguir")}
                       bloqueo={ajustesDibujo.bloqueo} onBloqueo={() => alternarAjuste("bloqueo")} ocultos={ajustesDibujo.ocultos}
                       onOcultos={() => alternarAjuste("ocultos")} onBorrarTodo={borrarDibujos}
                       plegada={barraPlegada} onPlegar={() => setBarraPlegada((x) => !x)} />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {!movil && (() => {
          const extra = graficoActivo > 0 ? paneles[graficoActivo - 1] : null;
          return (
            <BarraPrincipal cfg={cfg} varios={nGraficos > 1}
                            symbol={extra ? extra.symbol : symbol} interval={extra ? extra.interval : interval}
                            onInterval={(i) => (extra ? cambiarPanel(graficoActivo, { interval: i }) : elegirInterval(i))}
                            onBuscar={() => setBuscar({ inicial: "", panel: graficoActivo })}
                            fijas={prefs.fijas} onFijas={(fijas) => setPrefs((p) => ({ ...p, fijas }))}
                            diseno={diseno} onDiseno={elegirDiseno} onVerTodo={() => motorActivo()?.verTodo()}
                            completo={completo} onCompleto={alternarCompleto}
                            replay={rp} onReplay={symbol === cfg.replay_simbolo ? (rp ? salirReplay : abrirReplay) : null}
                            capas={capasVista} onCapa={toggleCapa} vp={prefs.vp} onVp={(vp) => setPrefs((p) => ({ ...p, vp }))}
                            zonas={prefs.zonas} onZonas={(zonas) => setPrefs((p) => ({ ...p, zonas }))}
                            noticias={payload?.noticias} onCalendario={alternarCalendario} />
          );
        })()}
        {nGraficos > 1 && graficoActivo > 0 && !enReplay && (
          <div className="flex flex-none items-center justify-between gap-2 border-b border-borde px-3 py-1 text-[11px] text-tenue">
            <span>Operar: <b className="text-texto">{nombrePrincipal}</b> · gráfico principal</span>
            <button className="cursor-pointer border-0 bg-transparent text-texto underline underline-offset-2" onClick={() => setActivo(0)}>Seleccionar principal</button>
          </div>
        )}
        <div className="grid min-h-0 min-w-0 flex-1 gap-px bg-borde"
             style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${filas}, minmax(0, 1fr))` }}>
        <div onPointerDownCapture={() => setActivo(0)}
             className={`relative flex min-h-0 min-w-0 bg-fondo ${nGraficos > 1 ? "celda " : ""}${nGraficos > 1 && graficoActivo === 0 ? "outline outline-1 -outline-offset-1 outline-tenue" : ""}`}>
        <Grafico
          cfg={cfg} interval={interval} onInterval={elegirInterval} capas={capasVista} onCapa={toggleCapa}
          vp={prefs.vp} onVp={(vp) => setPrefs((p) => ({ ...p, vp }))} zonas={prefs.zonas} onZonas={(zonas) => setPrefs((p) => ({ ...p, zonas }))}
          completo={completo} onCompleto={alternarCompleto}
          engineRef={engineRef} payload={enReplay ? rpPayload : payload} symbol={symbol} aviso={enReplay ? rpAviso : aviso} onSymbol={elegirSymbol}
          onMasHistoria={masHistoria}
          presentacion={presentacion} onPresentacion={alternarPresentacion} onHistorial={alternarHistorial} onCalendario={alternarCalendario}
          conRail={!movil} onBuscar={() => setBuscar({ inicial: "", panel: 0 })} onMoverBorrador={moverBorrador}
          activo={graficoActivo === 0} diseno={diseno} onDiseno={movil ? null : elegirDiseno}
          ajustes={movil ? null : ajustesDibujo} onHerramientaActiva={setHerramientaActiva} rangos={nGraficos === 1}
          fijas={prefs.fijas} onFijas={(fijas) => setPrefs((p) => ({ ...p, fijas }))}
          onOrdenEnPrecio={!movil && !presentacion && !enReplay && actual?.broker?.disponible ? ordenEnPrecio : null}
          replay={rp} onReplay={symbol === cfg.replay_simbolo ? (rp ? salirReplay : abrirReplay) : null}
          barraReplay={rp && (
            <BarraReplay rp={rp} rango={motorRef.current?.rango(interval)} onElegir={elegirEnGrafico} onIr={irReplay}
                         onPlay={() => setRp((r) => ({ ...r, play: !r.play }))} onPaso={pasoReplay}
                         onVelocidad={(v) => setRp((r) => ({ ...r, velocidad: v }))} onSalir={salirReplay} />
          )}
        />
        </div>
        {paneles.map((pnl, k) => (
          <div key={k} onPointerDownCapture={() => setActivo(k + 1)}
               className={`celda relative flex min-h-0 min-w-0 bg-fondo ${graficoActivo === k + 1 ? "outline outline-1 -outline-offset-1 outline-tenue" : ""}`}>
            <GraficoExtra cfg={cfg} panel={pnl} onPanel={(c) => cambiarPanel(k + 1, c)} activo={graficoActivo === k + 1}
                          capas={capasVista} vp={prefs.vp} zonas={prefs.zonas} presentacion={presentacion}
                          onBuscar={() => setBuscar({ inicial: "", panel: k + 1 })}
                          engineRef={(extrasRef.current[k] ??= { current: null })} ajustes={ajustesDibujo} onHerramientaActiva={setHerramientaActiva} />
          </div>
        ))}
        </div>
        </div>
        {/* El panel es la cuenta y la operativa: en el modo presentacion no se ve. En la
            compu se abre desde el rail; en el replay esta siempre (el backtest). */}
        {(!completo || movil) && (enReplay || (movil ? !presentacion : (estacion === "lista" || ((estacion === "operar" || estacion === "demo") && !presentacion)))) && (
          <aside className="lateral">
            {enReplay ? (
              <Backtest cfg={cfg} cursor={rp.cursor} precio={rpPayload?.precio ?? null} ops={simOps} onOps={setSimOps} sesion={sesion} />
            ) : !movil && estacion === "demo" ? (
              <>
                <Estacion titulo={`Créditos demo · ${nombrePrincipal}`} onCerrar={alternarDemo} />
                <Demo demo={vivo?.demo ?? null} broker={vivo?.broker ?? null} symbol={symbol} onBorrador={onBorrador} ajuste={ajusteBorrador} />
              </>
            ) : !movil && estacion === "lista" ? (
              <>
                <Estacion titulo="Lista de seguimiento" onCerrar={alternarLista} />
                <Lista cfg={cfg} symbol={symbol} onSymbol={elegirSymbol} />
              </>
            ) : (
              <>
                {!movil && <Estacion titulo={`Operar · ${nombrePrincipal}`} onCerrar={alternarPanel} />}
                <Operar cfg={cfg} symbol={symbol} broker={actual?.broker ?? null} binance={actual?.binance ?? null} precio={actual?.precio ?? null}
                        onBorrador={onBorrador} onVista={onVista} freno={freno} onSymbol={elegirSymbol} ajuste={ajusteBorrador} />
              </>
            )}
          </aside>
        )}
        {!movil && !completo && (
          <Rail
            items={[
              { id: "lista", nombre: "Lista de seguimiento", icono: "lista", atajo: "Shift+L", activo: estacion === "lista" && !enReplay, onClick: alternarLista },
              ...(presentacion ? [] : [{
                id: "operar", nombre: "Operar", icono: "operar", atajo: "Shift+O", activo: (estacion === "operar" && !enReplay) || enReplay, onClick: alternarPanel,
                cuenta: abiertas, alerta: freno?.activo ? "Freno activo" : null,
              }]),
              ...(presentacion ? [] : [{
                id: "demo", nombre: "Créditos demo", icono: "demo", atajo: "Shift+D", activo: estacion === "demo" && !enReplay, onClick: alternarDemo,
                cuenta: vivo?.demo?.ops?.filter((o) => o.estado === "abierta" || o.estado === "pendiente").length ?? 0,
              }]),
              { id: "calendario", nombre: "Calendario", icono: "calendario", atajo: "Shift+C", activo: calendario, onClick: alternarCalendario,
                alerta: payload?.noticias?.some((n) => n.restringido && n.t > Date.now()) ? "Noticia restringida en las próximas 24 h" : null },
              ...(presentacion ? [] : [{ id: "historial", nombre: "Historial", icono: "historial", atajo: "Shift+H", activo: verHistorial,
                onClick: () => { setCalendario(false); alternarHistorial(); } }]),
            ]}
            abajo={[
              { id: "presentacion", nombre: presentacion ? "Modo presentación: tu cuenta está oculta" : "Modo presentación: oculta tu cuenta para grabar",
                icono: presentacion ? "oculto" : "visible", atajo: "Shift+P", activo: presentacion, onClick: alternarPresentacion },
            ]}
          />
        )}
        {verHistorial && <Historial onCerrar={cerrarHistorial} />}
        {buscar && (
          <Buscador cfg={cfg} symbol={buscar.panel > 0 ? paneles[buscar.panel - 1]?.symbol : symbol} inicial={buscar.inicial}
                    onSymbol={(s) => (buscar.panel > 0 ? cambiarPanel(buscar.panel, { symbol: s }) : elegirSymbol(s))} onCerrar={() => setBuscar(null)} />
        )}
        {!movil && <Tip />}
        {calendario && <Calendario onCerrar={cerrarCalendario} />}
      </main>
      {movil && !completo && (
        <nav className="nav-movil" aria-label="Secciones">
          {[
            ["grafico", "Gráfico", "logo", pantalla === "grafico" && !verHistorial && !calendario, () => irA("grafico")],
            ...(presentacion ? [] : [["operar", "Operar", "dot", pantalla === "panel" && !verHistorial && !calendario, () => irA("operar")]]),
            ["calendario", "Calendario", "calendario", calendario, () => { setHistorial(false); setCalendario(true); }],
            ...(presentacion ? [] : [["historial", "Historial", "historial", verHistorial, () => { setCalendario(false); setHistorial(true); }]]),
          ].map(([id, texto, icono, activo, accion]) => (
            <button key={id} className={activo ? "activo" : ""} aria-current={activo ? "page" : undefined} onClick={accion}>
              <Icon name={icono} size={18} />
              <span>{texto}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    const controlador = new AbortController();
    setError(false);
    fetch("/api/config", { signal: controlador.signal }).then((r) => {
      if (!r.ok) throw new Error("No se pudo cargar la configuración");
      return r.json();
    }).then((c) => {
      if (!Array.isArray(c?.symbols) || !c.symbols.length || !Array.isArray(c.intervals) || !c.mercados) throw new Error("Configuración incompleta");
      if (!controlador.signal.aborted) setCfg(c);
    }).catch(() => { if (!controlador.signal.aborted) setError(true); });
    return () => controlador.abort();
  }, [intento]);
  if (error) return <div className="cargando"><div role="alert" className="text-center">
    <p>No se pudo conectar con el servidor.</p>
    <button className="cursor-pointer rounded-md border border-borde bg-panel-2 px-4 py-2 text-texto" onClick={() => setIntento((n) => n + 1)}>Reintentar</button>
  </div></div>;
  if (!cfg) return <div className="cargando">Cargando…</div>;
  return <Terminal cfg={cfg} />;
}
