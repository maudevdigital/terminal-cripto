/* Freno de disciplina: despues de una racha de perdidas, de muchas operaciones en
 * el dia o de perder mas de lo permitido en el dia, la terminal no deja abrir mas hasta el dia siguiente de la firma
 * (modo "bloquear") o solo avisa ("avisar"). Tambien frena un rato despues de cada
 * salida y mientras la cuenta real este en pausa. Cerrar, acercar el SL, mover el TP y
 * cancelar siguen siempre permitidos.
 *
 * Cuenta las operaciones del dia de la firma (corta a medianoche de PROP_ZONA,
 * como los limites de FTMO): las cerradas, las abiertas y las limite puestas. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Operacion } from "./historial.ts";

export interface Reglas {
  perdidasSeguidas: number;   // 0: sin esta regla
  operacionesDia: number;     // 0: sin esta regla
  perdidaDia: number;         // USD que se pueden perder en el dia (0: sin esta regla)
  modo: "bloquear" | "avisar";
  pausaMin?: number;          // minutos sin abrir despues de cada salida (0: sin esta regla)
}

/** La cuenta real en pausa: se practica en demo. Quitarla tarda (`quitarEn`). */
export interface EstadoPausa { activa: boolean; quitarEn: number | null; esperaMin: number }

export interface Freno {
  activo: boolean;            // alguna regla se cumplio
  bloquea: boolean;           // y el modo es bloquear
  motivos: string[];
  hasta: number | null;       // ms: cuando se levanta (null: hasta que se quite la pausa)
  porDia: boolean;            // alguna regla del dia: dura hasta el corte
  pausa: EstadoPausa | null;
  hoy: number;                // operaciones de hoy
  seguidas: number;           // perdidas seguidas (de las ultimas cerradas)
  reglas: Reglas;
}

/** `cerradas`: el historial; `abiertasHoy`: posiciones y limites abiertas hoy;
 *  `perdidaHoy`: lo perdido en el dia (cerrado y abierto), en USD positivos. */
export function evaluar(cerradas: Operacion[], abiertasHoy: number, inicioDia: number, proximoCorte: number, reglas: Reglas,
                        perdidaHoy = 0, { ultimaSalida = 0, pausa = null, ahora = Date.now() }: { ultimaSalida?: number; pausa?: EstadoPausa | null; ahora?: number } = {}): Freno {
  const deHoy = cerradas.filter((o) => o.apertura >= inicioDia).length;
  const hoy = deHoy + abiertasHoy;
  // Perdidas seguidas, de la ultima cerrada para atras; un empate (±1 USD) no corta ni suma.
  const orden = [...cerradas].sort((a, b) => b.cierre - a.cierre);
  let seguidas = 0;
  for (const o of orden) {
    if (Math.abs(o.resultado) < 1) continue;
    if (o.resultado < 0) seguidas++; else break;
  }
  // La racha cuenta solo si la ultima perdida fue hoy: un dia nuevo arranca limpio.
  const ultimaPerdida = orden.find((o) => o.resultado <= -1);
  const rachaDeHoy = Boolean(ultimaPerdida && ultimaPerdida.cierre >= inicioDia);
  const motivos: string[] = [];
  if (reglas.perdidasSeguidas > 0 && rachaDeHoy && seguidas >= reglas.perdidasSeguidas) {
    motivos.push(`${seguidas} pérdidas seguidas`);
  }
  if (reglas.operacionesDia > 0 && hoy >= reglas.operacionesDia) {
    motivos.push(`${hoy} operaciones hoy (máximo ${reglas.operacionesDia})`);
  }
  if (reglas.perdidaDia > 0 && perdidaHoy >= reglas.perdidaDia) {
    motivos.push(`perdiste ${perdidaHoy.toFixed(0)} USD hoy (máximo ${reglas.perdidaDia.toFixed(0)})`);
  }
  const porDia = motivos.length > 0;
  let hasta: number | null = porDia ? proximoCorte : null;
  // La pausa despues de salir: vale cualquier salida, tambien la que dio ganancia.
  const salida = Math.max(ultimaSalida, 0, ...cerradas.map((o) => o.cierre));
  const finSalida = reglas.pausaMin && reglas.pausaMin > 0 && salida > 0 ? salida + reglas.pausaMin * 60_000 : 0;
  if (ahora < finSalida) {
    motivos.push(`pausa de ${reglas.pausaMin} min después de salir (quedan ${Math.ceil((finSalida - ahora) / 60_000)})`);
    hasta = Math.max(hasta ?? 0, finSalida);
  }
  const pausada = Boolean(pausa?.activa);
  if (pausada) {
    motivos.unshift("cuenta real en pausa");
    hasta = pausa!.quitarEn ? Math.max(hasta ?? 0, pausa!.quitarEn) : null;
  }
  const activo = motivos.length > 0;
  return { activo, bloquea: pausada || (activo && reglas.modo === "bloquear"), motivos, hasta, porDia, pausa, hoy, seguidas, reglas };
}

/** La pausa de la cuenta real, guardada en su archivo. Ponerla es inmediato; quitarla
 *  tarda `esperaMin` minutos, para que no se pueda saltar en un impulso. */
export class PausaReal {
  ruta: string;
  esperaMin: number;
  activa = false;
  quitarEn: number | null = null;

  constructor(ruta: string, esperaMin = 10) {
    this.ruta = ruta;
    this.esperaMin = esperaMin;
    try {
      const d = JSON.parse(readFileSync(ruta, "utf8"));
      this.activa = d.activa === true;
      this.quitarEn = Number(d.quitarEn) || null;
    } catch { /* sin archivo: sin pausa */ }
  }

  private guardar(): void {
    mkdirSync(dirname(this.ruta), { recursive: true });
    writeFileSync(this.ruta, JSON.stringify({ activa: this.activa, quitarEn: this.quitarEn }));
  }

  estado(ahora = Date.now()): EstadoPausa {
    if (this.activa && this.quitarEn && ahora >= this.quitarEn) {
      this.activa = false;
      this.quitarEn = null;
      this.guardar();
    }
    return { activa: this.activa, quitarEn: this.quitarEn, esperaMin: this.esperaMin };
  }

  poner(): void { this.activa = true; this.quitarEn = null; this.guardar(); }

  /** Pide quitarla: se levanta despues de la espera. Se puede arrepentir con poner(). */
  quitar(ahora = Date.now()): void {
    if (!this.activa || this.quitarEn) return;
    if (this.esperaMin > 0) this.quitarEn = ahora + this.esperaMin * 60_000;
    else this.activa = false;
    this.guardar();
  }
}

/** Si un SL deja mas riesgo que el SL inicial, o quita el stop. */
export function ampliaSl(lado: "buy" | "sell", inicial: number | null, sl: number): boolean {
  if (!inicial || !(inicial > 0)) return false;
  if (!(sl > 0)) return true;
  return lado === "buy" ? sl < inicial - 1e-9 : sl > inicial + 1e-9;
}

export interface PosicionSl { id: string; lado: "buy" | "sell"; actual: number; sl: number | null; inicial: number | null }
export type AccionSl = { id: string; accion: "sl"; precio: number };

/** Lo abierto con el SL mas lejos que el inicial (ampliado directo en MT5): vuelve al
 *  inicial. Si el precio ya lo paso, no se toca: la terminal nunca cierra sola. Lo que
 *  quedo sin SL lo atiende el corte automatico. */
export function planSl(posiciones: PosicionSl[]): AccionSl[] {
  const out: AccionSl[] = [];
  for (const p of posiciones) {
    if (!p.sl || !ampliaSl(p.lado, p.inicial, p.sl)) continue;
    const paso = p.actual > 0 && (p.lado === "buy" ? p.actual <= p.inicial! : p.actual >= p.inicial!);
    if (!paso) out.push({ id: p.id, accion: "sl", precio: p.inicial! });
  }
  return out;
}

/** El freno tambien en MT5: lo que se abre por fuera de la terminal (en MT5 o en el
 *  celular) mientras bloquea. Lo que ya estaba cuando se activo no se toca: en la
 *  primera vuelta, sin bloqueo, al activarse o con otra cuenta, todo lo que hay pasa a
 *  `conocidos`. Una limite conocida que se ejecuta sigue conocida (la posicion lleva
 *  el ticket de la orden que la abrio). Devuelve el estado de la vuelta siguiente y
 *  los tickets nuevos, que hay que cancelar o cerrar.
 *
 *  Solo se frena lo que se abrio con la terminal mirando: tras un hueco de mas de
 *  HUECO_MS (terminal apagada, PC dormido o MT5 desconectado) lo que aparece se toma
 *  como ya puesto. Un reinicio corto del servidor no es un hueco: el estado se guarda. */
export interface Vigia { cuenta: string; bloqueaba: boolean; conocidos: Set<string>; visto: number }

export const HUECO_MS = 60_000;

export function vigilar(antes: Vigia | null, cuenta: string, tickets: string[], bloquea: boolean, ahora = Date.now()): { estado: Vigia; nuevos: string[] } {
  if (!antes || ahora - antes.visto > HUECO_MS || !bloquea || !antes.bloqueaba || antes.cuenta !== cuenta) {
    // Se suman a los de antes (los tickets no se repiten): si una vuelta llega sin
    // alguna orden, esa no pasa a ser nueva despues.
    const conocidos = antes && antes.cuenta === cuenta ? new Set([...antes.conocidos, ...tickets]) : new Set(tickets);
    return { estado: { cuenta, bloqueaba: bloquea, conocidos, visto: ahora }, nuevos: [] };
  }
  return { estado: { ...antes, visto: ahora }, nuevos: tickets.filter((t) => !antes.conocidos.has(t)) };
}

/** El estado de la vigilancia, para que un reinicio corto del servidor no perdone nada. */
export function cargarVigia(ruta: string): Vigia | null {
  try {
    const d = JSON.parse(readFileSync(ruta, "utf8"));
    return { cuenta: String(d.cuenta), bloqueaba: d.bloqueaba === true, visto: Number(d.visto) || 0, conocidos: new Set<string>(d.conocidos) };
  } catch {
    return null;
  }
}

export function guardarVigia(ruta: string, v: Vigia): void {
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, JSON.stringify({ cuenta: v.cuenta, bloqueaba: v.bloqueaba, visto: v.visto, conocidos: [...v.conocidos].slice(-500) }));
}
