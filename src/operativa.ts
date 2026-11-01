/* Operativa: las ordenes del panel Operar, hacia MT5.
 *
 * El terminal no opera solo: cada orden la pide una persona desde el panel, con
 * confirmacion. Aca se valida contra la especificacion del simbolo que publica el
 * puente (volumen minimo, maximo y paso; lado del SL y del TP; precio de la orden
 * limite), se redondea al tick y se escribe un archivo para el EA
 * CriptoTerminalOperador, que la valida de nuevo y la manda al broker. Despues se
 * espera su respuesta unos segundos.
 *
 *   MQL5\Files\cripto-terminal\operador\entrada\<id>.txt   la orden (clave=valor)
 *   MQL5\Files\cripto-terminal\operador\salida\<id>.json   la respuesta del EA
 *   MQL5\Files\cripto-terminal\operador\estado.json        si el EA esta vivo */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { getLogger } from "./log.ts";
import { brokerSymbol, buscar, num, porPunto, type BrokerBridge } from "./mt5.ts";

const log = getLogger("operativa");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Accion = "abrir" | "cerrar" | "modificar" | "cancelar";

export interface Pedido {
  accion: Accion;
  symbol?: string;                  // de la terminal (XAUUSDT) o del broker (XAUUSD)
  lado?: "buy" | "sell";
  tipo?: "mercado" | "limite";
  volumen?: number;
  precio?: number;                  // orden limite (o el nuevo precio de una pendiente)
  sl?: number;                      // 0 o vacio: sin
  tp?: number;
  ticket?: number;                  // cerrar, modificar, cancelar
}

export interface Resultado {
  ok: boolean;
  estado: "hecha" | "rechazada" | "sin_respuesta";
  mensaje: string;
  ticket?: number;
  precio?: number;
  volumen?: number;
  retcode?: number;
}

/** Tamano de un pip: en divisas de 5 o 3 decimales son 10 puntos; en el oro 0,1;
 *  en los indices y las cripto, un punto entero del precio. */
export function pipDe(info: any): number {
  const digitos = Number(info.digits);
  const punto = num(info.point) || 10 ** -digitos;
  const s = String(info.symbol ?? "").toUpperCase();
  if (digitos === 5 || digitos === 3) return 10 * punto;
  if (s.startsWith("XAU")) return 0.1;
  return digitos >= 2 && (num(info.bid) || 0) < 100 ? 10 * punto : 1;
}

/** Decimales del paso de volumen (0,01 -> 2). */
const decimales = (paso: number) => {
  const [mantisa, exponente = "0"] = String(paso).toLowerCase().split("e");
  return Math.max(0, Math.min(8, (mantisa.split(".")[1]?.length ?? 0) - Number(exponente)));
};

/** Redondea un precio al tick del simbolo. */
export function alTick(p: number, info: any): number {
  const tick = num(info.tick_size) || num(info.point) || 0;
  const d = Number.isInteger(info.digits) && info.digits >= 0 && info.digits <= 8 ? info.digits : 2;
  const x = tick > 0 ? Math.round(p / tick) * tick : p;
  return Number(x.toFixed(d));
}

/** Valida y normaliza una orden contra la especificacion del simbolo. Devuelve el
 *  error en castellano, o la orden lista para el EA. `posicion`: la posicion o la
 *  orden pendiente afectada, para cerrar o modificar. */
/** Con el mercado cerrado MT5 rechaza todo (retcode 10018): se dice claro que
 *  quedo como estaba; en una pendiente, que SIGUE PUESTA y puede ejecutarse al reabrir. */
export function explicar(accion: string, r: any): string {
  const mensaje = String(r?.mensaje ?? "");
  if (r?.ok || !(Number(r?.retcode) === 10018 || /market closed/i.test(mensaje))) return mensaje;
  const que: Record<string, string> = {
    cancelar: "MT5 no deja cancelar ahora: la orden SIGUE PUESTA y puede ejecutarse cuando reabra",
    modificar: "no se cambió nada (el SL, el TP y el precio siguen como estaban)",
    cerrar: "la posición sigue abierta",
    abrir: "no se abrió nada",
  };
  return `Mercado cerrado: ${que[accion] ?? "no se hizo nada"}`;
}

export function validar(p: Pedido, info: any | null, operador: { sl_obligatorio?: boolean; lote_max?: number } | null,
                        posicion: any | null = null): { error: string } | { orden: Record<string, string | number> } {
  for (const campo of ["volumen", "precio", "sl", "tp", "ticket"] as const) {
    const valor = p[campo];
    if (valor !== undefined && (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0)) {
      return { error: `El campo ${campo} debe ser un número válido, mayor o igual a cero` };
    }
  }
  const sl = num(p.sl) || 0, tp = num(p.tp) || 0;
  if (p.accion === "abrir") {
    if (!info) return { error: "El broker no publica ese símbolo: sumalo a InpSimbolos del puente" };
    const compra = p.lado === "buy";
    if (p.lado !== "buy" && p.lado !== "sell") return { error: "Elegí comprar o vender" };
    if (p.tipo !== "mercado" && p.tipo !== "limite") return { error: "Elegí a mercado o límite" };
    const paso = num(info.volume_step) || 0.01, vmin = num(info.volume_min) || paso, vmax = num(info.volume_max) || Infinity;
    const vol = Number((Math.round((num(p.volumen) || 0) / paso) * paso).toFixed(decimales(paso)));
    if (!(vol > 0) || vol < vmin - 1e-9) return { error: `El volumen mínimo es ${vmin}` };
    if (vol > vmax + 1e-9) return { error: `El volumen máximo del broker es ${vmax}` };
    const tope = operador?.lote_max ?? Infinity;
    if (vol > tope + 1e-9) return { error: `El volumen pasa el máximo del Operador (InpLoteMax ${tope})` };
    const ask = num(info.ask) || 0, bid = num(info.bid) || 0;
    if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) return { error: "Sin cotización válida del broker" };
    let ref = compra ? ask : bid;
    let precio = 0;
    if (p.tipo === "limite") {
      precio = alTick(num(p.precio) || 0, info);
      if (!(precio > 0)) return { error: "Falta el precio de la orden límite" };
      if (compra ? precio >= ask : precio <= bid) {
        return { error: compra ? `Una compra límite va debajo del ask (${ask})` : `Una venta límite va arriba del bid (${bid})` };
      }
      ref = precio;
    }
    if (operador?.sl_obligatorio && !(sl > 0)) return { error: "Falta el stop loss (el Operador lo pide)" };
    const slR = sl > 0 ? alTick(sl, info) : 0, tpR = tp > 0 ? alTick(tp, info) : 0;
    if (operador?.sl_obligatorio && !(slR > 0)) return { error: "El stop loss debe ser mayor a cero después de redondear al tick" };
    if (slR > 0 && (compra ? slR >= ref : slR <= ref)) return { error: compra ? "En una compra el SL va debajo de la entrada" : "En una venta el SL va arriba de la entrada" };
    if (tpR > 0 && (compra ? tpR <= ref : tpR >= ref)) return { error: compra ? "En una compra el TP va arriba de la entrada" : "En una venta el TP va debajo de la entrada" };
    const minimo = (Number(info.stops_level) || 0) * (num(info.point) || 0);
    if (slR > 0 && Math.abs(ref - slR) < minimo) return { error: "El SL está más cerca que la distancia mínima del broker" };
    if (tpR > 0 && Math.abs(ref - tpR) < minimo) return { error: "El TP está más cerca que la distancia mínima del broker" };
    return { orden: { accion: "abrir", symbol: info.symbol, lado: p.lado, tipo: p.tipo, volumen: vol, precio, sl: slR, tp: tpR } };
  }
  if (!Number.isSafeInteger(p.ticket) || !(Number(p.ticket) > 0)) return { error: "Falta un ticket válido" };
  if (!posicion) return { error: "Ya no existe esa posición u orden" };
  const sym = String(posicion.symbol);
  const i = info ?? { digits: 5, symbol: sym };
  if (p.accion === "cerrar") {
    const total = num(posicion.volume) || 0;
    const vol = num(p.volumen) || 0;
    if (vol > total + 1e-9) return { error: `La posición tiene ${total} lotes` };
    return { orden: { accion: "cerrar", ticket: Number(p.ticket), volumen: vol > 0 && vol < total ? vol : 0, symbol: sym } };
  }
  if (p.accion === "cancelar") return { orden: { accion: "cancelar", ticket: Number(p.ticket), symbol: sym } };
  if (p.accion === "modificar") {
    if (operador?.sl_obligatorio && !(sl > 0)) return { error: "No se puede quitar el stop loss (el Operador lo pide)" };
    const compra = String(posicion.type).startsWith("buy");
    const pendiente = String(posicion.type).includes("_");
    const ref = pendiente ? (num(p.precio) || num(posicion.price_open) || 0) : (compra ? num(i.bid) : num(i.ask)) || num(posicion.price_current) || 0;
    const slR = sl > 0 ? alTick(sl, i) : 0, tpR = tp > 0 ? alTick(tp, i) : 0;
    if (slR > 0 && ref > 0 && (compra ? slR >= ref : slR <= ref)) return { error: compra ? "En una compra el SL va debajo del precio" : "En una venta el SL va arriba del precio" };
    if (tpR > 0 && ref > 0 && (compra ? tpR <= ref : tpR >= ref)) return { error: compra ? "En una compra el TP va arriba del precio" : "En una venta el TP va debajo del precio" };
    const precio = pendiente && num(p.precio) ? alTick(num(p.precio)!, i) : 0;
    return { orden: { accion: "modificar", ticket: Number(p.ticket), sl: slR, tp: tpR, precio, symbol: sym } };
  }
  return { error: "Acción desconocida" };
}

/** Cuanto mueve en dinero una distancia de precio con ese volumen. */
export function enDinero(distancia: number, info: any, volumen: number): number | null {
  const pp = porPunto(info);
  return pp ? Math.abs(distancia) * pp * volumen : null;
}

export class Operativa {
  private broker: BrokerBridge;
  private enCurso = new Set<string>();

  constructor(broker: BrokerBridge) {
    this.broker = broker;
  }

  private carpeta(): string | null {
    const est = this.broker.estado();
    return est.available && est.path ? join(dirname(est.path), "operador") : null;
  }

  /** Si el EA Operador esta corriendo, habilitado y con que reglas. */
  operador(): any {
    const c = this.carpeta();
    if (!c) return { vivo: false, motivo: "Sin el puente de MT5" };
    try {
      const j = JSON.parse(readFileSync(join(c, "estado.json"), "latin1"));
      const edad = Date.now() - Number(j.vivo_ms);
      return { ...j, vivo: edad < 6000, edad_s: Math.round(edad / 1000) };
    } catch {
      return { vivo: false, motivo: "El EA CriptoTerminalOperador no está corriendo en MT5" };
    }
  }

  /** Simbolo del broker para un simbolo de la terminal (o del broker) y su especificacion. */
  info(symbol: string): any | null {
    const est = this.broker.estado();
    if (!est.available) return null;
    const sym = brokerSymbol(symbol) ?? symbol;
    return buscar(est.symbols as Record<string, any>, sym) ?? null;
  }

  private buscarTicket(ticket: number): any | null {
    const est = this.broker.estado();
    if (!est.available) return null;
    return [...(est.positions ?? []), ...(est.orders ?? [])].find((x: any) => Number(x.ticket) === Number(ticket)) ?? null;
  }

  /** Valida, escribe la orden para el EA y espera su respuesta. */
  async enviar(p: Pedido): Promise<Resultado> {
    const simbolo = String(p.symbol ?? "").toUpperCase();
    const clave = p.accion === "abrir" ? `simbolo:${(brokerSymbol(simbolo) ?? simbolo).toUpperCase()}` : `ticket:${p.ticket}`;
    if (this.enCurso.has(clave)) return { ok: false, estado: "rechazada", mensaje: "Ya hay un pedido en curso para esta operación; espera su respuesta antes de repetirlo" };
    this.enCurso.add(clave);
    try { return await this.ejecutar(p); } finally { this.enCurso.delete(clave); }
  }

  private async ejecutar(p: Pedido): Promise<Resultado> {
    if (!config.TRADING_ACTIVO) return { ok: false, estado: "rechazada", mensaje: "La operativa está apagada (TRADING_ACTIVO=false en el .env)" };
    const est = this.broker.estado();
    if (!est.available || !est.live) return { ok: false, estado: "rechazada", mensaje: "MT5 no está publicando: abrí MT5 con el puente" };
    const op = this.operador();
    if (!op.vivo) return { ok: false, estado: "rechazada", mensaje: op.motivo || "El EA Operador no está corriendo" };
    if (!op.habilitado) return { ok: false, estado: "rechazada", mensaje: op.motivo || "El EA Operador no está habilitado" };
    const posicion = p.accion === "abrir" ? null : this.buscarTicket(Number(p.ticket));
    const info = this.info(p.accion === "abrir" ? String(p.symbol ?? "") : String(posicion?.symbol ?? ""));
    const v = validar(p, info, op, posicion);
    if ("error" in v) return { ok: false, estado: "rechazada", mensaje: v.error };

    const carpeta = this.carpeta()!;
    const entrada = join(carpeta, "entrada"), salida = join(carpeta, "salida");
    mkdirSync(entrada, { recursive: true });
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const campos = { id, creado: Date.now(), cuenta: String(est.account?.login ?? ""), ...v.orden };
    const texto = Object.entries(campos).map(([k, x]) => `${k}=${x}`).join("\r\n") + "\r\n";
    const tmp = join(entrada, `${id}.tmp`), archivo = join(entrada, `${id}.txt`);
    writeFileSync(tmp, texto, "ascii");
    renameSync(tmp, archivo);
    log.info(`Orden ${id}: ${JSON.stringify(v.orden)}`);

    const respuesta = join(salida, `${id}.json`);
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (!existsSync(respuesta)) continue;
      try {
        const r = JSON.parse(readFileSync(respuesta, "latin1"));
        try { unlinkSync(respuesta); } catch { /* ya no esta */ }
        log.info(`Orden ${id}: ${r.ok ? "hecha" : "rechazada"} · ${r.mensaje}`);
        return {
          ok: Boolean(r.ok), estado: r.ok ? "hecha" : "rechazada", mensaje: explicar(p.accion, r),
          ticket: Number(r.ticket) || undefined, precio: num(r.precio) ?? undefined, volumen: num(r.volumen) ?? undefined,
          retcode: Number(r.retcode) || undefined,
        };
      } catch { /* a medio escribir: se reintenta */ }
    }
    // Sin respuesta: si el EA todavia no la tomo, se retira para que no se ejecute despues.
    if (existsSync(archivo)) {
      try {
        unlinkSync(archivo);
        return { ok: false, estado: "rechazada", mensaje: "MT5 no tomó la orden a tiempo: no se envió. Revisá que el Operador esté corriendo." };
      } catch { /* si el EA la tomó justo ahora, el resultado sigue siendo incierto */ }
    }
    return { ok: false, estado: "sin_respuesta", mensaje: "MT5 tomó la orden pero no respondió todavía: revisá las posiciones antes de repetirla" };
  }

  /** Respuestas viejas que nadie leyo (por un reinicio del terminal): se borran. */
  limpiar(): void {
    const c = this.carpeta();
    if (!c) return;
    const salida = join(c, "salida");
    if (!existsSync(salida)) return;
    for (const f of readdirSync(salida)) {
      const p = join(salida, f);
      try { if (Date.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch { /* ya no esta */ }
    }
  }
}
