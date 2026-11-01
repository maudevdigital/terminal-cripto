/* Motor de graficos: precio arriba, squeeze y ADX abajo, y un canvas por encima
   con lo que se dibuja sobre las velas (las posiciones de MT5 y
   los perfiles de volumen). Lightweight Charts es imperativo, asi que vive
   fuera de React: la interfaz le pasa datos y capas, y el motor avisa por callbacks. */

import { createChart, CrosshairMode, LineStyle, TickMarkType, BaselineSeries, CandlestickSeries, LineSeries } from "lightweight-charts";
import { C, VISIBLE_BARS } from "../lib/constants.js";
import { fmt, fmtNum, detectDecimals } from "../lib/format.js";
import { FILAS_TV, perfilRango, perfilSesiones } from "../lib/profile.js";
import { Dibujos, IZQ_LIBRE } from "./Dibujos.js";
import { LineasOrden } from "./LineasOrden.js";
import { ok, resultadoEn, nombreOperacion } from "../lib/operativa.js";
import { sesionesEntre } from "../lib/sesiones.js";
import { smc } from "../../../src/smc.ts";
import { orderBlocks } from "../../../src/orderBlocks.ts";
import { segundos } from "../lib/temporalidades.js";
import { desdeGrafico } from "../lib/graficoVelas.js";

const FONT = 'Geist, Inter, "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", ui-monospace, monospace';
const ESCALA_PX = 80;
// Duracion de cada vela (segundos), para la cuenta regresiva del cierre. 1M va por calendario.
const DURACION = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "1d": 86_400, "1w": 604_800 };

/** Las series conservan UTC y solo sus etiquetas se muestran en hora local. Asi
 *  el historial respeta el cambio de horario sin duplicar ni desordenar velas.
 *  Diario o mas mantiene la fecha de la vela, en UTC. */
export function formateadoresTiempo(interval, zona) {
  const calendario = interval === "1M" || (segundos(interval) ?? 0) >= 86_400;
  const timeZone = calendario ? "UTC" : zona;
  const formato = (opciones) => new Intl.DateTimeFormat("es-CL", { timeZone, hourCycle: "h23", ...opciones });
  const cruz = formato({ day: "2-digit", month: "short", year: "numeric",
    ...(!calendario ? { hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" } : {}),
  });
  const marcas = new Map([
    [TickMarkType.Year, formato({ year: "numeric" })],
    [TickMarkType.Month, formato({ month: "short" })],
    [TickMarkType.DayOfMonth, formato({ day: "2-digit" })],
    [TickMarkType.Time, formato({ hour: "2-digit", minute: "2-digit" })],
    [TickMarkType.TimeWithSeconds, formato({ hour: "2-digit", minute: "2-digit", second: "2-digit" })],
  ]);
  const fecha = (time) => typeof time === "number" ? new Date(time * 1000)
    : typeof time === "string" ? new Date(`${time}T00:00:00Z`)
    : new Date(Date.UTC(time.year, time.month - 1, time.day));
  return {
    timeFormatter: (time) => cruz.format(fecha(time)),
    tickMarkFormatter: (time, tipo) => marcas.get(tipo)?.format(fecha(time)) ?? null,
  };
}

/** Cuando cierra la vela que abrio en `t` (segundos). */
function finVela(t, interval) {
  if (interval === "1M") {
    const d = new Date(t * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  }
  const d = DURACION[interval] ?? segundos(interval);
  return d ? t + d : null;
}

/** Lo que falta para el cierre, como en TradingView: 04:59, 02:14:09 o 3d 12h. */
function faltaTexto(seg) {
  const d = Math.floor(seg / 86_400), h = Math.floor(seg % 86_400 / 3600), m = Math.floor(seg % 3600 / 60), x = Math.floor(seg % 60);
  const dos = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${dos(h)}:${dos(m)}:${dos(x)}` : `${dos(m)}:${dos(x)}`;
}
const MARGEN_VELAS = 14;        // velas libres a la derecha de la ultima

/** Los cuatro colores del momento (como los manda el servidor): tono y si acelera. */
const TONO_MOMENTO = {
  "#00E676": ["sube", true], "#1B8A3A": ["sube", false],
  "#FF1744": ["baja", true], "#8B0000": ["baja", false],
};

/** SQZ en area: cada vela con su tono (signo y aceleracion), relleno
 *  parejo con 35 % de transparencia y borde del mismo tono, con los colores de la terminal. */
export function areaMomento(p) {
  const [tono, fuerte] = TONO_MOMENTO[String(p.color).toUpperCase()] ?? [p.value >= 0 ? "sube" : "baja", true];
  const rgb = C.squeeze[tono][fuerte ? 0 : 1];
  const linea = `rgb(${rgb})`, relleno = `rgba(${rgb},0.65)`;
  return {
    time: p.time, value: p.value,
    topLineColor: linea, topFillColor1: relleno, topFillColor2: relleno,
    bottomLineColor: linea, bottomFillColor1: relleno, bottomFillColor2: relleno,
  };
}

/** ADX y SQZ van en una sola escala, para que el eje Y los mueva juntos: el ADX se pasa
 *  a las unidades del SQZ. Un ADX de 50 queda a la altura de lo que suele moverse el SQZ
 *  (el percentil 95 de sus ultimas 300 velas). La leyenda sigue mostrando el ADX real. */
export function factorAdx(momento) {
  const m = (momento || []).slice(-300).map((p) => Math.abs(p.value)).sort((a, b) => a - b);
  const alto = m[Math.floor(m.length * 0.95)] ?? m.at(-1) ?? 0;
  return alto > 0 ? alto / 50 : 1;
}

// Los rangos rapidos de la barra de abajo (como en TradingView): cada uno con
// la temporalidad que le queda bien y cuanto se ve (s; "ytd" desde el 1 de enero).
const DIA = 86_400;
export const RANGOS = [
  ["1D", "15m", DIA], ["7D", "1h", 7 * DIA], ["1M", "1h", 30 * DIA], ["3M", "4h", 91 * DIA],
  ["6M", "4h", 182 * DIA], ["YTD", "1d", "ytd"], ["1A", "1d", 365 * DIA], ["5A", "1w", 5 * 365 * DIA], ["Todo", "1w", "todo"],
];

function opciones() {
  return {
    layout: { background: { type: "solid", color: C.fondo }, textColor: C.tenue, fontSize: 11, fontFamily: FONT },
    // Precios del eje y de la cruz como en el resto de la terminal (es-CL: 29.154,05).
    localization: { locale: "es-CL", priceFormatter: (p) => fmt(p) },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grilla } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 }, minimumWidth: 78 },
    // Velas de hasta 0,1 px: "Ver todo" y el zoom llegan a mostrar unas 10.000.
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 14, minBarSpacing: 0.1 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: C.cruzLinea, width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: C.etiquetaCruz },
      horzLine: { color: C.cruzLinea, width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: C.etiquetaCruz },
    },
    // Arrastrar con inercia (como en TradingView). La rueda la maneja el motor: el
    // zoom se desliza hacia cada muesca en vez de saltar.
    kineticScroll: { mouse: true, touch: true },
    handleScale: { mouseWheel: false, axisPressedMouseMove: { time: true, price: true } },
  };
}

/** Un resultado corto, para el rotulo del eje: +80,30 o −10,76. */
const signo2 = (x) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), 2)}`;

/** Un color "#rrggbb" con transparencia. */
function conAlfa(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Texto claro u oscuro sobre un color (hex o "r,g,b"), segun lo claro que sea. */
function textoSobre(color) {
  let r, g, b;
  if (color.startsWith("#")) [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  else [r, g, b] = (color.match(/\d+/g) || [0, 0, 0]).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#0E0F12" : "#FFFFFF";
}

/** Los puntos de compresion y el ADX, con los colores de la paleta. */
const enPaleta = (pts, mapa) => (pts || []).map((p) => ({ ...p, color: mapa[String(p.color).toUpperCase()] ?? p.color }));
const iguales = (a, b) => a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((k) => a[k] === b[k]);

export class ChartEngine {
  constructor(els, cb) {
    this.els = els;
    this.cb = cb;
    this.capas = {};
    this.vp = { vpvr: true, vpsv: false, filas: FILAS_TV };
    this.zonas = { fvg: true, ifvg: true, estrSwing: true, estrInterna: false };   // que se ve de las capas FVG y Estructura   // perfiles de volumen: se pueden ver los dos
    this.adxPorT = new Map();  // ADX por vela, para la leyenda
    this.nivelAdx = 23;        // nivel clave del ADX (ADX_CLAVE)
    this.factorAdx = 1;        // de ADX a unidades del SQZ (se fija con cada foto completa)
    this.broker = null;        // MT5: cotizacion, diferencia y posiciones
    this.binance = null;       // la cuenta de futuros de Binance (solo para mirar)
    this.interval = null;
    // Datos y coordenadas en UTC; las etiquetas aplican la zona de cada fecha.
    this.velas = [];
    this.lastTimes = {};
    this.puntosSeries = {};
    this.decimals = 2;
    this.siguiendo = true;
    this.syncing = false;
    this.disposers = [];
    // Lo que tapa la barra de dibujo a la izquierda: flotante (celular) o nada (acoplada).
    this.izqLibre = IZQ_LIBRE;
    this.redrawPend = false;
    this.borradorOrden = null; // la orden que se esta armando en el panel Operar
    this.simulacion = [];      // las operaciones simuladas del backtest (replay)
    this.armar();
    // Cuenta regresiva del cierre de la vela, bajo el precio en el eje: su propia
    // capa, que se redibuja cada segundo sin tocar el resto del grafico.
    if (els.canvas?.parentElement) {
      this.cuentaCv = document.createElement("canvas");
      this.cuentaCv.className = "capa-cuenta";
      els.canvas.parentElement.appendChild(this.cuentaCv);
      const reloj = setInterval(() => this.dibujarCuenta(), 1000);
      this.disposers.push(() => { clearInterval(reloj); this.cuentaCv.remove(); });
    }
    // Lineas, recuadros y lineas horizontales dibujados a mano.
    this.dibujos = els.dibujo ? new Dibujos(this, els.dibujo, { onCambio: cb.onDibujos, onHerramienta: cb.onHerramienta, onSeleccion: cb.onSeleccion }) : null;
    // SL, TP y precio de lo abierto en MT5, arrastrables (con confirmacion antes de mandar).
    this.lineasOrden = els.lineas ? new LineasOrden(this, els.lineas, { onModificar: cb.onModificar, onBorrador: cb.onMoverBorrador, onCerrar: cb.onCerrarOperacion }) : null;
  }

  /** Lo que se escribe en el panel para una operacion abierta: { ticket, sl, tp, precio }. */
  setVistaOrden(v) {
    this.lineasOrden?.setVista(v);
  }

  /** Se cerro la confirmacion de un cambio arrastrado (mandado o no). */
  resolverCambio(mandado) {
    this.lineasOrden?.resolver(mandado);
  }

  /** La orden que se esta armando en el panel Operar (precios del broker). */
  setBorrador(b) {
    this.borradorOrden = b;
    this.agendarDibujo();
  }

  /** Las operaciones simuladas del backtest manual. */
  setSimulacion(ops) {
    this.simulacion = ops ?? [];
    this.agendarDibujo();
  }

  /** El proximo click en el grafico elige un instante: `cb` recibe la apertura de
   *  la vela clickeada (s, UTC). Devuelve la funcion que lo cancela. */
  elegirInstante(cb) {
    this.cancelarEleccion?.();
    const fn = (param) => {
      if (param.time === undefined) return;
      this.cancelarEleccion();
      cb(param.time);
    };
    this.price.subscribeClick(fn);
    this.cancelarEleccion = () => { this.price.unsubscribeClick(fn); this.cancelarEleccion = null; };
    return this.cancelarEleccion;
  }

  armar() {
    const { price, osc } = this.els;
    // Un solo grafico con dos paneles (v5): arriba las velas, abajo el squeeze y el
    // ADX, con el mismo eje de tiempo. El contenedor del grafico cubre el
    // area del precio y la del panel de abajo (las dos cajas de la pagina siguen
    // como estaban: asi el diseno, tambien el del celular, no cambia).
    this.price = createChart(price, opciones());
    // Fondo transparente: las zonas se pintan en un canvas por debajo.
    this.price.applyOptions({
      layout: { background: { type: "solid", color: "transparent" }, panes: { separatorColor: C.borde, separatorHoverColor: C.borde, enableResize: false } },
    });

    const s = {};
    s.velas = this.price.addSeries(CandlestickSeries, {
      upColor: C.velaSube, downColor: C.velaBaja, borderVisible: true, borderUpColor: C.bordeSube, borderDownColor: C.bordeBaja,
      wickUpColor: C.velaSube, wickDownColor: C.velaBaja, priceLineColor: C.tenue, priceLineStyle: LineStyle.Dotted,
    });
    s.ema = C.emas.map((color, i) => this.price.addSeries(LineSeries, {
      color, lineWidth: i === 0 ? 1 : 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    }));
    s.momento = this.price.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 }, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    }, 1);
    this.price.priceScale("right", 1).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
    s.compresion = this.price.addSeries(LineSeries, {
      lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false,
    }, 1);
    // El ADX en la misma escala del SQZ (factorAdx), con la linea del nivel clave
    // siempre a la vista.
    s.fuerza = this.price.addSeries(LineSeries, {
      lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: (original) => {
        const r = original();
        // Sin valores del ADX a la vista (antes de sus primeras velas) no hay rango.
        if (!r?.priceRange) return r;
        const k = this.factorAdx, n = this.nivelAdx * k;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, n - 5 * k), maxValue: Math.max(r.priceRange.maxValue, n + 5 * k) } };
      },
    }, 1);
    this.lineaAdx = s.fuerza.createPriceLine({ price: this.nivelAdx * this.factorAdx, color: C.tenue, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    this.s = s;
    this.dimensionar();

    this.price.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r) return;
      this.agendarDibujo();
      this.revisarBorde(r);
    });
    // Las capas van en canvas aparte y LWC no avisa cuando cambia la escala de precios
    // (estirar el eje, la autoescala, arrastrar en vertical). Un primitivo vacio en el
    // panel de las velas se entera en cada repintado, ya con las escalas recalculadas: si
    // cambio el paso de precio u hora a pixel, se redibujan en ese mismo cuadro.
    this.price.panes()[0].attachPrimitive({
      updateAllViews: () => {
        if (this.sincPend) return;
        this.sincPend = true;
        queueMicrotask(() => {
          this.sincPend = false;
          if (this.destruido) return;
          if (this.firma() !== this.firmaDibujo) this.dibujar();
        });
      },
    });
    this.price.subscribeCrosshairMove((param) => {
      this.cb.onCrosshair(param.time !== undefined ? this.velaEn(param.time) : null);
      // Donde esta la cruz en el panel de las velas (para el boton + del eje): su
      // altura, el precio del grafico ahi y donde termina el area de las velas.
      const pt = param.point;
      this.lineaBajo(pt ? pt.y : null);
      const enVelas = pt && pt.y >= 0 && pt.y <= this.altoPrecio();
      const precio = enVelas ? this.s.velas.coordinateToPrice(pt.y) : null;
      this.cb.onCruz?.(precio !== null ? { y: pt.y, precio, borde: this.price.timeScale().width() } : null);
    });

    const ro = new ResizeObserver(() => {
      this.dimensionar();
      this.dibujar();
    });
    ro.observe(price.parentElement);
    ro.observe(osc);
    this.disposers.push(() => ro.disconnect());

    // El zoom con la rueda, suave: cada muesca corre el objetivo y el rango se desliza
    // hacia el. Siguiendo la ultima vela queda fijo el borde derecho (lo vivo no se
    // va); si no, la vela bajo el mouse. De costado (o con Shift), se desplaza.
    const rueda = (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey || !this.velas.length) return;
      e.preventDefault();
      this.todo = false;
      const ts = this.price.timeScale();
      const actual = this.objetivoZoom ?? ts.getVisibleLogicalRange();
      const ancho = ts.width();
      if (!actual || !(ancho > 0)) return;
      const x = e.clientX - price.getBoundingClientRect().left;
      const f = this.siguiendo ? 1 : Math.max(0, Math.min(1, x / ancho));
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const tramo = actual.to - actual.from;
      const nuevo = Math.max(ancho / 50, Math.min(ancho / 0.1, tramo * Math.exp(delta * 0.0016)));
      const ancla = actual.from + f * tramo;
      this.objetivoZoom = { from: ancla - f * nuevo, to: ancla + (1 - f) * nuevo };
      this.deslizar(this.objetivoZoom, 200, () => { this.objetivoZoom = null; });
    };
    for (const el of [price, osc]) {
      el.addEventListener("wheel", rueda, { passive: false, capture: true });
      this.disposers.push(() => el.removeEventListener("wheel", rueda, { capture: true }));
    }

    // Arrastrar el grafico deja de seguir la ultima vela; el boton la recupera.
    for (const el of [price, osc]) {
      let down = null;
      const onDown = (e) => {
        if (e.clientX - el.getBoundingClientRect().left > el.clientWidth - ESCALA_PX) return;
        this.detenerAnimacion();
        down = { x: e.clientX, y: e.clientY };
        this.todo = false;
      };
      const onMove = (e) => {
        if (!down || !this.siguiendo) return;
        if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) {
          down = null;
          this.siguiendo = false;
          this.cb.onSeguir(false);
        }
      };
      const onUp = () => { down = null; };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      window.addEventListener("pointerup", onUp);
      this.disposers.push(() => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        window.removeEventListener("pointerup", onUp);
      });
    }
  }

  destroy() {
    if (this.destruido) return;
    this.destruido = true;
    this.detenerAnimacion();
    cancelAnimationFrame(this.redrawFrame);
    this.cancelarEleccion?.();
    this.lineasOrden?.finDedo();
    for (const d of this.disposers) d();
    this.price.remove();
  }

  /** Cada grafico conserva sus decimales aunque otro mercado reciba datos. */
  fmt(precio) {
    return fmt(precio, this.decimals);
  }

  detenerAnimacion() {
    if (this.animRango !== undefined) cancelAnimationFrame(this.animRango);
    this.anim = null;
    this.objetivoZoom = null;
  }

  /** El grafico cubre la caja del precio y la del panel de abajo: el panel 0 mide
   *  lo que la del precio, y el 1 el resto (menos el eje de tiempo, abajo de todo).
   *  Con el ADX + SQZ apagado, el panel 1 queda en nada y el eje va bajo las velas. */
  dimensionar() {
    const { price, osc } = this.els;
    const caja = price.parentElement;
    const conOsc = this.capas?.osc !== false;
    const w = caja.clientWidth, alto = caja.clientHeight, abajo = conOsc ? osc.clientHeight : 0;
    if (!w || !alto) return;
    price.style.bottom = "auto";
    price.style.height = `${alto + abajo}px`;
    this.price.resize(w, alto + abajo);
    // Proporciones de cada panel: el lugar para los paneles es el total menos el
    // eje de tiempo y la linea que los separa.
    const panes = this.price.panes();
    if (panes.length > 1) {
      const eje = this.price.timeScale().height() || 28;
      panes[0].setStretchFactor(alto);
      panes[1].setStretchFactor(conOsc ? Math.max(1, abajo - eje - 1) : 1e-6);
    }
  }

  /** Alto del panel de las velas (lo que tapan las capas de dibujo). */
  altoPrecio() {
    return this.price.panes()[0]?.getHeight() || this.els.price.parentElement.clientHeight;
  }

  // ---------------------------------------------------------------- opciones

  setCapas(capas, vp) {
    this.capas = capas;
    this.vp = vp;
    for (const sr of this.s.ema) sr.applyOptions({ visible: !!capas.medias });
    const conOsc = capas.osc !== false;
    for (const sr of [this.s.momento, this.s.compresion, this.s.fuerza]) sr.applyOptions({ visible: conOsc });
    this.price.applyOptions({ layout: { panes: { separatorColor: conOsc ? C.borde : "transparent", separatorHoverColor: conOsc ? C.borde : "transparent" } } });
    this.dimensionar();
    this.dibujar();
  }

  /** La escala del precio invertida (Alt+I, como en TradingView): el grafico se ve
   *  de cabeza; los dibujos y las operaciones siguen en su precio. */
  setInvertido(v) {
    this.invertido = Boolean(v);
    this.price.priceScale("right", 0).applyOptions({ invertScale: this.invertido });
    // El squeeze y el ADX tambien, como en TradingView.
    this.price.priceScale("right", 1).applyOptions({ invertScale: this.invertido });
    this.dibujar();
  }

  setZonas(z) {
    this.zonas = { fvg: true, ifvg: true, estrSwing: true, estrInterna: false, ...z };
    this.dibujar();
  }

  /** Velas libres a la derecha de la ultima. */
  margen() {
    return MARGEN_VELAS;
  }

  aplicarMargen() {
    this.price.timeScale().applyOptions({ rightOffset: this.margen() });
  }

  /** El nivel clave del ADX (la linea punteada del panel). */
  setNivelAdx(n) {
    if (!(n > 0) || n === this.nivelAdx) return;
    this.nivelAdx = n;
    this.lineaAdx?.applyOptions({ price: n * (this.factorAdx ?? 1) });
  }

  /** Las ultimas velas a la vista (unas 160): deslizandose en `ms` (0: de una). */
  encuadrar(ms = 0) {
    const n = this.velas.length;
    if (!n) return;
    this.deslizar({ from: n - VISIBLE_BARS, to: n + this.margen() }, ms);
  }

  /** Lleva el rango visible hacia `destino` con una curva que frena al llegar:
   *  el zoom de la rueda, volver al precio y los rangos rapidos. Una nueva
   *  animacion reemplaza a la anterior desde donde iba. */
  deslizar(destino, ms = 260, alFinal = null) {
    const ts = this.price.timeScale();
    const desde = ts.getVisibleLogicalRange();
    cancelAnimationFrame(this.animRango);
    this.anim = null;
    if (!desde || !(ms > 0)) { ts.setVisibleLogicalRange(destino); alFinal?.(); return; }
    // Copias propias: si a mitad de camino se suman velas adelante, `correrIndices` las corre.
    const anim = (this.anim = { desde: { from: desde.from, to: desde.to }, destino: { from: destino.from, to: destino.to } });
    const t0 = performance.now();
    const paso = (t) => {
      // La hora del cuadro puede ser un poco anterior a t0: el avance va de 0 a 1.
      const k = Math.max(0, Math.min(1, (t - t0) / ms)), e = 1 - (1 - k) ** 3;
      const { desde: a, destino: b } = anim;
      ts.setVisibleLogicalRange({ from: a.from + (b.from - a.from) * e, to: a.to + (b.to - a.to) * e });
      if (k < 1) this.animRango = requestAnimationFrame(paso);
      else { this.anim = null; alFinal?.(); }
    };
    this.animRango = requestAnimationFrame(paso);
  }

  /** Se sumaron `n` velas adelante: el zoom en curso y la animacion van en indices de
   *  vela, asi que se corren con ellas (si no, la vista salta `n` velas al pasado, llega
   *  otra vez al borde, pide mas historia y se va cada vez mas lejos). */
  correrIndices(n) {
    if (!n) return;
    if (this.objetivoZoom) this.objetivoZoom = { from: this.objetivoZoom.from + n, to: this.objetivoZoom.to + n };
    for (const r of this.anim ? [this.anim.desde, this.anim.destino] : []) { r.from += n; r.to += n; }
  }

  /** Un rango rapido de la barra de abajo: segundos hacia atras desde la ultima vela,
   *  "ytd" o "todo". Si la temporalidad todavia no llego, queda pendiente. */
  setRango(rango, interval) {
    this.rangoPendiente = { rango, interval };
    if (interval === this.interval && this.velas.length) this.aplicarRango();
  }

  aplicarRango() {
    const pend = this.rangoPendiente;
    this.rangoPendiente = null;
    if (!pend || !this.velas.length) return;
    if (pend.rango === "todo") { this.verTodo(); return; }
    this.todo = false;
    const ult = this.velas[this.velas.length - 1].time;
    const ahora = new Date(ult * 1000);
    const desde = pend.rango === "ytd" ? Date.UTC(ahora.getUTCFullYear(), 0, 1) / 1000 : ult - pend.rango;
    let i = this.velas.findIndex((x) => x.time >= desde);
    if (i < 0) i = 0;
    this.deslizar({ from: i, to: this.velas.length - 1 + this.margen() }, 420);
    this.price.priceScale("right").applyOptions({ autoScale: true });
    this.siguiendo = false;
    this.cb.onSeguir(false);
  }

  /** Toda la historia cargada a la vista, deslizandose. Deja de seguir la ultima
   *  vela, y mientras se mira todo no pide velas anteriores (el borde izquierdo es el
   *  de lo cargado): al mover el grafico o hacer zoom, vuelve a pedirlas. */
  verTodo() {
    const n = this.velas.length;
    if (!n) return;
    this.todo = true;
    this.deslizar({ from: 0, to: n - 1 + this.margen() }, 420);
    this.siguiendo = false;
    this.cb.onSeguir(false);
  }

  volverAlPrecio() {
    this.todo = false;
    this.siguiendo = true;
    this.encuadrar(420);
    this.price.priceScale("right").applyOptions({ autoScale: true });
    this.price.priceScale("right", 1).applyOptions({ autoScale: true });
    this.cb.onSeguir(true);
  }

  // ------------------------------------------------------------------- datos

  handlePayload(p) {
    const mismaVista = this.symbol === p.symbol && this.interval === p.interval && this.velas.length > 0;
    const replay = p.replay !== null && p.replay !== undefined;
    const fuente = JSON.stringify([p.fuente?.nombre ?? "", Boolean(p.fuente?.broker || p.broker?.graficoBroker), replay]);
    const mismaFuente = fuente === this.fuenteGrafico;
    const conservar = Boolean(p.conservarVista) || (mismaVista && !replay && !this.esReplay);
    const firma = this.firmaPayload(p);
    const cambioCapas = firma !== this.firmaDatosCapas;
    this.firmaDatosCapas = firma;
    this.interval = p.interval;
    this.broker = p.broker ?? null;
    this.binance = p.binance ?? null;
    const g = p.type === "snapshot" && conservar && mismaVista && mismaFuente ? this.conservarHistoria(p.grafico) : p.grafico;
    this.symbol = p.symbol;
    this.fuenteGrafico = fuente;
    this.esReplay = replay;
    const foto = p.type === "snapshot";
    if (foto) this.snapshot(g, conservar);
    const cambioVelas = foto || this.update(g);
    const confirmado = this.lineasOrden?.confirmado;
    const vencio = confirmado && Date.now() >= confirmado.vence;
    if (vencio) this.lineasOrden.confirmado = null;
    if (cambioVelas || cambioCapas || vencio) this.agendarDibujo();
  }

  /** Solo la informacion que aparece en las capas: el reloj del feed, el balance
   *  o la cuenta sin posiciones no requieren limpiar y pintar todos los canvas. */
  firmaPayload(p) {
    const b = p.broker;
    const mt5 = this.capas?.posiciones && b?.disponible && (b.posiciones?.length || b.ordenes?.length)
      ? [b.diferencia, b.graficoBroker, b.simbolo, b.cuenta?.moneda, b.info, b.posiciones, b.ordenes] : null;
    const binance = this.capas?.posiciones && p.binance?.disponible
      ? (p.binance.posiciones ?? []).filter((x) => x.simbolo === p.symbol) : [];
    return JSON.stringify([mt5, binance]);
  }

  /** Un resync corto no elimina la historia que el usuario ya cargo a la izquierda.
   *  Desde el primer instante recibido manda siempre la foto nueva. */
  conservarHistoria(g) {
    const desde = g.velas[0]?.time;
    if (desde === undefined || !this.velas.length || this.velas[0].time >= desde) return g;
    // Todas las derivadas deben compartir el mismo calentamiento: concatenar
    // EMAs/ADX de dos ventanas distintas introduce un salto en la union.
    if (!this.cb.recalcularGrafico) return g;
    const velas = this.velas.filter((p) => p.time < desde).concat(g.velas);
    return this.cb.recalcularGrafico(velas);
  }

  /** Todo de nuevo (otro mercado o temporalidad). Con `conservar` (mas historia del
   *  replay) la vista queda donde estaba, corrida por las velas que se sumaron. */
  snapshot(g, conservar = false) {
    const r = conservar ? this.price.timeScale().getVisibleLogicalRange() : null;
    const antes = r && this.velas.length ? { r, desde: this.tiempo(r.from), hasta: this.tiempo(r.to) } : null;
    this.detenerAnimacion();
    // USDT.D es un porcentaje: 3 decimales, como en TradingView.
    const oficial = this.broker?.graficoBroker
      ? [this.broker.digitos, this.broker.info?.digits].find((n) => Number.isInteger(n) && n >= 0 && n <= 8) : undefined;
    const dec = this.symbol === "USDT.D" ? 3 : oficial ?? detectDecimals(g.velas);
    this.decimals = dec;
    const { timeFormatter, tickMarkFormatter } = formateadoresTiempo(this.interval);
    this.price.applyOptions({
      localization: { priceFormatter: (p) => this.fmt(p), timeFormatter },
      timeScale: { tickMarkFormatter },
    });
    const minMove = Number((10 ** -dec).toFixed(dec));
    this.s.velas.applyOptions({ priceFormat: { type: "price", precision: dec, minMove } });
    this.aplicarDatos(g);
    if (antes && this.velas.length) {
      const tramo = antes.r.to - antes.r.from, n = this.velas.length;
      let from = this.indice(antes.desde), to = this.indice(antes.hasta);
      // Si sigue el precio, conserva el zoom y acompana las velas nuevas.
      // Sin solapamiento (otra fuente o historia recortada), muestra el borde
      // mas cercano cargado en lugar de dejar toda la pantalla vacia.
      if (this.siguiendo || from > n - 1) { to = n - 1 + Math.min(this.margen() + 1, tramo / 4); from = to - tramo; }
      else if (to < 0) { to = Math.min(n - 1 + this.margen(), tramo); from = to - tramo; }
      this.price.timeScale().setVisibleLogicalRange({ from, to });
      return;
    }
    this.sinMas = false;
    this.todo = false;
    this.siguiendo = true;
    this.cb.onSeguir(true);
    const n = this.velas.length;
    if (n) this.price.timeScale().setVisibleLogicalRange({ from: n - VISIBLE_BARS * 1.18, to: n + this.margen() });
    this.encuadrar(520);
    if (this.rangoPendiente?.interval === this.interval) this.aplicarRango();
  }

  /** Las series del grafico, todas de una vez. */
  aplicarDatos(g) {
    this.velas = g.velas.slice();
    this.invalidarCapas();
    this.lastTimes = {};
    this.puntosSeries = {};
    const aplicar = (clave, serie, pts) => {
      const datos = pts || [];
      this.puntosSeries[clave] = new Map(datos.map((p) => [p.time, p]));
      this.lastTimes[clave] = datos.at(-1)?.time ?? 0;
      serie.setData(datos);
    };
    aplicar("velas", this.s.velas, g.velas);
    this.s.ema.forEach((serie, i) => aplicar("ema" + i, serie, g.ema[i]));
    this.factorAdx = factorAdx(g.momento);
    this.lineaAdx?.applyOptions({ price: this.nivelAdx * this.factorAdx });
    aplicar("momento", this.s.momento, (g.momento || []).map(areaMomento));
    aplicar("compresion", this.s.compresion, enPaleta(g.compresion, C.compresion));
    aplicar("fuerza", this.s.fuerza, this.adxEnEscala(g.fuerza));
    this.adxPorT = new Map((g.fuerza || []).map((x) => [x.time, x.value]));
  }

  /** El ADX en las unidades del SQZ, para la serie (adxPorT guarda el valor real). */
  adxEnEscala(fuerza) {
    const k = this.factorAdx ?? 1;
    return enPaleta(fuerza, C.adx).map((p) => ({ ...p, value: p.value * k }));
  }

  invalidarCapas() {
    this.huecosCache = this.smcCache = this.obCache = this.sesionesCache = null;
  }

  /** Cerca del borde izquierdo pide las velas anteriores (una tanda por vez, y no
   *  mas si ya no hay). */
  revisarBorde(r) {
    if (this.todo || r.from > 40 || !this.velas.length || this.trayendo || this.sinMas || !this.cb.onMasHistoria) return;
    this.trayendo = true;
    this.cb.onCargando?.(true);
    Promise.resolve().then(() => this.destruido ? undefined : this.cb.onMasHistoria(this.velas[0].time)).catch(() => {}).finally(() => {
      this.trayendo = false;
      if (!this.destruido) this.cb.onCargando?.(false);
    });
  }

  /** Velas mas viejas que las del grafico ([t, o, h, l, c, v], de /api/velas): se
   *  suman adelante, los indicadores se recalculan con toda la serie (`armar`) y la
   *  vista queda donde estaba. */
  anteponer(viejas, hayMas, armar) {
    this.sinMas = !hayMas;
    const a = this.velas;
    if (!a.length) return;
    const nuevas = [...new Map(viejas.filter((x) => x[0] < a[0].time).map((x) => [x[0], x])).values()].sort((x, y) => x[0] - y[0]);
    if (!nuevas.length) return;
    const serie = nuevas.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, closed: true })).concat(a.map(desdeGrafico));
    const r = this.price.timeScale().getVisibleLogicalRange();
    this.aplicarDatos(armar(serie));
    this.correrIndices(nuevas.length);
    if (r) this.price.timeScale().setVisibleLogicalRange({ from: r.from + nuevas.length, to: r.to + nuevas.length });
    this.agendarDibujo();
  }

  /** Sin velas: el replay en una temporalidad que no tiene historia en ese instante. */
  vaciar() {
    this.detenerAnimacion();
    for (const sr of [this.s.velas, ...this.s.ema, this.s.momento, this.s.compresion, this.s.fuerza]) sr.setData([]);
    this.velas = [];
    this.adxPorT = new Map();
    this.lastTimes = {};
    this.puntosSeries = {};
    this.invalidarCapas();
    this.agendarDibujo();
  }

  /** La vela completa (con compras, ventas y open interest) en una hora del grafico
   *  (UTC; la etiqueta del eje se formatea en hora local). */
  velaEn(tEje) {
    const t = tEje;
    const a = this.velas;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m].time === t) return { ...a[m], adx: this.adxPorT.get(t) };
      if (a[m].time < t) lo = m + 1; else hi = m - 1;
    }
    return null;
  }

  update(g) {
    let agregadas = 0, cambioVelas = false;
    for (const b of g.velas) {
      const a = this.velas;
      if (!a.length || b.time > a.at(-1).time) { a.push(b); agregadas++; cambioVelas = true; this.invalidarCapas(); }
      else {
        let lo = 0, hi = a.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].time < b.time) lo = m + 1; else hi = m; }
        if (a[lo]?.time === b.time && !iguales(a[lo], b)) {
          cambioVelas = true;
          if (b.closed !== false || a[lo].closed !== false || lo < a.length - 1) this.invalidarCapas();
          else if (b.high !== a[lo].high || b.low !== a[lo].low) this.sesionesCache = null;
          a[lo] = b;
        }
      }
    }
    const aplicar = (clave, serie, pts) => {
      const anteriores = this.puntosSeries[clave] ??= new Map();
      for (const p of pts || []) {
        const ultimo = this.lastTimes[clave] ?? 0;
        if (iguales(anteriores.get(p.time), p)) continue;
        // LWC permite corregir una vela cerrada existente con historicalUpdate.
        // No se insertan huecos antiguos que no estuvieran en el snapshot.
        if (p.time < ultimo && !anteriores.has(p.time)) continue;
        serie.update(p, p.time < ultimo);
        anteriores.set(p.time, p);
        this.lastTimes[clave] = Math.max(ultimo, p.time);
      }
    };
    aplicar("velas", this.s.velas, g.velas);
    g.ema.forEach((pts, i) => aplicar("ema" + i, this.s.ema[i], pts));
    aplicar("momento", this.s.momento, (g.momento || []).map(areaMomento));
    aplicar("compresion", this.s.compresion, enPaleta(g.compresion, C.compresion));
    aplicar("fuerza", this.s.fuerza, this.adxEnEscala(g.fuerza));
    for (const x of g.fuerza || []) this.adxPorT.set(x.time, x.value);
    if (this.siguiendo && agregadas) {
      if (this.anim) this.correrIndices(agregadas);
      else this.price.timeScale().scrollToRealTime();
    }
    return cambioVelas;
  }

  // ------------------------------------------------------------ coordenadas

  /** Indice logico de un instante, interpolado entre las velas disponibles. */
  indice(t) {
    const a = this.velas;
    if (!a.length) return null;
    if (t < a[0].time) return (t - a[0].time) / this.paso();
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (a[m].time <= t) lo = m; else hi = m - 1;
    }
    if (lo < a.length - 1) {
      const frac = (t - a[lo].time) / (a[lo + 1].time - a[lo].time);
      return lo + frac;
    }
    return lo + (t - a[lo].time) / this.paso();
  }

  /** Instante UTC de una posicion logica, tambien fuera de la historia cargada. */
  tiempo(lg) {
    const a = this.velas, n = a.length;
    if (!n) return null;
    if (lg <= 0) return a[0].time + lg * this.paso();
    if (lg >= n - 1) return a[n - 1].time + (lg - n + 1) * this.paso();
    const i = Math.floor(lg);
    return a[i].time + (a[i + 1].time - a[i].time) * (lg - i);
  }

  /** x de un instante, aunque caiga entre dos velas o fuera de la historia. */
  x(t) {
    const lg = this.indice(t);
    if (lg === null) return null;
    const ts = this.price.timeScale(), i = Math.floor(lg);
    const x0 = ts.logicalToCoordinate(i);
    return x0 === null ? null : x0 + (lg - i) * ts.options().barSpacing;
  }

  paso() {
    const a = this.velas;
    return DURACION[this.interval] ?? segundos(this.interval) ?? (a.length > 1 ? a[a.length - 1].time - a[a.length - 2].time : 3600);
  }

  y(p) {
    return this.s.velas.priceToCoordinate(p);
  }

  /** Como se pasa de precio y de vela a pixel: si cambia, hay que redibujar las capas. */
  firma() {
    const ts = this.price.timeScale(), s = this.s.velas;
    return `${s.coordinateToPrice(0)}|${s.coordinateToPrice(100)}|${ts.coordinateToLogical(0)}|${ts.options().barSpacing}|${ts.width()}|${this.altoPrecio()}`;
  }

  /** La cruz en (x, y) del panel de las velas. Una capa de arriba (un dibujo o la
   *  linea de una operacion bajo el puntero) le saca el mouse al grafico: asi la
   *  cruz lo sigue igual. Fuera del area de las velas se esconde. */
  cruzEn(x, y) {
    this.lineaBajo(y);
    const a = this.velas, ts = this.price.timeScale();
    const lg = ts.coordinateToLogical(x), p = this.s.velas.coordinateToPrice(y);
    if (!a.length || lg === null || p === null || x < 0 || x > ts.width() || y < 0 || y > this.altoPrecio()) { this.sinCruz(); return; }
    const i = Math.max(0, Math.min(a.length - 1, Math.round(lg)));
    this.price.setCrosshairPosition(p, a[i].time, this.s.velas);
  }

  sinCruz() {
    this.price.clearCrosshairPosition();
    this.lineaBajo(null);
  }

  /** La linea de una operacion bajo el puntero (su altura, o null): esa muestra su
   *  etiqueta completa; las demas, solo su rotulo corto en el eje. */
  lineaBajo(y) {
    const l = y === null ? null : this.lineasOrden?.cerca(this.price.timeScale().width() - 1, y, 8);
    const cerca = l ? l.y : null;
    if (cerca === this.lineaCerca) return;
    this.lineaCerca = cerca;
    this.agendarDibujo();
  }

  // ------------------------------------------------------------------ dibujo

  agendarDibujo() {
    if (this.destruido || this.redrawPend) return;
    this.redrawPend = true;
    this.redrawFrame = requestAnimationFrame(() => {
      this.redrawPend = false;
      if (this.destruido) return;
      this.dibujar();
    });
  }

  /** Prepara un canvas del tamano del grafico y devuelve su contexto limpio. */
  lienzo(cv) {
    // Las capas cubren solo el panel de las velas.
    const w = this.els.price.clientWidth, h = this.altoPrecio(), dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      cv.style.width = w + "px";
      cv.style.height = h + "px";
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  dibujar() {
    if (this.destruido) return;
    // El primitivo de LWC ya puede haber sincronizado las escalas en este cuadro.
    // Ese repintado tambien satisface cualquier solicitud de canvas pendiente.
    if (this.redrawPend) { cancelAnimationFrame(this.redrawFrame); this.redrawPend = false; }
    this.firmaDibujo = this.firma();
    const { ctx, w, h } = this.lienzo(this.els.canvas);
    let plotW = this.price.timeScale().width();
    if (!plotW || plotW < 50) plotW = Math.max(120, w - ESCALA_PX);
    // cajas: las etiquetas ya puestas (para no encimar otra); ejes: marcas en la escala.
    const d = { ctx, w: plotW, h, cajas: [], ejes: [], eje: w - plotW, der: plotW };
    // Con el perfil de rango, las etiquetas de la derecha van a su izquierda: no lo tapan.
    if (this.vp.vpvr && this.capas.volumen && this.velas.length) d.der = plotW - this.anchoVpvr(plotW) - 6;
    // El precio actual ya tiene su marca en el eje: las de los niveles no la tapan.
    const ult = this.velas.at(-1);
    const yUlt = ult ? this.y(ult.close) : null;
    // Y debajo va la cuenta regresiva del cierre de la vela.
    if (yUlt !== null) d.ejes.push(yUlt, yUlt + 17);

    // Las operaciones van en su lienzo, arriba de todo (tambien de los dibujos), y se
    // ubican primero: sus etiquetas y sus marcas en el eje quedan justo en su precio.
    const op = this.els.posiciones ? { ...d, ctx: this.lienzo(this.els.posiciones).ctx } : d;
    if (this.lineasOrden) this.lineasOrden.lineas = [];
    this.botones = [];
    if (this.capas.posiciones) this.posiciones(op);
    this.borrador(op);
    this.dibujarSimulacion(op);

    const fondo = this.lienzo(this.els.fondo);
    if (this.capas.sesiones) this.dibujarSesiones({ ...fondo, w: plotW });
    if (this.capas.fvg) this.dibujarHuecos({ ...fondo, w: plotW });
    if (this.capas.ob) this.dibujarOB({ ...fondo, w: plotW });
    if (this.capas.volumen && (this.vp.vpvr || this.vp.vpsv)) this.perfil(d);
    if (this.capas.estructura) this.dibujarEstructura(d);
    this.dibujos?.dibujar(d);
    this.dibujos?.dibujarPuntero(op);
    this.dibujarCuenta();
  }

  /** Lo que falta para que cierre la vela actual, en una marca justo debajo del
   *  precio en el eje (del color de la vela). Con el mercado cerrado no se muestra. */
  dibujarCuenta() {
    if (!this.cuentaCv) return;
    const { ctx, w, h } = this.lienzo(this.cuentaCv);
    const ult = this.velas.at(-1);
    if (!ult || ult.closed === true) return;
    const fin = finVela(ult.time, this.interval);
    const falta = fin === null ? NaN : fin - Date.now() / 1000;
    if (!(falta > 0) || falta > (DURACION[this.interval] ?? segundos(this.interval) ?? 31 * 86_400)) return;
    const y = this.y(ult.close);
    const plotW = this.price.timeScale().width();
    const ancho = w - plotW;
    if (y === null || y < 0 || y > h - 20 || !(ancho >= 40)) return;
    const top = Math.round(y) + 10;   // la etiqueta del precio mide unos 20 px
    ctx.fillStyle = ult.close >= ult.open ? C.sube : C.baja;
    ctx.fillRect(plotW, top, ancho, 15);
    ctx.fillStyle = "#fff";
    ctx.font = `500 10.5px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(faltaTexto(falta), plotW + 6, top + 8);
  }

  /** Linea horizontal con su etiqueta: a la derecha (las de las operaciones y los
   *  niveles, sin tapar el perfil de volumen) o a la izquierda, desde `desde` (nunca
   *  debajo de la barra de dibujo). Con `eje`, el
   *  precio va en una marca sobre la escala, como el precio actual. Devuelve la caja
   *  de la etiqueta (para tomarla con el mouse), o null. */
  nivel(d, precio, color, texto, {
    desde = 0, guion = [], ancho = 1, etiqueta = true, valor = null, izquierda = false, eje = false, corto = null,
  } = {}) {
    const yy = this.y(precio);
    if (yy === null || yy < -10 || yy > d.h + 10) return null;
    // Con rotulo corto (las operaciones), la etiqueta larga solo con el puntero encima:
    // asi no tapa las ultimas velas ni el precio actual.
    // Con la pildora (lado, cantidad y resultado) no hace falta nunca.
    const encima = this.lineaCerca !== null && this.lineaCerca !== undefined && Math.abs(this.lineaCerca - yy) < 1.5;
    if (corto && eje && (typeof corto !== "string" || !encima)) etiqueta = false;
    const { ctx } = d;
    let caja = null;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = ancho;
    ctx.setLineDash(guion);
    ctx.beginPath();
    ctx.moveTo(Math.max(0, desde), Math.round(yy) + 0.5);
    ctx.lineTo(d.w, Math.round(yy) + 0.5);
    ctx.stroke();
    if (etiqueta && texto) {
      ctx.setLineDash([]);
      ctx.font = `500 10.5px ${FONT}`;
      // Con marca en el eje, el precio ya se lee ahi.
      const txt = eje ? texto : `${texto}  ${this.fmt(valor ?? precio)}`;
      const tw = ctx.measureText(txt).width;
      // Si otra etiqueta (de cualquier lado) ya ocupa ese lugar, se corre arriba o
      // abajo: nunca encimadas.
      const x0 = izquierda ? Math.max(this.izqLibre, desde) + 3 : (d.der ?? d.w) - tw - 14, x1 = x0 + tw + 10;
      let ly = yy;
      for (const paso of [0, 17, -17, 34, -34, 51, -51, 68, -68]) {
        if (d.cajas.every((c) => c.x1 < x0 || c.x0 > x1 || Math.abs(c.y - (yy + paso)) >= 17)) { ly = yy + paso; break; }
      }
      d.cajas.push({ x0, x1, y: ly });
      ctx.textBaseline = "middle";
      if (izquierda) {
        const x = x0 + 5;
        caja = { x: x - 5, y: ly - 8.5, w: tw + 10, h: 17 };
        ctx.fillStyle = C.fondoEtiqueta;
        ctx.fillRect(x - 5, ly - 8.5, tw + 10, 17);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 4.5, ly - 8, tw + 9, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.textAlign = "left";
        ctx.fillText(txt, x, ly + 0.5);
      } else {
        const der = d.der ?? d.w;
        caja = { x: der - tw - 14, y: ly - 8, w: tw + 10, h: 16 };
        ctx.fillStyle = C.fondoEtiqueta;
        ctx.fillRect(der - tw - 14, ly - 8, tw + 10, 16);
        ctx.fillStyle = color;
        ctx.textAlign = "right";
        ctx.fillText(txt, der - 9, ly);
      }
    }
    ctx.restore();
    if (eje) this.marcaEje(d, yy, color, this.fmt(valor ?? precio), corto);
    return caja;
  }

  /** Marca de un nivel sobre la escala de precios. Si otra ya ocupa esa altura se
   *  corre lo justo (sin raya hasta su precio: el texto ya lo dice). */
  marcaEje(d, y, color, texto, corto = null) {
    if (!(d.eje >= 40)) return;
    let ty = y;
    for (const paso of [0, 16, -16, 32, -32, 48, -48, 64, -64]) {
      if (d.ejes.every((u) => Math.abs(u - (y + paso)) >= 16)) { ty = y + paso; break; }
    }
    d.ejes.push(ty);
    const { ctx } = d;
    const x0 = d.w + 1, ancho = d.eje - 3;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, ty - 8, ancho, 16, 2); else ctx.rect(x0, ty - 8, ancho, 16);
    ctx.fill();
    ctx.fillStyle = textoSobre(color);
    ctx.font = `600 10.5px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, x0 + 5, ty + 0.5);
    // El rotulo: pegado al precio, asomando apenas hacia el grafico.
    // [lado o SL/TP | cantidad · resultado | ✕]; la ✕ cierra o cancela (se registra
    // para el clic).
    if (corto) {
      const r = typeof corto === "string" ? { tag: corto } : corto;
      ctx.font = `600 10px ${FONT}`;
      const wTag = ctx.measureText(r.tag).width + 10;
      ctx.font = `500 10px ${MONO}`;
      const wInfo = r.info ? ctx.measureText(r.info).width + 10 : 0;
      const wX = r.cerrar ? 16 : 0;
      const x1 = d.w - 2, xa = x1 - wTag - wInfo - wX;
      // El fondo (oscuro) con el borde del color, y el rotulo relleno a la izquierda.
      ctx.fillStyle = C.fondoEtiqueta;
      ctx.fillRect(xa, ty - 8, x1 - xa, 16);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(xa) + 0.5, Math.round(ty - 8) + 0.5, Math.round(x1 - xa) - 1, 15);
      ctx.fillStyle = color;
      ctx.fillRect(xa, ty - 8, wTag, 16);
      ctx.fillStyle = textoSobre(color);
      ctx.font = `600 10px ${FONT}`;
      ctx.fillText(r.tag, xa + 5, ty + 0.5);
      if (r.info) {
        ctx.fillStyle = color;
        ctx.font = `500 10px ${MONO}`;
        ctx.fillText(r.info, xa + wTag + 5, ty + 0.5);
      }
      if (r.cerrar) {
        const xx = x1 - wX;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(xx + 0.5, ty - 8); ctx.lineTo(xx + 0.5, ty + 8);
        ctx.moveTo(xx + 5, ty - 3.5); ctx.lineTo(xx + 11, ty + 2.5);
        ctx.moveTo(xx + 11, ty - 3.5); ctx.lineTo(xx + 5, ty + 2.5);
        ctx.stroke();
        this.botones.push({ x0: xx, x1, y0: ty - 8, y1: ty + 8, cerrar: r.cerrar });
      }
      d.cajas?.push({ x0: xa, x1: d.w, y: ty });
    }
    ctx.restore();
  }

  /** La ✕ de la etiqueta de una operacion bajo (x, y), o null. */
  botonEn(x, y) {
    return (this.botones ?? []).find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) ?? null;
  }

  /** Donde se abrio una posicion: un triangulo sobre la linea de entrada. */
  marcaApertura(d, x, precio, compra) {
    const y = this.y(precio);
    if (y === null || x < 0 || x > d.w) return;
    const { ctx } = d;
    ctx.save();
    ctx.fillStyle = compra ? C.entrada : C.baja;
    ctx.beginPath();
    if (compra) { ctx.moveTo(x, y + 2); ctx.lineTo(x - 5, y + 10); ctx.lineTo(x + 5, y + 10); }
    else { ctx.moveTo(x, y - 2); ctx.lineTo(x - 5, y - 10); ctx.lineTo(x + 5, y - 10); }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Ancho del perfil de rango (VPVR) a la derecha del grafico. */
  anchoVpvr(plotW) {
    return Math.min(150, Math.max(24, plotW * 0.14));
  }

  banda(d, p1, p2, color, desde = 0, hasta = null) {
    const y1 = this.y(p1), y2 = this.y(p2);
    if (y1 === null || y2 === null) return;
    d.ctx.fillStyle = color;
    d.ctx.fillRect(Math.max(0, desde), Math.min(y1, y2), (hasta ?? d.w) - Math.max(0, desde), Math.max(1, Math.abs(y2 - y1)));
  }

  /** Etiqueta chica con fondo, centrada en (x, y). */
  rotulo(d, x, y, texto, color, font = `600 9.5px ${FONT}`) {
    const { ctx } = d;
    ctx.font = font;
    const w = ctx.measureText(texto).width + 6;
    ctx.fillStyle = C.fondoEtiqueta;
    ctx.fillRect(x - w / 2, y - 6.5, w, 13);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, x, y + 0.5);
  }

  /** Zonas del diario: donde comprar (franjas verdes, mas intensas cuanto mas
   *  liquidez de largos tienen) y hasta donde puede llegar (amarillo). Se ven en
   *  todas las temporalidades: en 4H o 1H sirven para afinar la entrada. */
  /** Lo abierto en MT5 y en Binance, en el mismo grafico. */
  posiciones(d) {
    this.posicionesDe(d, this.broker);
    this.posicionesBinance(d);
  }

  /** Las posiciones de Binance de este mercado: entrada, SL, TP y liquidacion. El SL
   *  y el TP se arrastran como los de MT5 (la entrada, hacia la perdida, pone el SL y
   *  hacia la ganancia el TP); al soltar, la interfaz pide confirmacion. */
  posicionesBinance(d) {
    const b = this.binance;
    if (!b?.disponible) return;
    const lo = this.lineasOrden;
    for (const p of b.posiciones ?? []) {
      if (p.simbolo !== this.symbol) continue;
      const compra = p.lado === "buy";
      const usdt = (x) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), 2)} USDT`;
      const desde = Math.max(0, d.w * 0.5);
      // Lo que necesita el arrastre: el tick del precio y que es de Binance.
      const dec = Math.min(8, String(p.entrada).split(".")[1]?.length ?? 2);
      const item = { ticket: `bn:${p.simbolo}:${p.lado}`, tipo: p.lado, entrada: p.entrada, sl: p.sl, tp: p.tp, simbolo: p.simbolo, lado: p.lado, cantidad: p.cantidad, binance: true };
      const bloque = { graficoBroker: true, info: { tick_size: 10 ** -Math.max(1, dec) } };
      const registrar = (campo, precio) => {
        const yy = this.y(precio);
        if (lo && yy !== null) lo.lineas.push({ ticket: item.ticket, campo, y: yy, precio, item, bloque });
      };
      const ahora = (campo, original) => (lo ? lo.precioDe(item.ticket, campo, original) : original);
      this.nivel(d, p.entrada, C.entrada, `Binance · ${compra ? "Compra" : "Venta"} ${fmtNum(p.cantidad, 3)}${p.apalancamiento ? ` ×${p.apalancamiento}` : ""} · ${usdt(p.pnl)}`,
        { ancho: 1.4, guion: [6, 3], valor: p.entrada, eje: true, desde, corto: {
          tag: compra ? "Largo" : "Corto", info: `${fmtNum(p.cantidad, 3)} · ${signo2(p.pnl)} USDT`,
          cerrar: { binance: true, accion: "cerrar", symbol: p.simbolo, lado: p.lado, nombre: `${compra ? "compra" : "venta"} ${fmtNum(p.cantidad, 3)} ${p.simbolo} en Binance` },
        } });
      registrar("entrada", p.entrada);
      for (const [campo, color] of [["sl", C.baja], ["tp", C.sube]]) {
        const original = p[campo] ?? null;
        const precio = ahora(campo, original);
        if (!ok(precio)) continue;
        const mueve = precio !== original;
        if (mueve && original) this.nivel(d, original, C.tenue, null, { guion: [5, 3], etiqueta: false, ancho: 1 });
        const resultado = (compra ? 1 : -1) * (precio - p.entrada) * p.cantidad;
        this.nivel(d, precio, color, `Binance · ${campo.toUpperCase()}${mueve ? " nuevo" : ""} · ${usdt(resultado)}`,
          { ancho: mueve ? 2 : 1, guion: mueve ? [10, 4] : [5, 3], valor: precio, eje: true, desde, corto: mueve ? null : { tag: campo.toUpperCase(), info: `${signo2(resultado)} USDT` } });
        registrar(campo, precio);
      }
      if (p.liquidacion) this.nivel(d, p.liquidacion, C.baja, "Binance · liquidación", { ancho: 1, guion: [2, 3], valor: p.liquidacion, eje: true, desde, corto: "Liq." });
    }
  }

  /** Las sesiones del mercado (Sidney, Tokio, Londres y Nueva York) a la vista:
   *  una caja por sesion con su maximo y su minimo, detras de las velas. Solo hasta 1H. */
  dibujarSesiones(f) {
    const a = this.velas;
    if (!a.length || !(segundos(this.interval) <= 3600)) return;
    const r = this.price.timeScale().getVisibleLogicalRange();
    if (!r) return;
    const i0 = Math.max(0, Math.floor(r.from)), i1 = Math.min(a.length - 1, Math.ceil(r.to));
    if (i0 > i1) return;
    const { ctx } = f;
    const t0 = a[i0].time, t1 = a[i1].time + this.paso();
    ctx.save();
    ctx.font = `600 10px ${FONT}`;
    ctx.textBaseline = "bottom";
    for (const s of this.cajasSesiones()) {
      if (s.fin <= t0 || s.inicio >= t1) continue;
      const x0 = this.x(s.inicio), x1 = this.x(Math.min(s.fin, a.at(-1).time + this.paso()));
      // Arriba y abajo en pantalla (con la escala invertida, el maximo queda abajo).
      const ya = this.y(s.alto), yb = this.y(s.bajo);
      if ([x0, x1, ya, yb].some((v) => v === null) || x1 < 0 || x0 > f.w) continue;
      const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
      const izq = Math.max(0, x0), der = Math.min(f.w, x1);
      ctx.fillStyle = `rgba(${s.rgb},.08)`;
      ctx.fillRect(izq, y0, der - izq, Math.max(1, y1 - y0));
      ctx.strokeStyle = `rgba(${s.rgb},.5)`;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(izq + 0.5, y0 + 0.5, der - izq - 1, Math.max(1, y1 - y0) - 1);
      ctx.setLineDash([]);
      if (x0 >= 0 && der - izq > 40) {
        ctx.fillStyle = `rgba(${s.rgb},.95)`;
        ctx.fillText(s.nombre, izq + 3, y0 - 2);
      }
    }
    ctx.restore();
  }

  /** Las cajas de las sesiones de las velas cargadas, con su maximo y minimo.
   *  Se rearman solo si cambian las velas (o la que esta en curso). */
  cajasSesiones() {
    const a = this.velas;
    const u = a.at(-1);
    const clave = `${this.interval}|${a.length}|${a[0].time}|${u.time}|${u.high}|${u.low}`;
    if (this.sesionesCache?.clave === clave) return this.sesionesCache.cajas;
    const cajas = [];
    let k = 0;
    for (const s of sesionesEntre(a[0].time, u.time + this.paso()).sort((x, y) => x.inicio - y.inicio)) {
      // Las velas estan en orden: se busca el comienzo y se recorre la sesion.
      let lo = 0, hi = a.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].time < s.inicio) lo = m + 1; else hi = m; }
      let alto = -Infinity, bajo = Infinity;
      for (k = lo; k < a.length && a[k].time < s.fin; k++) { alto = Math.max(alto, a[k].high); bajo = Math.min(bajo, a[k].low); }
      if (alto > bajo) cajas.push({ ...s, alto, bajo });
    }
    this.sesionesCache = { clave, cajas };
    return cajas;
  }

  /** Posiciones abiertas de una cuenta (entrada, stop y objetivo), pasadas al
   *  precio del grafico con su diferencia. La etiqueta muestra el precio de la
   *  cuenta y lo que da el SL o el TP si toca. Cada linea queda registrada para
   *  poder arrastrarla; la que se esta moviendo se ve resaltada y la vieja, tenue.
   *  Las de Binance dicen "Binance" y suman su precio de liquidacion. */
  posicionesDe(d, b) {
    if (!b?.disponible) return;
    const dif = b.graficoBroker ? 0 : b.diferencia;
    if (dif === null || dif === undefined) return;
    // Precio de la cuenta -> precio del grafico.
    const g = (x) => x - dif;
    const lo = this.lineasOrden;
    const moneda = b.cuenta?.moneda ?? "USD";
    const vol = (x) => fmtNum(x.volumen, 2);
    const registrar = (item, campo, precio) => {
      const yy = this.y(g(precio));
      if (lo && yy !== null) lo.lineas.push({ ticket: item.ticket, campo, y: yy, precio, item, bloque: b });
    };
    const ahora = (item, campo, original) => (lo ? lo.precioDe(item.ticket, campo, original) : original);
    // SL o TP: la banda de lo que se arriesga o se gana sale desde la apertura.
    const salida = (item, campo, nombre, estilo, desdeBanda) => {
      const original = item[campo] ?? null;
      const precio = ahora(item, campo, original);
      const mueve = precio !== original;
      if (mueve && original) this.nivel(d, g(original), C.tenue, null, { ...estilo, etiqueta: false, ancho: 1 });
      if (!ok(precio)) return;
      const color = campo === "sl" ? C.baja : C.sube;
      const r = resultadoEn(item, precio, b.info);
      const dinero = Number.isFinite(r.usd) ? ` · ${r.usd >= 0 ? "+" : "−"}${fmtNum(Math.abs(r.usd), 2)} ${moneda}` : "";
      const pips = Number.isFinite(r.pips) ? ` · ${fmtNum(r.pips, 1)} pips` : "";
      if (mueve) {
        this.banda(d, g(item.entrada), g(precio), campo === "sl" ? `rgba(${C.rgbBaja},.08)` : `rgba(${C.rgbSube},.08)`, desdeBanda);
        this.nivel(d, g(precio), color, `${campo.toUpperCase()} nuevo${dinero}${pips}`,
          { ancho: 2, guion: [10, 4], valor: precio, eje: true });
      } else {
        this.nivel(d, g(precio), color, `${campo.toUpperCase()} · ${nombre}${dinero}`,
          { ...estilo, valor: precio, eje: true, corto: { tag: campo.toUpperCase(), info: Number.isFinite(r.usd) ? `${vol(item)} · ${signo2(r.usd)} ${moneda}` : vol(item) } });
      }
      registrar(item, campo, precio);
    };
    for (const p of b.posiciones ?? []) {
      const xa = p.desde ? this.x(p.desde) : null;
      const lado = p.tipo === "buy" ? "Compra" : "Venta";
      const pl = p.profit !== null && p.profit !== undefined ? ` · ${p.profit >= 0 ? "+" : ""}${fmtNum(p.profit, 2)} ${moneda}` : "";
      this.nivel(d, g(p.entrada), C.entrada, `${lado} ${vol(p)} · ${b.simbolo}${pl}`,
        { ancho: 1.6, valor: p.entrada, eje: true, corto: {
          tag: p.tipo === "buy" ? "Largo" : "Corto",
          info: Number.isFinite(p.profit) ? `${vol(p)} · ${signo2(p.profit + (p.swap ?? 0))} ${moneda}` : vol(p),
          cerrar: { accion: "cerrar", ticket: p.ticket, nombre: `${lado.toLowerCase()} ${vol(p)} ${b.simbolo}` },
        } });
      if (xa !== null) this.marcaApertura(d, xa, g(p.entrada), p.tipo === "buy");
      registrar(p, "entrada", p.entrada);
      const desde = xa !== null ? Math.max(0, xa) : 0;
      const nombre = `${lado.toLowerCase()} ${vol(p)}`;
      salida(p, "sl", nombre, { guion: [5, 3], ancho: 1.2 }, desde);
      salida(p, "tp", nombre, { guion: [5, 3], ancho: 1.2 }, desde);
    }
    // Ordenes pendientes (limite o stop): punteadas, como en MT5. Se mueven su
    // precio, su SL y su TP.
    for (const o of b.ordenes ?? []) {
      const nombre = `${nombreOperacion(o)} ${vol(o)}`;
      const precio = ahora(o, "precio", o.entrada);
      const mueve = precio !== o.entrada;
      if (mueve) this.nivel(d, g(o.entrada), C.tenue, null, { guion: [8, 4], etiqueta: false });
      this.nivel(d, g(precio), C.objetivo, mueve ? `${nombre} · precio nuevo` : nombre,
        { ancho: mueve ? 2 : 1.4, guion: [8, 4], valor: precio, eje: true, corto: mueve ? null : {
          tag: nombreOperacion(o), info: vol(o), cerrar: { accion: "cancelar", ticket: o.ticket, nombre: `${nombre} ${b.simbolo}` },
        } });
      registrar(o, "precio", precio);
      // Con el precio movido, el SL y el TP se miden desde el precio nuevo.
      const item = mueve ? { ...o, entrada: precio } : o;
      salida(item, "sl", nombre.toLowerCase(), { guion: [3, 4], ancho: 1 }, 0);
      salida(item, "tp", nombre.toLowerCase(), { guion: [3, 4], ancho: 1 }, 0);
    }
  }

  /** La orden que se esta armando: entrada, SL y TP con lo que representan. */
  borrador(d) {
    const b = this.borradorOrden;
    if (!b) return;
    // Sus lineas se arrastran (el precio limite, el SL y el TP): mientras se mueve una,
    // se dibuja donde va; al soltar, el precio va al formulario de Operar.
    const lo = this.lineasOrden;
    const ahora = (campo, original) => (lo ? lo.precioDe("borrador", campo, original) : original);
    const o = { ...b, entrada: b.tipo === "limite" ? ahora("precio", b.entrada) : b.entrada, sl: ahora("sl", b.sl), tp: ahora("tp", b.tp) };
    const dif = o.dif || 0, k = o.k || 1;
    const g = (x) => (x - dif) * k;
    const item = { ticket: "borrador", borrador: true, tipo: o.lado, entrada: o.entrada, sl: o.sl, tp: o.tp };
    const registrar = (campo, precio) => {
      const yy = Number.isFinite(precio) ? this.y(g(precio)) : null;
      if (lo && yy !== null) lo.lineas.push({ ticket: "borrador", campo, y: yy, precio, item });
    };
    const compra = o.lado === "buy";
    const usd = (x) => (Number.isFinite(x) ? fmtNum(x, 2) : "—");
    const vol = Number.isFinite(o.volumen) && o.volumen > 0 ? ` ${fmtNum(o.volumen, 2)}` : "";
    const nombre = `${o.demo ? "Demo · nueva" : "Nueva"} ${compra ? "compra" : "venta"}${o.tipo === "limite" ? " límite" : ""}${vol}`;
    if (o.sl && o.entrada) this.banda(d, g(o.entrada), g(o.sl), `rgba(${C.rgbBaja},.10)`, d.w * 0.55);
    if (o.tp && o.entrada) this.banda(d, g(o.entrada), g(o.tp), `rgba(${C.rgbSube},.10)`, d.w * 0.55);
    const estilo = { ancho: 1.4, guion: [10, 5], desde: d.w * 0.55, eje: true };
    this.nivel(d, g(o.entrada), C.texto, nombre, { ...estilo, valor: o.entrada, corto: o.tipo === "limite" ? (compra ? "Compra lím." : "Venta lím.") : "Nueva" });
    if (o.sl) this.nivel(d, g(o.sl), C.baja, `SL nuevo · −${usd(o.slUsd)}`, { ...estilo, valor: o.sl, corto: `SL −${usd(o.slUsd)}` });
    if (o.tp) this.nivel(d, g(o.tp), C.sube, `TP nuevo · +${usd(o.tpUsd)}`, { ...estilo, valor: o.tp, corto: `TP +${usd(o.tpUsd)}` });
    if (o.tipo === "limite") registrar("precio", o.entrada);
    if (o.sl) registrar("sl", o.sl);
    if (o.tp) registrar("tp", o.tp);
  }

  /** Las operaciones simuladas: las vivas con su entrada, SL y TP (punteada la
   *  limite que espera); las cerradas, de la entrada a la salida con su resultado. */
  dibujarSimulacion(d) {
    const { ctx } = d;
    for (const o of this.simulacion) {
      const compra = o.lado === 1;
      if (o.estado === "pendiente" || o.estado === "abierta") {
        const desde = Math.max(0, this.x(o.entro ?? o.creada) ?? 0);
        if (o.estado === "abierta") {
          this.banda(d, o.entrada, o.sl, `rgba(${C.rgbBaja},.09)`, desde);
          if (o.tp) this.banda(d, o.entrada, o.tp, `rgba(${C.rgbSube},.09)`, desde);
        }
        const estilo = { ancho: 1.4, guion: o.estado === "pendiente" ? [8, 4] : [], eje: true, desde };
        this.nivel(d, o.entrada, compra ? C.sube : C.baja,
          `${o.etiqueta ?? "Sim"} · ${compra ? "compra" : "venta"}${o.estado === "pendiente" ? " límite" : ""} ${fmtNum(o.lotes, 2)}`, { ...estilo, valor: o.entrada });
        this.nivel(d, o.sl, C.baja, `SL · −${fmtNum(o.riesgoUsd, 0)} USD`, { ...estilo, ancho: 1, guion: [5, 3], valor: o.sl });
        if (o.tp) {
          const gana = o.lotes * o.valorPunto * Math.abs(o.tp - o.entrada);
          this.nivel(d, o.tp, C.sube, `TP · +${fmtNum(gana, 0)} USD`, { ...estilo, ancho: 1, guion: [5, 3], valor: o.tp });
        }
      } else if (o.estado === "cerrada" && o.entro) {
        const x0 = this.x(o.entro), x1 = this.x(o.cerrada), y0 = this.y(o.entrada), y1 = this.y(o.salida);
        if ([x0, x1, y0, y1].some((v) => v === null) || Math.max(x0, x1) < 0 || Math.min(x0, x1) > d.w) continue;
        const color = o.r > 0.01 ? C.sube : o.r < -0.01 ? C.baja : C.tenue;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
        const texto = `${compra ? "C" : "V"} ${o.r >= 0 ? "+" : "−"}${fmtNum(Math.abs(o.r), 1)} R`;
        ctx.font = `600 10px ${FONT}`;
        const tw = ctx.measureText(texto).width;
        const ty = o.r >= 0 === compra ? y1 - 12 : y1 + 12;
        ctx.fillStyle = C.fondoEtiqueta;
        ctx.fillRect(x1 + 5, ty - 7, tw + 8, 14);
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(texto, x1 + 9, ty);
        ctx.restore();
      }
    }
  }

  /** Los FVG e IFVG sin barrer de las velas cerradas cargadas (como en el indicador
   *  de TradingView): un FVG que una vela cierra al otro lado se invierte (IFVG); si
   *  solo la mecha lo atraviesa entero, ya fue barrido y se borra. Un IFVG se borra
   *  cuando una mecha lo atraviesa de vuelta. Quedan los 8 FVG y los 4 IFVG mas
   *  recientes. Se recalcula solo si cambian las velas. */
  huecos() {
    const a = this.velas, n = a.length;
    const ultima = a.findLast((v) => v.closed !== false);
    const clave = `${a[0]?.time}|${ultima?.time}|${ultima?.close}|${ultima?.high}|${ultima?.low}`;
    if (this.huecosCache?.clave === clave) return this.huecosCache;
    const fvgs = [], ifvgs = [];
    for (let i = 2; i < n; i++) {
      const v = a[i], c = v.close;
      if (v.closed === false) break;
      const p1 = a[i - 2], p2 = a[i - 1];
      if (v.low > p1.high && p2.close > p1.high) fvgs.push({ t: p1.time, top: v.low, bot: p1.high, alc: true });
      else if (v.high < p1.low && p2.close < p1.low) fvgs.push({ t: p1.time, top: p1.low, bot: v.high, alc: false });
      if (fvgs.length > 8) fvgs.shift();
      for (let k = ifvgs.length - 1; k >= 0; k--) {
        const z = ifvgs[k];
        if (z.alc ? v.high > z.top : v.low < z.bot) ifvgs.splice(k, 1);
      }
      for (let k = fvgs.length - 1; k >= 0; k--) {
        const z = fvgs[k];
        const cierra = z.alc ? c < z.bot : c > z.top, barre = z.alc ? v.low < z.bot : v.high > z.top;
        if (!cierra && !barre) continue;
        fvgs.splice(k, 1);
        if (!cierra) continue;
        ifvgs.push(z);
        if (ifvgs.length > 4) ifvgs.shift();
      }
    }
    this.huecosCache = { clave, fvgs, ifvgs };
    return this.huecosCache;
  }

  /** Las zonas de la capa FVG, por debajo de las velas: del hueco hasta el borde. */
  dibujarHuecos(f) {
    const { ctx, w } = f;
    const { fvgs, ifvgs } = this.huecos();
    const zonas = [...(this.zonas.fvg ? fvgs.map((z) => ({ ...z, inv: false })) : []), ...(this.zonas.ifvg ? ifvgs.map((z) => ({ ...z, inv: true })) : [])];
    ctx.save();
    ctx.font = `600 9.5px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const z of zonas) {
      const x0 = Math.max(0, this.x(z.t) ?? 0), y0 = this.y(z.top), y1 = this.y(z.bot);
      if (y0 === null || y1 === null || x0 >= w) continue;
      // El IFVG cambia de lado: el que nacio alcista ahora es resistencia (rojo).
      const color = (z.inv ? !z.alc : z.alc) ? C.sube : C.baja;
      const top = Math.min(y0, y1), alto = Math.max(1, Math.abs(y1 - y0));
      ctx.fillStyle = conAlfa(color, 0.13);
      ctx.fillRect(x0, top, w - x0, alto);
      ctx.strokeStyle = conAlfa(color, z.inv ? 0.6 : 0.4);
      ctx.lineWidth = 1;
      ctx.setLineDash(z.inv ? [4, 3] : []);
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(top) + 0.5, Math.round(w - x0) - 1, Math.round(alto));
      if (alto >= 9) {
        ctx.fillStyle = conAlfa(color, 0.85);
        ctx.fillText(z.inv ? "IFVG" : "FVG", w - 6, top + alto / 2);
      }
    }
    ctx.restore();
  }

  /** La estructura y los order blocks de las velas cargadas (src/smc.ts: giros de dos
   *  niveles, BOS/CHoCH y OB con desplazamiento, FVG y volumen a la misma hora). Se
   *  recalculan solo si cambian las velas cerradas. */
  smc() {
    const a = this.velas, n = a.length;
    const ult = a.findLast?.((v) => v.closed !== false);
    const clave = `${n}|${a[0]?.time}|${ult?.time}|${ult?.close}`;
    if (this.smcCache?.clave !== clave) this.smcCache = { clave, r: smc(a) };
    return this.smcCache.r;
  }

  /** Los order blocks de las velas cargadas (src/orderBlocks.ts: giro, ruptura con
   *  cierre y filtro de volumen). Se recalculan solo si cambian las velas cerradas. */
  orderBlocks() {
    const a = this.velas, n = a.length;
    const ult = a.findLast?.((v) => v.closed !== false);
    const clave = `${n}|${a[0]?.time}|${ult?.time}|${ult?.close}`;
    if (this.obCache?.clave !== clave) this.obCache = { clave, obs: orderBlocks(a) };
    return this.obCache.obs;
  }

  /** Cada OB por debajo de las velas, de su vela hasta el borde: adentro, el volumen
   *  (la parte comprada en verde y la vendida en rojo, mas larga cuanto mas volumen
   *  tiene contra los otros) y la etiqueta con el total y el % del lado que lo armo. */
  dibujarOB(f) {
    const { ctx, w } = f;
    const obs = this.orderBlocks();
    if (!obs.length) return;
    const maxVol = Math.max(...obs.map((z) => z.vol), 1);
    const corto = (v) => (v >= 1e9 ? `${fmtNum(v / 1e9, 1)} B` : v >= 1e6 ? `${fmtNum(v / 1e6, 1)} M` : v >= 1e3 ? `${fmtNum(v / 1e3, 1)} K` : fmtNum(v, 0));
    ctx.save();
    ctx.font = `600 9.5px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const z of obs) {
      const x0 = Math.max(0, this.x(z.t) ?? 0), y0 = this.y(z.top), y1 = this.y(z.bot);
      if (y0 === null || y1 === null || x0 >= w) continue;
      const color = z.alc ? C.sube : C.baja;
      const top = Math.min(y0, y1), alto = Math.max(2, Math.abs(y1 - y0));
      ctx.fillStyle = conAlfa(color, z.probado ? 0.07 : 0.14);
      ctx.fillRect(x0, top, w - x0, alto);
      ctx.strokeStyle = conAlfa(color, z.probado ? 0.35 : 0.6);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(top) + 0.5, Math.round(w - x0) - 1, Math.round(alto));
      // El volumen: compra y venta, proporcional al del OB con mas volumen.
      if (z.vol > 0) {
        const largo = Math.min(160, (w - x0) * 0.35) * (z.vol / maxVol);
        const comp = largo * z.compra;
        const barra = Math.max(2, Math.min(alto - 2, 6));
        const yb = top + (alto - barra) / 2;
        ctx.fillStyle = conAlfa(C.sube, 0.55);
        ctx.fillRect(x0 + 1, yb, comp, barra);
        ctx.fillStyle = conAlfa(C.baja, 0.55);
        ctx.fillRect(x0 + 1 + comp, yb, largo - comp, barra);
      }
      if (alto >= 9) {
        const lado = z.alc ? z.compra : 1 - z.compra;
        ctx.fillStyle = conAlfa(color, 0.9);
        ctx.fillText(`OB ${z.vol > 0 ? `${corto(z.vol)} · ${fmtNum(lado * 100, 0)} % ${z.alc ? "compra" : "venta"}` : ""}`.trim(), w - 6, top + alto / 2);
      }
    }
    ctx.restore();
  }

  /** La estructura sobre las velas: cada ruptura, del giro
   *  roto a la vela que lo rompio, con BOS o CHoCH (la swing llena, la interna
   *  punteada y mas chica); los giros swing con HH/HL/LH/LL, y el maximo y el minimo
   *  del tramo swing (fuerte o debil) hasta el borde. */
  dibujarEstructura(d) {
    const { ctx, w } = d;
    const r = this.smc();
    const ver = (nivel) => (nivel === "swing" ? this.zonas.estrSwing : this.zonas.estrInterna);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, d.h);
    ctx.clip();
    ctx.textAlign = "center";
    for (const b of r.rupturas) {
      if (!ver(b.nivel)) continue;
      const x0 = this.x(b.t0), x1 = this.x(b.t1), y = this.y(b.precio);
      if (x0 === null || x1 === null || y === null || x1 < 0 || x0 > w) continue;
      const swing = b.nivel === "swing";
      const color = conAlfa(b.alc ? C.sube : C.baja, swing ? 0.95 : 0.75);
      ctx.strokeStyle = color;
      ctx.lineWidth = swing ? 1.2 : 1;
      ctx.setLineDash(swing ? [] : [3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `${swing ? 600 : 500} ${swing ? 10 : 9}px ${FONT}`;
      ctx.textBaseline = b.alc ? "bottom" : "top";
      ctx.fillText(b.tipo, (x0 + x1) / 2, b.alc ? y - 2 : y + 2);
    }
    if (this.zonas.estrSwing) {
      ctx.font = `600 9px ${FONT}`;
      for (const g of r.giros) {
        if (g.nivel !== "swing" || g.tipo.length < 2) continue;
        const x = this.x(g.t), y = this.y(g.p);
        if (x === null || y === null || x < 0 || x > w) continue;
        ctx.fillStyle = conAlfa(C.tenue, 0.9);
        ctx.textBaseline = g.alto ? "bottom" : "top";
        ctx.fillText(g.tipo, x, g.alto ? y - 4 : y + 4);
      }
      // El maximo y el minimo del tramo swing, hasta el borde.
      ctx.textAlign = "right";
      for (const [e, alto] of [[r.alto, true], [r.bajo, false]]) {
        if (!e) continue;
        const x = Math.max(0, this.x(e.t) ?? 0), y = this.y(e.p);
        if (y === null || x >= w) continue;
        const color = conAlfa(alto ? C.baja : C.sube, e.fuerte ? 0.9 : 0.6);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(e.fuerte ? [] : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = `600 9.5px ${FONT}`;
        ctx.textBaseline = alto ? "bottom" : "top";
        ctx.fillText(`${alto ? "Máx." : "Mín."} ${e.fuerte ? "fuerte" : "débil"}`, w - 6, alto ? y - 2 : y + 2);
      }
    }
    ctx.restore();
  }

  perfil(d) {
    const r = this.price.timeScale().getVisibleLogicalRange();
    const a = this.velas;
    if (!a.length) return;
    const from = r ? Math.max(0, Math.ceil(r.from)) : 0;
    const to = r ? Math.min(a.length - 1, Math.floor(r.to)) : a.length - 1;
    if (to < from) return;
    const visibles = a.slice(from, to + 1);
    const nFilas = this.vp.filas || FILAS_TV;
    const { ctx } = d;
    const ts = this.price.timeScale();
    const pintar = (prof, xAnchor, maxW, dir) => {
      for (const b of prof.bins) {
        if (b.total <= 0) continue;
        const ya = this.y(b.high), yb = this.y(b.low);
        if (ya === null || yb === null) continue;
        // Arriba y abajo en pantalla: con la escala invertida, el high de la fila queda abajo.
        const yTop = Math.min(ya, yb), yBot = Math.max(ya, yb);
        if (yBot < -20 || yTop > d.h + 20) continue;
        const alto = Math.max(1, yBot - yTop - 0.5);
        const ancho = (b.total / prof.maxBin) * maxW;
        const wc = ancho * (b.buy / b.total);
        const alpha = b.in_va ? 0.38 : 0.16;
        const xc = dir < 0 ? xAnchor - wc : xAnchor;
        ctx.fillStyle = `rgba(${C.vpCompra},${alpha})`;
        ctx.fillRect(xc, yTop, wc, alto);
        ctx.fillStyle = `rgba(${C.vpVenta},${alpha})`;
        ctx.fillRect(dir < 0 ? xc - (ancho - wc) : xc + wc, yTop, ancho - wc, alto);
      }
    };
    // Primero los de cada sesion (detras) y despues el del rango visible, a la derecha.
    if (this.vp.vpsv) {
      for (const s of perfilSesiones(this.interval, visibles, from, nFilas)) {
        const xL = ts.logicalToCoordinate(s.from), xR = ts.logicalToCoordinate(s.to);
        if (xL === null || xR === null || xR < -40 || xL > d.w + 40) continue;
        const wS = Math.max(8, xR - xL);
        pintar(s.prof, xL, wS * 0.9, 1);
        const yP = this.y(s.prof.poc);
        if (yP === null) continue;
        ctx.strokeStyle = C.poc;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xL, Math.round(yP) + 0.5);
        ctx.lineTo(xL + wS, Math.round(yP) + 0.5);
        ctx.stroke();
        if (!this.vp.extPoc) continue;
        // POC extendido: sigue a la derecha hasta la primera vela que lo toca. Si
        // ninguna lo toco (POC virgen), llega al borde con su precio en el eje.
        let hasta = null;
        for (let i = s.to + 1; i < a.length; i++) {
          if (a[i].low <= s.prof.poc && a[i].high >= s.prof.poc) { hasta = i; break; }
        }
        const xFin = hasta === null ? d.w : ts.logicalToCoordinate(hasta);
        if (xFin === null || xFin <= xL + wS) continue;
        const y0 = Math.round(yP) + 0.5;
        ctx.save();
        ctx.setLineDash(hasta === null ? [] : [4, 3]);
        ctx.globalAlpha = hasta === null ? 0.95 : 0.6;
        ctx.beginPath();
        ctx.moveTo(xL + wS, y0);
        ctx.lineTo(Math.min(d.w, xFin), y0);
        ctx.stroke();
        ctx.restore();
        if (hasta === null) this.marcaEje(d, yP, C.poc, this.fmt(s.prof.poc));
      }
    }
    if (this.vp.vpvr) {
      const prof = perfilRango(visibles, nFilas);
      if (!prof) return;
      pintar(prof, d.w - 2, this.anchoVpvr(d.w), -1);
      // El POC cruza todo el grafico: se ve contra que velas reacciona el precio.
      this.nivel(d, prof.poc, C.poc, "POC", { desde: 0, ancho: 1.5 });
    }
  }
}
