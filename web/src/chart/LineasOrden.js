/* Arrastrar las lineas de las operaciones en el grafico, como en MT5:
   - el SL y el TP de una posicion se mueven a otro precio;
   - la entrada de una posicion, arrastrada hacia el lado de la perdida, pone (o
     mueve) el SL; hacia el de la ganancia, el TP;
   - en una orden pendiente se mueven su precio, su SL y su TP;
   - en la orden que se esta armando en Operar (el borrador), su precio limite, su SL
     y su TP: al soltar no se manda nada, solo se escribe en el formulario.
   Mientras se arrastra se ve el precio nuevo y cuanto representa; al soltar, la
   interfaz pide confirmacion antes de mandar nada.

   Las lineas no tapan el grafico: con el puntero lejos, el grafico se mueve como
   siempre; cerca de una linea, la capa de arriba toma el puntero para arrastrarla.

   Con el dedo (celular, tablet) no hay "pasar por encima": si el toque empieza
   cerca de una linea, el gesto es de la linea y el grafico no se desplaza; si no,
   el grafico se mueve como siempre. */

const TOLERANCIA = 5;     // pixeles alrededor de la linea, con el mouse
const TOLERANCIA_DEDO = 18;   // con el dedo: la linea es fina y el dedo no
const ESPERA_MT5 = 4000;  // ms que la linea queda en el precio nuevo hasta que MT5 lo confirma

export class LineasOrden {
  constructor(engine, capa, cb = {}) {
    this.e = engine;
    this.el = capa;
    this.cb = cb;            // onModificar({ ticket, campo, desde, hasta, item, y }), onBorrador({ campo, precio }), onCerrar(que)
    this.lineas = [];        // las del ultimo dibujo: { ticket, campo, y, precio, item }
    this.arrastre = null;    // { linea, precio }
    this.pendiente = null;   // el cambio que espera confirmacion
    this.confirmado = null;  // el que ya se mando, hasta que MT5 lo publique
    this.vista = null;       // lo que se esta escribiendo en el panel: { ticket, sl, tp, precio }
    const on = (el, tipo, fn) => {
      el.addEventListener(tipo, fn);
      engine.disposers.push(() => el.removeEventListener(tipo, fn));
    };
    on(engine.els.price, "pointermove", (ev) => this.cercania(ev));
    on(capa, "pointerdown", (ev) => this.down(ev));
    on(capa, "pointermove", (ev) => this.move(ev));
    on(capa, "pointerup", (ev) => this.up(ev));
    on(capa, "pointercancel", () => this.soltar());
    on(capa, "pointerleave", () => { if (!this.arrastre) this.e.sinCruz(); });

    // Dedo: se mira el toque antes de que le llegue al grafico (fase de captura).
    const precio = engine.els.price;
    const conOpc = (el, tipo, fn, opc) => {
      el.addEventListener(tipo, fn, opc);
      engine.disposers.push(() => el.removeEventListener(tipo, fn, opc));
    };
    conOpc(precio, "pointerdown", (ev) => this.toque(ev), { capture: true });
    // Mientras el dedo arrastra una linea, el grafico no recibe el gesto (ni se desplaza la pagina).
    const frenar = (ev) => { if (this.dedo !== null) { ev.preventDefault(); ev.stopPropagation(); } };
    for (const tipo of ["touchstart", "touchmove"]) conOpc(precio, tipo, frenar, { capture: true, passive: false });
    this.dedo = null;        // pointerId del dedo que arrastra
    this.alMover = (ev) => { if (ev.pointerId === this.dedo) this.move(ev); };
    this.alSoltar = (ev) => {
      if (ev.pointerId !== this.dedo) return;
      this.finDedo();
      if (ev.type === "pointercancel") this.soltar(); else this.up(ev);
    };
  }

  /** Un toque con el dedo cerca de una linea: empieza a arrastrarla. */
  toque(ev) {
    if (ev.pointerType === "mouse" || this.pendiente || this.arrastre) return;
    if (this.e.dibujos && this.e.dibujos.herramienta !== "cursor") return;   // se esta dibujando
    const { x, y } = this.punto(ev);
    const l = this.cerca(x, y, TOLERANCIA_DEDO);
    if (!l) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.dedo = ev.pointerId;
    this.arrastre = { linea: l, precio: l.precio };
    this.marcar(l);
    window.addEventListener("pointermove", this.alMover);
    window.addEventListener("pointerup", this.alSoltar);
    window.addEventListener("pointercancel", this.alSoltar);
    this.e.agendarDibujo();
  }

  finDedo() {
    this.dedo = null;
    window.removeEventListener("pointermove", this.alMover);
    window.removeEventListener("pointerup", this.alSoltar);
    window.removeEventListener("pointercancel", this.alSoltar);
  }

  punto(ev) {
    const r = this.e.els.price.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  cerca(x, y, tolerancia = TOLERANCIA) {
    if (x > this.e.price.timeScale().width()) return null;   // sobre la escala de precios: no
    let mejor = null;
    for (const l of this.lineas) {
      const d = Math.abs(l.y - y);
      if (d <= tolerancia && (!mejor || d < Math.abs(mejor.y - y))) mejor = l;
    }
    return mejor;
  }

  marcar(l) {
    this.el.classList.toggle("arrastrable", Boolean(l));
    this.el.title = !l ? ""
      : l.campo === "entrada" ? "Arrastra hacia la pérdida para poner el SL, o hacia la ganancia para el TP"
      : l.campo === "precio" ? "Arrastra para mover el precio de la orden"
      : `Arrastra para mover el ${l.campo.toUpperCase()}`;
  }

  /** Puntero sobre el grafico: si pasa cerca de una linea (o sobre la ✕ de su
   *  etiqueta), la capa lo toma. */
  cercania(ev) {
    if (this.arrastre || this.pendiente || ev.pointerType !== "mouse") return;
    const { x, y } = this.punto(ev);
    if (this.boton(x, y)) return;
    this.marcar(this.cerca(x, y));
  }

  /** La ✕ de una operacion bajo el puntero: la capa toma el clic (cierra o cancela). */
  boton(x, y) {
    const b = this.e.botonEn?.(x, y);
    this.el.style.cursor = b ? "pointer" : "";
    if (!b) return null;
    this.el.classList.add("arrastrable");
    this.el.title = b.cerrar.accion === "cancelar" ? `Cancelar la ${b.cerrar.nombre}` : `Cerrar la ${b.cerrar.nombre} a mercado`;
    return b;
  }

  down(ev) {
    if (ev.button !== 0 || this.pendiente) { this.marcar(null); return; }
    const { x, y } = this.punto(ev);
    // La ✕ de la etiqueta: cierra la posicion (o cancela la orden) de una.
    const b = this.e.botonEn?.(x, y);
    if (b) {
      ev.preventDefault();
      ev.stopPropagation();
      this.cb.onCerrar?.(b.cerrar);
      return;
    }
    const l = this.cerca(x, y);
    if (!l) { this.marcar(null); return; }
    ev.preventDefault();
    ev.stopPropagation();
    this.arrastre = { linea: l, precio: l.precio };
    this.el.setPointerCapture?.(ev.pointerId);
    this.e.agendarDibujo();
  }

  move(ev) {
    const { x, y } = this.punto(ev);
    // La capa tiene el puntero (y el grafico no): la cruz lo sigue igual.
    this.e.cruzEn(x, y);
    if (!this.arrastre) {
      if (this.boton(x, y)) return;
      if (!this.cerca(x, y)) this.marcar(null);
      return;
    }
    // La diferencia y el tick de la cuenta de la linea.
    const b = this.arrastre.linea.bloque ?? this.e.broker;
    const p = this.e.s.velas.coordinateToPrice(y);
    if (p === null || !b) return;
    const dif = b.graficoBroker ? 0 : b.diferencia || 0;
    const tick = b.info?.tick_size || b.info?.point || 0;
    const precio = p + dif;
    this.arrastre.precio = tick > 0 ? Math.round(precio / tick) * tick : precio;
    this.e.agendarDibujo();
  }

  up(ev) {
    const a = this.arrastre;
    if (!a) return;
    this.soltar();
    const tick = (a.linea.bloque ?? this.e.broker)?.info?.tick_size || a.linea.item.tick || 0;
    if (Math.abs(a.precio - a.linea.precio) <= tick / 2) return;
    const it = a.linea.item;
    const campo = this.campoDe(a.linea, a.precio);
    // El borrador: el precio nuevo va al formulario de Operar (no se manda nada). La
    // linea queda ahi hasta que el panel lo dibuje de nuevo.
    if (it.borrador) {
      this.confirmado = { ticket: it.ticket, campo, hasta: a.precio, vence: Date.now() + 1500 };
      this.cb.onBorrador?.({ campo, precio: a.precio });
      this.e.agendarDibujo();
      return;
    }
    this.pendiente = {
      ticket: it.ticket, campo, desde: campo === "precio" ? it.entrada : it[campo] ?? null,
      hasta: a.precio, item: it, y: this.punto(ev).y,
    };
    this.cb.onModificar?.(this.pendiente);
    this.e.agendarDibujo();
  }

  soltar() {
    this.arrastre = null;
    this.marcar(null);
    this.e.agendarDibujo();
  }

  /** La entrada de una posicion: hacia la perdida es el SL, hacia la ganancia el TP. */
  campoDe(linea, precio) {
    if (linea.campo !== "entrada") return linea.campo;
    const compra = String(linea.item.tipo).startsWith("buy");
    return (precio < linea.item.entrada) === compra ? "sl" : "tp";
  }

  /** La interfaz cerro la confirmacion. Si se mando, la linea queda en el precio
   *  nuevo hasta que el puente publique el cambio (asi no salta para atras). */
  resolver(mandado = false) {
    const p = this.pendiente;
    this.pendiente = null;
    if (mandado && p) this.confirmado = { ticket: p.ticket, campo: p.campo, hasta: p.hasta, vence: Date.now() + ESPERA_MT5 };
    this.e.agendarDibujo();
  }

  /** Lo que se esta escribiendo en el panel Operar, para verlo en el grafico. */
  setVista(v) {
    this.vista = v;
    this.e.agendarDibujo();
  }

  /** Precio a dibujar para una linea: el que se arrastra, el que espera
   *  confirmacion, el recien mandado o el que se escribe en el panel. */
  precioDe(ticket, campo, original) {
    const a = this.arrastre;
    if (a && a.linea.item.ticket === ticket && this.campoDe(a.linea, a.precio) === campo) return a.precio;
    const p = this.pendiente;
    if (p && p.ticket === ticket && p.campo === campo) return p.hasta;
    const c = this.confirmado;
    if (c && c.ticket === ticket && c.campo === campo && Date.now() < c.vence) return c.hasta;
    const v = this.vista;
    if (v && v.ticket === ticket && v[campo] !== undefined) return v[campo];
    return original;
  }

  /** Si esa linea se esta moviendo (para dibujarla resaltada). */
  moviendo(ticket, campo, original) {
    const x = this.precioDe(ticket, campo, original);
    return x !== original && !(x === null && original === undefined);
  }
}
