/* Dibujos sobre el grafico, como en TradingView:
   - lineas: de tendencia, horizontal, rayo, extendida, vertical, rayo horizontal,
     cruzada y de informacion (la diferencia de precio, el % y las velas);
   - Fibonacci: el retroceso, con sus niveles;
   - formas: el recuadro con su linea central;
   - mediciones: el rango de precio y fecha;
   - texto.
   Cada punto se guarda en tiempo y precio, asi que el dibujo queda en su lugar al
   cambiar de temporalidad o de zoom. Ademas el borrador (un click sobre un dibujo lo
   borra), seguir dibujando (la herramienta queda despues de cada dibujo) y ocultar
   todos los dibujos.

   Como en TradingView:
   - se dibujan, se editan y se ven solo dentro del area de las velas: nada de un
     dibujo pasa a los ejes, que quedan libres para mover y escalar el grafico;
   - van debajo de las operaciones: las posiciones siempre se ven, y sus lineas
     se toman antes que un dibujo;
   - con el cursor, un click en cualquier parte de un dibujo (la linea, su
     etiqueta, el interior de un recuadro) lo selecciona (aparecen sus manijas y
     la barra de estilo); arrastrandolo se mueve entero y arrastrando una manija
     se mueve ese punto. Un lado del recuadro lo estira solo hacia ese lado, y una
     esquina, hacia los dos;
   - Supr o Backspace borra el seleccionado; Escape lo suelta; un click en un
     lugar vacio tambien;
   - bloqueado (uno, desde su barra de estilo, o todos, desde la barra de dibujo)
     no se mueve, no se estira ni se borra, y arrastrando sobre el se mueve el
     grafico. Un click sin arrastrar lo selecciona, para desbloquearlo.

   Con la linea, Shift la deja horizontal: el segundo punto (o el extremo que se
   arrastra) toma el precio del otro, hasta donde llegue el puntero.

   Iman fuerte: cada punto que se marca (o una manija que se arrastra) se pega al
   precio de apertura, maximo, minimo o cierre mas cercano de la vela bajo el
   puntero. Se apaga con el boton del iman. */

import { fmtNum } from "../lib/format.js";
import { C } from "../lib/constants.js";

/** Las herramientas: cuantos puntos se marcan, si son lineas (Shift las deja
 *  horizontales) y si el interior cuenta para tomarlas (caja). */
export const TIPOS = {
  hline: { puntos: 1 }, vline: { puntos: 1 }, cruz: { puntos: 1 }, rayoH: { puntos: 1 }, texto: { puntos: 1 },
  linea: { puntos: 2, linea: true }, rayo: { puntos: 2, linea: true }, extendida: { puntos: 2, linea: true }, info: { puntos: 2, linea: true },
  fib: { puntos: 2, caja: true }, rect: { puntos: 2, caja: true }, medir: { puntos: 2, caja: true },
};
export const COLORES = {
  hline: "#C4A574", vline: "#C4A574", cruz: "#C4A574", rayoH: "#C4A574", texto: "#E8EAED",
  linea: "#5B8DEF", rayo: "#5B8DEF", extendida: "#5B8DEF", info: "#5B8DEF", fib: "#C4A574", rect: "#8B7BB8", medir: "#5B8DEF",
};
// Los niveles del retroceso de Fibonacci (0 en el segundo punto, 1 en el primero).
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLOR = ["#A1A1A1", "#F23645", "#E0A84A", "#22AB94", "#5B8DEF", "#8B7BB8", "#A1A1A1"];
export const PALETA = ["#C4A574", "#5B8DEF", "#8B7BB8", "#26A69A", "#EF5350", "#E8EAED"];
// Dibujos guardados con paletas anteriores (arena o TV oscuro).
const PALETA_VIEJA = {
  "#f2c94c": "#C4A574", "#5aa9ff": "#5B8DEF", "#a98bff": "#8B7BB8", "#22b07d": "#26A69A", "#e5534b": "#EF5350", "#e7eaf0": "#E8EAED",
  "#B5651D": "#C4A574", "#2E529C": "#5B8DEF", "#6E5A8C": "#8B7BB8", "#089981": "#26A69A", "#C8473B": "#EF5350", "#16181D": "#E8EAED",
};
const ANCHO = 1.8;
const FONT = 'Geist, Inter, "Segoe UI", system-ui, sans-serif';
const TOCA = 6;        // pixeles alrededor de una linea que cuentan como encima
const MANIJA = 9;      // radio para tomar una manija
export const IZQ_LIBRE = 52;   // lo que tapa la barra de dibujo flotante (celular): ahi no empieza ninguna etiqueta

const nuevoId = () => Math.random().toString(36).slice(2, 10);
const copia = (x) => JSON.parse(JSON.stringify(x));

/** Distancia de un punto a un segmento, en pixeles. */
function distSeg(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(x - (a.x + u * dx), y - (a.y + u * dy));
}

export class Dibujos {
  constructor(engine, el, cb = {}) {
    this.e = engine;
    this.el = el;
    this.cb = cb;                  // onCambio(lista), onHerramienta(h), onSeleccion(dibujo | null)
    this.lista = [];
    this.herramienta = "cursor";
    this.iman = true;
    this.enCurso = null;           // { tipo, p1, p2 } mientras se marca el segundo punto
    this.arrastre = null;          // { d, que, t, p, inicio, original, movido }
    this.hover = null;             // el punto (con iman) bajo el puntero, al dibujar
    this.encima = null;            // el dibujo bajo el puntero, con el cursor
    this.sel = null;               // id del dibujo seleccionado
    this.etiquetas = new Map();    // id de una linea horizontal -> la caja de su etiqueta
    this.bloqueo = false;          // todos bloqueados (boton de la barra de dibujo)
    this.clic = null;              // donde empezo un click sobre el grafico (para un bloqueado)
    this.seguir = false;           // seguir dibujando: la herramienta queda despues de cada dibujo
    this.ocultos = false;          // todos los dibujos ocultos
    const on = (blanco, tipo, fn) => {
      blanco.addEventListener(tipo, fn);
      engine.disposers.push(() => blanco.removeEventListener(tipo, fn));
    };
    on(el, "pointerdown", (ev) => this.down(ev));
    on(el, "pointermove", (ev) => this.move(ev));
    on(el, "pointerup", (ev) => this.up(ev));
    on(el, "pointercancel", () => this.up());
    on(el, "pointerleave", () => { if (!this.arrastre) { this.hover = null; this.marcar(null); this.e.sinCruz(); this.e.agendarDibujo(); } });
    on(el, "contextmenu", (ev) => { if (this.herramienta !== "cursor") { ev.preventDefault(); this.cancelar(); } });
    // Shift apretado o soltado sin mover el mouse: la linea a medio marcar se acomoda igual.
    const conShift = (ev) => {
      if (ev.key !== "Shift" || !this.puntero || !(this.enCurso || this.arrastre)) return;
      this.move({ ...this.puntero, shiftKey: ev.type === "keydown" });
    };
    on(window, "keydown", conShift);
    on(window, "keyup", conShift);
    // Con el cursor la capa no toma el puntero: lo mira desde el grafico, y lo toma
    // solo si pasa sobre un dibujo. Un click en un lugar vacio suelta la seleccion.
    on(engine.els.price, "pointermove", (ev) => this.cercania(ev));
    on(engine.els.price, "pointerdown", (ev) => {
      if (this.herramienta !== "cursor") return;
      this.clic = ev.button === 0 ? this.xy(ev) : null;
      if (this.sel) this.seleccionar(null);
    });
    // Un dibujo bloqueado no toma el puntero (arrastrando sobre el se mueve el
    // grafico): un click sin arrastrar lo selecciona, para cambiarlo o desbloquearlo.
    on(engine.els.price, "pointerup", (ev) => {
      const c = this.clic;
      this.clic = null;
      if (!c || this.herramienta !== "cursor") return;
      const { x, y } = this.xy(ev);
      if (Math.hypot(x - c.x, y - c.y) > 4 || !this.dentro(x, y) || this.e.lineasOrden?.cerca(x, y)) return;
      const h = this.tocar(x, y, true);
      if (h) this.seleccionar(h.d.id);
    });
  }

  set(lista) {
    this.lista = Array.isArray(lista) ? lista : [];
    this.enCurso = null;
    this.seleccionar(null);
    this.e.agendarDibujo();
  }

  setHerramienta(h) {
    if (h === this.herramienta) return;
    this.herramienta = h;
    this.enCurso = null;
    this.arrastre = null;
    if (h !== "cursor") this.seleccionar(null);
    this.el.classList.toggle("activa", h !== "cursor");
    this.el.dataset.herramienta = h;
    this.marcar(null);
    this.cb.onHerramienta?.(h);
    this.e.agendarDibujo();
  }

  setIman(v) {
    this.iman = Boolean(v);
  }

  setSeguir(v) {
    this.seguir = Boolean(v);
  }

  /** Ocultos: no se ven ni se toman (siguen guardados). */
  setOcultos(v) {
    this.ocultos = Boolean(v);
    if (this.ocultos) this.seleccionar(null);
    this.marcar(null);
    this.e.agendarDibujo();
  }

  /** Todos los dibujos bloqueados (boton de la barra de dibujo). */
  setBloqueo(v) {
    this.bloqueo = Boolean(v);
    this.arrastre = null;
    this.marcar(null);
    this.e.agendarDibujo();
  }

  /** Si un dibujo esta bloqueado (el solo, o todos). */
  fijo(d) {
    return this.bloqueo || Boolean(d?.bloqueado);
  }

  /** Escape: primero el dibujo a medio marcar, despues la seleccion, despues la herramienta. */
  cancelar() {
    if (this.enCurso) { this.enCurso = null; this.e.agendarDibujo(); return; }
    if (this.sel) { this.seleccionar(null); return; }
    this.setHerramienta("cursor");
  }

  /** Borra los dibujos de este mercado, menos los bloqueados. */
  borrarTodo() {
    if (this.bloqueo) return;
    this.lista = this.lista.filter((d) => d.bloqueado);
    this.seleccionar(null);
    this.guardar();
  }

  guardar() {
    this.cb.onCambio?.(this.lista);
    this.e.agendarDibujo();
  }

  // -------------------------------------------------------------- seleccion

  seleccionado() {
    return this.lista.find((d) => d.id === this.sel) ?? null;
  }

  seleccionar(id) {
    if (id === this.sel) return;
    this.sel = id;
    this.cb.onSeleccion?.(this.seleccionado());
    this.e.agendarDibujo();
  }

  /** Color, grosor o bloqueo del seleccionado (desde la barra de estilo). */
  setEstilo(cambio) {
    const d = this.seleccionado();
    if (!d) return;
    Object.assign(d, cambio);
    // Recien bloqueado: la capa suelta el puntero, para que el grafico se pueda mover.
    if (this.fijo(d)) this.marcar(null);
    this.cb.onSeleccion?.(d);
    this.guardar();
  }

  /** Un bloqueado no se borra. */
  borrarSeleccion() {
    if (!this.sel || this.fijo(this.seleccionado())) return false;
    this.lista = this.lista.filter((d) => d.id !== this.sel);
    this.seleccionar(null);
    this.guardar();
    return true;
  }

  /** Una copia del seleccionado, corrida un poco hacia abajo y a la derecha. */
  duplicar() {
    const d = this.seleccionado();
    if (!d || !this.e.velas.length) return;
    const desv = (pt) => pt && { t: d.tipo === "hline" || d.tipo === "rayoH" ? pt.t : this.tiempo(this.e.indice(pt.t) + 3), p: pt.p };
    // La copia nace desbloqueada, para poder acomodarla.
    const n = { ...copia(d), id: nuevoId(), p1: desv(d.p1), ...(d.p2 ? { p2: desv(d.p2) } : {}) };
    delete n.bloqueado;
    // El precio corrido un 1 % del rango visible, para que no quede encima.
    const y = this.e.y(n.p1.p);
    const corrido = y === null ? null : this.e.s.velas.coordinateToPrice(y + 18);
    if (corrido !== null) {
      const dp = corrido - n.p1.p;
      n.p1.p += dp;
      if (n.p2) n.p2.p += dp;
    }
    this.lista.push(n);
    this.guardar();
    this.seleccionar(n.id);
  }

  // ------------------------------------------------------------- coordenadas

  xy(ev) {
    const r = this.el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** Si (x, y) cae dentro del area de las velas (no sobre los ejes). */
  dentro(x, y) {
    const ts = this.e.price.timeScale();
    const w = ts.width(), h = this.e.altoPrecio();
    return x >= 0 && y >= 0 && x <= w && y <= h;
  }

  /** Tiempo de una posicion logica del eje (tambien entre velas o fuera de ellas). */
  tiempo(lg) {
    const a = this.e.velas, n = a.length, paso = this.e.paso();
    if (lg <= 0) return a[0].time + lg * paso;
    if (lg >= n - 1) return a[n - 1].time + (lg - (n - 1)) * paso;
    const i = Math.floor(lg), f = lg - i;
    return a[i].time + (a[i + 1].time - a[i].time) * f;
  }

  /** Pixel -> tiempo y precio. Con iman, el OHLC mas cercano de la vela bajo el puntero. */
  aDatos(x, y, conIman = this.iman) {
    const e = this.e, a = e.velas;
    if (!a.length) return null;
    const lg = e.price.timeScale().coordinateToLogical(x);
    if (lg === null || lg === undefined) return null;
    const i = Math.round(lg);
    if (conIman && i >= 0 && i < a.length) {
      const v = a[i];
      let mejor = null, dist = Infinity;
      for (const p of [v.open, v.high, v.low, v.close]) {
        const yy = e.y(p);
        if (yy !== null && Math.abs(yy - y) < dist) { dist = Math.abs(yy - y); mejor = p; }
      }
      if (mejor !== null) return { t: v.time, p: mejor, iman: true };
    }
    const p = e.s.velas.coordinateToPrice(y);
    return p === null ? null : { t: this.tiempo(lg), p };
  }

  pixel(pt) {
    return pt ? { x: this.e.x(pt.t), y: this.e.y(pt.p) } : { x: null, y: null };
  }

  /** Un recuadro en pixeles (x0 < x1, y0 < y1), o null si no se ve. */
  caja(d) {
    const a = this.pixel(d.p1), b = this.pixel(d.p2);
    if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
  }

  /** El tramo que se ve de una linea, en pixeles: el rayo sigue mas alla del segundo
   *  punto, la extendida hacia los dos lados, el rayo horizontal hasta el borde. */
  tramo(d) {
    const a = this.pixel(d.p1);
    if (a.x === null || a.y === null) return null;
    const w = this.e.price.timeScale().width();
    if (d.tipo === "rayoH") return [a, { x: w + 40, y: a.y }];
    const b = this.pixel(d.p2);
    if (b.x === null || b.y === null) return null;
    const dx = b.x - a.x, dy = b.y - a.y, largo = Math.hypot(dx, dy) || 1;
    const lejos = (o, signo) => ({ x: o.x + (signo * dx / largo) * w * 4, y: o.y + (signo * dy / largo) * w * 4 });
    if (d.tipo === "rayo") return [a, lejos(b, 1)];
    if (d.tipo === "extendida") return [lejos(a, -1), lejos(b, 1)];
    return [a, b];
  }

  /** Las manijas de un dibujo: de que punto toma el tiempo y de cual el precio (null:
   *  ese no cambia). Los de caja tienen las cuatro esquinas y la mitad de cada lado. */
  manijas(d) {
    if (TIPOS[d.tipo]?.puntos === 1) return [];
    const a = this.pixel(d.p1), b = this.pixel(d.p2);
    if (a.x === null || a.y === null || b.x === null || b.y === null) return [];
    const m = [{ t: "p1", p: "p1", x: a.x, y: a.y }, { t: "p2", p: "p2", x: b.x, y: b.y }];
    if (!TIPOS[d.tipo]?.caja) return m.map((k) => ({ ...k, cursor: "crosshair" }));
    const xm = (a.x + b.x) / 2, ym = (a.y + b.y) / 2;
    m.push({ t: "p1", p: "p2", x: a.x, y: b.y }, { t: "p2", p: "p1", x: b.x, y: a.y },
      { t: "p1", p: null, x: a.x, y: ym }, { t: "p2", p: null, x: b.x, y: ym },
      { t: null, p: "p1", x: xm, y: a.y }, { t: null, p: "p2", x: xm, y: b.y });
    // Esquina de arriba a la izquierda o de abajo a la derecha: en diagonal hacia alla.
    return m.map((k) => ({
      ...k,
      cursor: !k.p ? "ew-resize" : !k.t ? "ns-resize" : (k.x <= xm) === (k.y <= ym) ? "nwse-resize" : "nesw-resize",
    }));
  }

  /** Lo fino de un dibujo bajo el puntero: una manija, la linea (con su etiqueta) o
   *  un lado del recuadro. */
  tocarBorde(d, x, y) {
    const a = this.pixel(d.p1), b = this.pixel(d.p2);
    if (a.y === null) return null;
    const c = this.etiquetas.get(d.id);
    const enEtiqueta = c && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
    if (d.tipo === "hline") {
      return Math.abs(y - a.y) <= TOCA || enEtiqueta ? { d, que: "todo", cursor: "ns-resize" } : null;
    }
    if (d.tipo === "texto") return enEtiqueta ? { d, que: "todo", cursor: "move" } : null;
    if (a.x === null) return null;
    if (d.tipo === "vline") return Math.abs(x - a.x) <= TOCA ? { d, que: "todo", cursor: "ew-resize" } : null;
    if (d.tipo === "cruz") return Math.abs(x - a.x) <= TOCA || Math.abs(y - a.y) <= TOCA || enEtiqueta ? { d, que: "todo", cursor: "move" } : null;
    if (d.tipo === "rayoH") {
      const t = this.tramo(d);
      return t && distSeg(x, y, t[0], t[1]) <= TOCA ? { d, que: "todo", cursor: "move" } : null;
    }
    if (b.x === null || b.y === null) return null;
    // En un recuadro chico las manijas y los lados toman menos hacia adentro, para
    // que quede donde tomarlo entero.
    const r = TIPOS[d.tipo]?.caja ? this.caja(d) : null;
    const radio = r ? Math.min(MANIJA, Math.max(4, Math.min(r.x1 - r.x0, r.y1 - r.y0) / 3)) : MANIJA;
    for (const m of this.manijas(d)) {
      if (Math.hypot(x - m.x, y - m.y) <= radio) return { d, que: "punto", t: m.t, p: m.p, cursor: m.cursor };
    }
    if (!r) {
      const t = this.tramo(d);
      return (t && distSeg(x, y, t[0], t[1]) <= TOCA) || enEtiqueta ? { d, que: "todo", cursor: "move" } : null;
    }
    // Un lado del recuadro (en cualquier parte) lo estira solo hacia ese lado.
    const adentroX = Math.min(TOCA, (r.x1 - r.x0) / 4), adentroY = Math.min(TOCA, (r.y1 - r.y0) / 4);
    const izq = a.x <= b.x ? "p1" : "p2", arriba = a.y <= b.y ? "p1" : "p2";
    const otro = (k) => (k === "p1" ? "p2" : "p1");
    const enY = y >= r.y0 - TOCA && y <= r.y1 + TOCA, enX = x >= r.x0 - TOCA && x <= r.x1 + TOCA;
    const t = !enY ? null
      : x >= r.x0 - TOCA && x <= r.x0 + adentroX ? izq
      : x >= r.x1 - adentroX && x <= r.x1 + TOCA ? otro(izq) : null;
    const p = !enX ? null
      : y >= r.y0 - TOCA && y <= r.y0 + adentroY ? arriba
      : y >= r.y1 - adentroY && y <= r.y1 + TOCA ? otro(arriba) : null;
    if (!t && !p) return null;
    const cursor = !p ? "ew-resize" : !t ? "ns-resize" : (t === izq) === (p === arriba) ? "nwse-resize" : "nesw-resize";
    return { d, que: "punto", t, p, cursor };
  }

  /** El dibujo (y que parte) que esta bajo el puntero. Primero lo fino (manijas,
   *  lineas y lados), del seleccionado y despues del de arriba hacia abajo; si no,
   *  el interior de un recuadro: el mas chico que lo tenga, asi tambien se llega a
   *  uno que esta dentro de otro. Los bloqueados, solo `conFijos`. */
  tocar(x, y, conFijos = false) {
    if (this.ocultos) return null;
    const orden = [...this.lista].reverse().filter((d) => conFijos || !this.fijo(d));
    const s = this.seleccionado();
    if (s && (conFijos || !this.fijo(s))) orden.unshift(s);
    for (const d of orden) {
      const h = this.tocarBorde(d, x, y);
      if (h) return h;
    }
    let mejor = null, area = Infinity;
    for (const d of orden) {
      const r = TIPOS[d.tipo]?.caja ? this.caja(d) : null;
      if (!r || x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      const a = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (a < area) { area = a; mejor = d; }
    }
    return mejor ? { d: mejor, que: "todo", cursor: "move" } : null;
  }

  /** Si el puntero paso a otro dibujo o a otra parte del mismo. */
  cambio(h) {
    const e = this.encima;
    return (h?.d.id ?? null) !== (e?.d.id ?? null) || h?.que !== e?.que || h?.t !== e?.t || h?.p !== e?.p;
  }

  /** La capa toma el puntero (para tomar un dibujo) o lo deja pasar al grafico. */
  marcar(h) {
    this.encima = h;
    const agarra = Boolean(h);
    this.el.classList.toggle("agarra", agarra);
    if (this.herramienta === "cursor") this.el.style.cursor = h?.cursor ?? "";
  }

  /** Puntero sobre el grafico con el cursor: si pasa sobre un dibujo, la capa lo toma.
   *  Las lineas de las operaciones (SL, TP) tienen prioridad. */
  cercania(ev) {
    if (this.herramienta !== "cursor" || this.arrastre) return;
    const { x, y } = this.xy(ev);
    const lo = this.e.lineasOrden;
    if (!this.dentro(x, y) || lo?.arrastre || lo?.pendiente || lo?.cerca(x, y)) { if (this.encima) this.marcar(null); return; }
    const h = this.tocar(x, y);
    if (this.cambio(h)) {
      this.marcar(h);
      this.e.agendarDibujo();
    }
  }

  // ----------------------------------------------------------------- puntero

  down(ev) {
    if (ev.button !== 0) return;
    const { x, y } = this.xy(ev);
    if (this.herramienta === "cursor") {
      // Sobre la linea de una operacion manda la operacion, aunque haya un dibujo.
      const h = this.e.lineasOrden?.cerca(x, y) ? null : this.tocar(x, y);
      if (!h) { this.marcar(null); this.seleccionar(null); return; }
      ev.preventDefault();
      ev.stopPropagation();
      this.seleccionar(h.d.id);
      this.arrastre = { ...h, inicio: this.aDatos(x, y, false), original: copia(h.d), movido: false };
      this.el.setPointerCapture?.(ev.pointerId);
      return;
    }
    if (!this.dentro(x, y)) return;
    ev.preventDefault();
    // El borrador: un click sobre un dibujo (no bloqueado) lo borra.
    if (this.herramienta === "borrador") {
      const h = this.tocar(x, y);
      if (h) {
        this.lista = this.lista.filter((d) => d.id !== h.d.id);
        this.marcar(null);
        this.guardar();
      }
      return;
    }
    const pt = this.aDatos(x, y);
    if (!pt) return;
    const tipo = this.herramienta;
    if (TIPOS[tipo]?.puntos === 1) {
      const n = { id: nuevoId(), tipo, p1: { t: pt.t, p: pt.p } };
      if (tipo === "texto") {
        const texto = window.prompt("Texto");
        if (!texto?.trim()) return;
        n.texto = texto.trim();
      }
      this.agregar(n);
      return;
    }
    if (!this.enCurso) {
      this.enCurso = { tipo, p1: { t: pt.t, p: pt.p }, p2: { t: pt.t, p: pt.p } };
    } else {
      const fin = TIPOS[this.enCurso.tipo]?.linea ? this.horizontal(pt, this.enCurso.p1, ev.shiftKey) : pt;
      this.enCurso.p2 = { t: fin.t, p: fin.p };
      const n = { id: nuevoId(), ...this.enCurso };
      this.enCurso = null;
      this.agregar(n);
    }
    this.e.agendarDibujo();
  }

  /** Un dibujo terminado: se guarda y queda elegido (o, seguir dibujando, la herramienta sigue). */
  agregar(n) {
    this.lista.push(n);
    this.guardar();
    if (this.seguir) return;
    this.setHerramienta("cursor");
    this.seleccionar(n.id);
  }

  /** Con Shift, la linea queda horizontal: el punto toma el precio del otro extremo. */
  horizontal(pt, otro, shift) {
    return shift && otro ? { ...pt, p: otro.p, iman: false } : pt;
  }

  move(ev) {
    const { x, y } = this.xy(ev);
    this.puntero = { clientX: ev.clientX, clientY: ev.clientY };
    // La capa tiene el puntero (y el grafico no): la cruz lo sigue igual.
    this.e.cruzEn(x, y);
    const a = this.arrastre;
    if (a) {
      // Dentro del area de las velas: el puntero puede salir, el punto no.
      const ts = this.e.price.timeScale();
      const cx = Math.max(0, Math.min(ts.width(), x));
      const cy = Math.max(0, Math.min(this.e.altoPrecio(), y));
      if (a.que === "todo") {
        const pt = this.aDatos(cx, cy, false);
        if (!pt || !a.inicio) return;
        const di = a.d.tipo === "hline" ? 0 : this.e.indice(pt.t) - this.e.indice(a.inicio.t);
        const dp = a.d.tipo === "vline" ? 0 : pt.p - a.inicio.p;
        const mover = (p) => ({ t: this.tiempo(this.e.indice(p.t) + di), p: p.p + dp });
        a.d.p1 = mover(a.original.p1);
        if (a.original.p2) a.d.p2 = mover(a.original.p2);
      } else {
        // Una esquina mueve el tiempo y el precio; un lado del recuadro, uno solo.
        let pt = this.aDatos(cx, cy);
        if (!pt) return;
        if (TIPOS[a.d.tipo]?.linea) pt = this.horizontal(pt, a.d[a.t === "p1" ? "p2" : "p1"], ev.shiftKey);
        if (a.t) a.d[a.t] = { ...a.d[a.t], t: pt.t };
        if (a.p) a.d[a.p] = { ...a.d[a.p], p: pt.p };
      }
      a.movido = true;
      this.e.agendarDibujo();
      return;
    }
    if (this.herramienta === "cursor") {
      // La capa tiene el puntero porque estaba sobre un dibujo: si ya no (o llego a la
      // linea de una operacion, que va primero), lo suelta.
      const h = this.dentro(x, y) && !this.e.lineasOrden?.cerca(x, y) ? this.tocar(x, y) : null;
      if (this.cambio(h)) { this.marcar(h); this.e.agendarDibujo(); }
      return;
    }
    if (!this.dentro(x, y)) { this.hover = null; this.el.style.cursor = "default"; this.e.agendarDibujo(); return; }
    if (this.herramienta === "borrador") {
      const h = this.tocar(x, y);
      this.el.style.cursor = h ? "pointer" : "default";
      this.hover = null;
      if (this.cambio(h)) { this.marcar(h); this.e.agendarDibujo(); }
      return;
    }
    this.el.style.cursor = "crosshair";
    this.hover = this.aDatos(x, y);
    if (TIPOS[this.enCurso?.tipo]?.linea && this.hover) this.hover = this.horizontal(this.hover, this.enCurso.p1, ev.shiftKey);
    if (this.enCurso && this.hover) this.enCurso.p2 = { t: this.hover.t, p: this.hover.p };
    this.e.agendarDibujo();
  }

  up() {
    const a = this.arrastre;
    if (!a) return;
    this.arrastre = null;
    if (a.movido) this.guardar();
    this.cb.onSeleccion?.(this.seleccionado());
  }

  // ------------------------------------------------------------------ dibujo

  dibujar(d) {
    // La capa cubre solo el area de las velas: los ejes quedan para el grafico.
    const ts = this.e.price.timeScale();
    this.el.style.right = `${Math.max(0, d.eje ?? 0)}px`;
    // Solo el panel de las velas (el de abajo y el eje de tiempo quedan fuera).
    this.el.style.bottom = `${Math.max(0, this.e.els.price.parentElement.clientHeight - this.e.altoPrecio())}px`;
    const todos = this.ocultos ? [] : this.enCurso ? [...this.lista, { ...this.enCurso, borrador: true }] : this.lista;
    // Recortados al area de las velas: nada de un dibujo pasa a los ejes.
    const { ctx } = d;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, d.w, d.h);
    ctx.clip();
    for (const x of todos) this.uno(d, x);
    ctx.restore();
  }

  /** El punto donde se va a pegar el que se marca (con el iman, sobre la vela). Va
   *  arriba de todo, tambien de las operaciones. */
  dibujarPuntero(d) {
    if (!this.hover || this.herramienta === "cursor" || this.herramienta === "borrador") return;
    const p = this.pixel(this.hover);
    if (p.x === null || p.y === null) return;
    const { ctx } = d;
    ctx.save();
    ctx.strokeStyle = this.hover.iman ? C.acento : C.texto;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.hover.iman ? 5 : 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  uno(d, x) {
    const { ctx } = d;
    const col = PALETA_VIEJA[x.color] ?? x.color ?? COLORES[x.tipo] ?? "#16181D";
    const sel = x.id && x.id === this.sel;
    const encima = this.encima?.d === x;
    const borrando = encima && this.herramienta === "borrador";
    const ancho = (x.ancho ?? (x.tipo === "hline" ? 1.6 : ANCHO)) + (encima && !sel ? 0.6 : 0);
    const a = this.pixel(x.p1), b = this.pixel(x.p2);
    if (a.y === null) return;
    ctx.save();
    ctx.globalAlpha = x.borrador ? 0.75 : borrando ? 0.45 : 1;
    if (x.tipo === "texto") {
      if (a.x === null) { ctx.restore(); return; }
      ctx.font = `500 ${Math.round(11 + (x.ancho ?? 2) * 1.5)}px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const tw = ctx.measureText(x.texto ?? "").width, alto = 18 + (x.ancho ?? 2) * 2;
      if (x.id) this.etiquetas.set(x.id, { x: a.x - 4, y: a.y - alto / 2, w: tw + 8, h: alto });
      if (sel || encima) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.6;
        ctx.strokeRect(Math.round(a.x - 4) + 0.5, Math.round(a.y - alto / 2) + 0.5, Math.round(tw + 8), Math.round(alto));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col;
      ctx.fillText(x.texto ?? "", a.x, a.y);
      ctx.restore();
      return;
    }
    if (x.tipo === "vline" || x.tipo === "cruz") {
      if (a.x === null) { ctx.restore(); return; }
      ctx.strokeStyle = col;
      ctx.lineWidth = ancho;
      ctx.beginPath();
      ctx.moveTo(Math.round(a.x) + 0.5, 0);
      ctx.lineTo(Math.round(a.x) + 0.5, d.h);
      ctx.stroke();
      if (x.tipo === "cruz") {
        if (x.id) this.etiquetas.set(x.id, this.e.nivel(d, x.p1.p, col, "Cruz", { ancho }));
        else this.e.nivel(d, x.p1.p, col, "Cruz", { ancho });
      }
      if (sel && !this.fijo(x)) this.manija(ctx, { x: a.x, y: x.tipo === "cruz" ? a.y : d.h / 2 }, col);
      ctx.restore();
      return;
    }
    if (x.tipo === "hline") {
      // El precio va en la etiqueta, dentro del grafico: el eje queda libre.
      if (x.id) this.etiquetas.set(x.id, this.e.nivel(d, x.p1.p, col, "Línea", { ancho }));
      else this.e.nivel(d, x.p1.p, col, "Línea", { ancho });
      if (sel && !this.fijo(x)) {
        const cx = d.w / 2;
        this.manija(ctx, { x: cx, y: a.y }, col);
      }
      ctx.restore();
      return;
    }
    if (x.tipo === "rayoH") {
      if (a.x === null) { ctx.restore(); return; }
      ctx.strokeStyle = col;
      ctx.lineWidth = ancho;
      ctx.beginPath();
      ctx.moveTo(a.x, Math.round(a.y) + 0.5);
      ctx.lineTo(d.w, Math.round(a.y) + 0.5);
      ctx.stroke();
      this.texto(ctx, this.e.fmt(x.p1.p), a.x + 6, a.y - 4, col, "left", "bottom");
      if (sel && !this.fijo(x)) this.manija(ctx, a, col);
      ctx.restore();
      return;
    }
    if (a.x === null || b.x === null || b.y === null) { ctx.restore(); return; }
    ctx.strokeStyle = col;
    ctx.lineWidth = ancho;
    if (TIPOS[x.tipo]?.linea) {
      const [p, q] = this.tramo(x) ?? [a, b];
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      // La de informacion: lo que se movio el precio, el % y cuantas velas, en el segundo punto.
      if (x.tipo === "info") {
        const caja = this.pildora(ctx, [this.diferencia(x), this.duracion(x)], b.x + 8, b.y, col, d);
        if (x.id && caja) this.etiquetas.set(x.id, caja);
      }
    } else if (x.tipo === "fib") {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = x.borrador ? 0.75 : 1;
      const precio = (n) => x.p2.p + (x.p1.p - x.p2.p) * n;
      let antes = null;
      FIB.forEach((n, i) => {
        const y = this.e.y(precio(n));
        if (y === null) return;
        if (antes !== null) {
          ctx.fillStyle = FIB_COLOR[i];
          ctx.globalAlpha = 0.07;
          ctx.fillRect(x0, Math.min(antes, y), x1 - x0, Math.abs(y - antes));
          ctx.globalAlpha = x.borrador ? 0.75 : 1;
        }
        ctx.strokeStyle = FIB_COLOR[i];
        ctx.lineWidth = Math.max(1, ancho - 0.6);
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(x1, Math.round(y) + 0.5);
        ctx.stroke();
        this.texto(ctx, `${String(n).replace(".", ",")} (${this.e.fmt(precio(n))})`, Math.max(x0, this.e.izqLibre ?? IZQ_LIBRE) + 4, y - 2, FIB_COLOR[i], "left", "bottom");
        antes = y;
      });
    } else if (x.tipo === "medir") {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const sube = x.p2.p >= x.p1.p;
      const tono = sube ? C.sube : C.baja;
      ctx.fillStyle = tono;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = x.borrador ? 0.75 : 1;
      ctx.strokeStyle = tono;
      ctx.lineWidth = 1;
      // Las flechas: de un precio al otro y de una vela a la otra, por el medio.
      const xm = Math.round((x0 + x1) / 2) + 0.5, ym = Math.round((y0 + y1) / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xm, a.y); ctx.lineTo(xm, b.y);
      ctx.moveTo(a.x, ym); ctx.lineTo(b.x, ym);
      ctx.stroke();
      const punta = (px, py, dx, dy) => { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - dx * 6 - dy * 4, py - dy * 6 + dx * 4); ctx.lineTo(px - dx * 6 + dy * 4, py - dy * 6 - dx * 4); ctx.closePath(); ctx.fillStyle = tono; ctx.fill(); };
      punta(xm, b.y, 0, Math.sign(b.y - a.y) || 1);
      punta(b.x, ym, Math.sign(b.x - a.x) || 1, 0);
      const caja = this.pildora(ctx, [this.diferencia(x), this.duracion(x)], xm, (sube ? y0 : y1) + (sube ? -8 : 8), tono, d, true, sube ? "arriba" : "abajo");
      if (x.id && caja) this.etiquetas.set(x.id, caja);
    } else if (x.tipo === "rect") {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      ctx.fillStyle = col;
      ctx.globalAlpha = (x.borrador ? 0.75 : 1) * (sel ? 0.18 : 0.12);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = x.borrador ? 0.75 : 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
      // La linea central, con su precio.
      const medio = (x.p1.p + x.p2.p) / 2, ym = Math.round((y0 + y1) / 2) + 0.5;
      ctx.lineWidth = Math.max(1, ancho - 0.6);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, ym);
      ctx.lineTo(x1, ym);
      ctx.stroke();
      ctx.setLineDash([]);
      // El precio del medio, en lo que se ve del recuadro: a la derecha, o a la
      // izquierda si ahi ya hay otra etiqueta (las de las operaciones van primero).
      const inicio = Math.max(x0, this.e.izqLibre ?? IZQ_LIBRE), fin = Math.min(x1, d.w);
      if (fin - inicio > 60) {
        ctx.font = `600 10px ${FONT}`;
        const txt = `50 %  ${this.e.fmt(medio)}`, tw = ctx.measureText(txt).width;
        const libre = (xa) => (d.cajas ?? []).every((c) => c.x1 < xa || c.x0 > xa + tw || Math.abs(c.y - (ym - 9)) >= 15);
        const xa = libre(fin - 4 - tw) ? fin - 4 - tw : libre(inicio + 4) ? inicio + 4 : null;
        if (xa !== null) {
          d.cajas?.push({ x0: xa, x1: xa + tw, y: ym - 9 });
          ctx.fillStyle = col;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(txt, xa, ym - 3);
        }
      }
    }
    // Las manijas: todas en el seleccionado (si no esta bloqueado); mientras se
    // dibuja, solo las esquinas.
    if (x.borrador) for (const m of this.manijas(x)) { if (m.t && m.p) this.manija(ctx, m, col); }
    else if (sel && !this.fijo(x)) for (const m of this.manijas(x)) this.manija(ctx, m, col);
    ctx.restore();
  }

  /** Lo que se movio el precio de un punto al otro: +125,30 (+0,42 %). */
  diferencia(x) {
    const dp = x.p2.p - x.p1.p;
    const pct = x.p1.p ? (dp / x.p1.p) * 100 : 0;
    return `${dp >= 0 ? "+" : "−"}${this.e.fmt(Math.abs(dp))} (${dp >= 0 ? "+" : "−"}${fmtNum(Math.abs(pct), 2)} %)`;
  }

  /** Cuantas velas y cuanto tiempo hay de un punto al otro: 36 velas · 3 h. */
  duracion(x) {
    const s = Math.abs(x.p2.t - x.p1.t);
    const velas = Math.round(Math.abs(this.e.indice(x.p2.t) - this.e.indice(x.p1.t)));
    const dd = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.round((s % 3600) / 60);
    const t = dd ? `${dd} d${h ? ` ${h} h` : ""}` : h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
    return `${velas} ${velas === 1 ? "vela" : "velas"} · ${t}`;
  }

  /** Un texto chico sobre el grafico. */
  texto(ctx, txt, x, y, col, align, base) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = col;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  /** Una pildora con renglones (la de informacion y la de medir). Centrada en x si
   *  `centro`; arriba o abajo de y. Devuelve su caja (para tomar el dibujo). */
  pildora(ctx, renglones, x, y, col, d, centro = false, hacia = "medio") {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = `600 10.5px ${FONT}`;
    const w = Math.max(...renglones.map((r) => ctx.measureText(r).width)) + 14, h = renglones.length * 14 + 8;
    let x0 = centro ? x - w / 2 : x;
    x0 = Math.max(4, Math.min(d.w - w - 4, x0));
    const y0 = hacia === "arriba" ? y - h : hacia === "abajo" ? y : y - h / 2;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, 5);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    renglones.forEach((r, i) => ctx.fillText(r, x0 + w / 2, y0 + 5 + i * 14));
    ctx.restore();
    return { x: x0, y: y0, w, h };
  }

  manija(ctx, p, col) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.fondo;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
