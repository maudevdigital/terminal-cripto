/* Ejecuciones: lo que les pasa a las operaciones (se abrio o se lleno una limite,
 * toco el SL o el TP, se cerro, se movio el SL o el TP, se puso o se cancelo una
 * pendiente), comparando lo abierto de una vuelta a la siguiente. La terminal suena
 * con cada una. El motivo de un cierre sale del historial de MT5 (el deal dice si fue
 * el SL o el TP); si no se sabe (Binance, o el historial no llego), se deduce del
 * ultimo precio. */

export type TipoEjecucion = "abierta" | "sl" | "tp" | "cerrada" | "parcial" | "modificada" | "pendiente" | "cancelada";

export interface Ejecucion {
  id: number;
  t: number;
  mercado: string;            // mt5 | binance
  tipo: TipoEjecucion;
  simbolo: string;
  lado: "buy" | "sell";
}

export interface PosicionVista {
  id: string;
  simbolo: string;
  lado: "buy" | "sell";
  volumen: number;
  entrada: number;
  actual: number;
  sl: number | null;
  tp: number | null;
}

export interface PendienteVista { id: string; simbolo: string; lado: "buy" | "sell" }

/** El motivo de un cierre, si ya se sabe (undefined: todavia no). */
export type Motivo = (id: string) => "sl" | "tp" | "cerrada" | undefined;

const ESPERA_MOTIVO = 8000;   // lo que se espera al historial antes de deducirlo del precio
const GUARDA = 2 * 60_000;    // las de los ultimos 2 minutos van en cada paquete

/** Por el ultimo precio: cerca (un cuarto de la distancia a la entrada) o pasado el SL o el TP. */
export function deducirMotivo(p: PosicionVista): "sl" | "tp" | "cerrada" {
  if (!(p.actual > 0)) return "cerrada";
  const compra = p.lado === "buy";
  const margen = (nivel: number) => Math.abs(p.entrada - nivel) * 0.25;
  if (p.sl && (compra ? p.actual <= p.sl + margen(p.sl) : p.actual >= p.sl - margen(p.sl))) return "sl";
  if (p.tp && (compra ? p.actual >= p.tp - margen(p.tp) : p.actual <= p.tp + margen(p.tp))) return "tp";
  return "cerrada";
}

export class Ejecuciones {
  private lista: Ejecucion[] = [];
  private sig = 1;
  private antes = new Map<string, { cuenta: string; pos: Map<string, PosicionVista>; pend: Map<string, PendienteVista> }>();
  private porCerrar: { mercado: string; p: PosicionVista; desde: number }[] = [];
  private motivos = new Map<string, Motivo | undefined>();   // el de la ultima vuelta (el historial mas nuevo)

  /** Lo abierto ahora en un mercado. La primera vez (o al cambiar de cuenta) solo se anota. */
  observar(mercado: string, cuenta: string, posiciones: PosicionVista[], pendientes: PendienteVista[], motivo?: Motivo, ahora = Date.now()): void {
    const pos = new Map(posiciones.map((p) => [p.id, p]));
    const pend = new Map(pendientes.map((o) => [o.id, o]));
    const prev = this.antes.get(mercado);
    this.antes.set(mercado, { cuenta, pos, pend });
    this.motivos.set(mercado, motivo);
    if (prev && prev.cuenta === cuenta) {
      const llenadas = new Set<string>();
      for (const p of posiciones) {
        const a = prev.pos.get(p.id);
        if (!a) {
          // Una limite que se lleno: en MT5 la posicion lleva el ticket de la orden; en Binance, el mismo simbolo y lado.
          const orden = prev.pend.get(p.id) ?? [...prev.pend.values()].find((o) => !pend.has(o.id) && o.simbolo === p.simbolo && o.lado === p.lado);
          if (orden) llenadas.add(orden.id);
          this.anotar(mercado, "abierta", p, ahora);
          continue;
        }
        if (p.volumen > a.volumen + 1e-9) this.anotar(mercado, "abierta", p, ahora);
        else if (p.volumen < a.volumen - 1e-9) this.anotar(mercado, "parcial", p, ahora);
        if (!igual(p.sl, a.sl) || !igual(p.tp, a.tp)) this.anotar(mercado, "modificada", p, ahora);
      }
      for (const a of prev.pos.values()) {
        if (!pos.has(a.id)) this.porCerrar.push({ mercado, p: a, desde: ahora });
      }
      for (const o of pendientes) if (!prev.pend.has(o.id)) this.anotar(mercado, "pendiente", o, ahora);
      for (const o of prev.pend.values()) {
        if (!pend.has(o.id) && !llenadas.has(o.id)) this.anotar(mercado, "cancelada", o, ahora);
      }
    }
    this.resolverCierres(ahora);
  }

  /** Las de los ultimos 2 minutos (el cliente suena las que no vio). */
  recientes(ahora = Date.now()): Ejecucion[] {
    return this.lista.filter((e) => ahora - e.t < GUARDA);
  }

  private resolverCierres(ahora: number): void {
    this.porCerrar = this.porCerrar.filter((c) => {
      const motivo = this.motivos.get(c.mercado);
      const m = motivo?.(c.p.id) ?? (motivo && ahora - c.desde < ESPERA_MOTIVO ? undefined : deducirMotivo(c.p));
      if (m === undefined) return true;
      this.anotar(c.mercado, m, c.p, ahora);
      return false;
    });
  }

  private anotar(mercado: string, tipo: TipoEjecucion, x: { simbolo: string; lado: "buy" | "sell" }, t: number): void {
    this.lista.push({ id: this.sig++, t, mercado, tipo, simbolo: x.simbolo, lado: x.lado });
    if (this.lista.length > 50) this.lista.splice(0, this.lista.length - 50);
  }
}

function igual(a: number | null, b: number | null): boolean {
  return Math.abs((a || 0) - (b || 0)) < 1e-9;
}

/** El motivo de un cierre en MT5, del historial del puente: el deal de salida de esa posicion. */
export function motivoMT5(deals: any[] | null | undefined): Motivo {
  return (id) => {
    if (!Array.isArray(deals)) return undefined;
    const salida = deals.filter((d) => String(d.position) === id && d.entry !== "in").at(-1);
    if (!salida) return undefined;
    return salida.reason === "sl" || salida.reason === "so" ? "sl" : salida.reason === "tp" ? "tp" : "cerrada";
  };
}
