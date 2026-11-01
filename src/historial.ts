/* Historial de la cuenta de MT5: las operaciones cerradas (armadas con los deals
 * que exporta el puente v5), sus metricas, el resultado de cada dia y la cabina
 * de riesgo de la cuenta de fondeo: cuanto queda antes de la perdida maxima del
 * dia y de la perdida maxima total.
 *
 * Todo sale del historial y del estado del puente. Lo unico propio que se guarda
 * es el primer SL visto de cada posicion: asi se mide en R tambien una operacion
 * que se abrio sin SL y lo recibio despues. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { getLogger } from "./log.ts";
import * as mt5 from "./mt5.ts";
import { pipDe } from "./operativa.ts";

const log = getLogger("historial");

export interface Deal {
  ticket: number; order: number; position: number;
  time: number; time_msc: number;          // hora del servidor
  type: string; entry: string; reason: string; symbol: string;
  volume: number; price: number; sl: number; tp: number;
  profit: number; commission: number; swap: number; fee: number;
  magic: number; comment: string;
}

export type Motivo = "sl" | "tp" | "manual" | "stop_out" | "otro";

export interface Operacion {
  ticket: number;                 // id de la posicion
  simbolo: string;
  lado: "compra" | "venta";
  volumen: number;
  apertura: number;               // ms UTC
  cierre: number;                 // ms UTC
  entrada: number;                // precio promedio de entrada
  salida: number;                 // precio promedio de salida
  slInicial: number | null;
  tp: number | null;
  bruto: number;                  // ganancia o perdida del precio
  costos: number;                 // comision + swap + cargos (negativo: lo que costo)
  resultado: number;              // neto: bruto + costos
  riesgo: number | null;          // lo que arriesgaba con el SL inicial
  r: number | null;               // resultado / riesgo
  pips: number | null;
  cerradaPor: Motivo;
  minutos: number;
  desdeTerminal: boolean;         // abierta desde el panel Operar (magic del Operador)
}

const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const efectivo = (d: Deal) => (d.profit || 0) + (d.commission || 0) + (d.swap || 0) + (d.fee || 0);
const esTrade = (d: Deal) => (d.type === "buy" || d.type === "sell") && d.position > 0 && d.entry !== "";

// ------------------------------------------------------------------ horarios

const formatos = new Map<string, Intl.DateTimeFormat>();
function partes(ms: number, zona: string) {
  let f = formatos.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatos.set(zona, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Cuanto adelanta la zona respecto de UTC en ese instante, en ms. */
function desfaseZona(ms: number, zona: string): number {
  const p = partes(ms, zona);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** La medianoche (ms UTC) del dia de `zona` que contiene `ms`. */
export function inicioDia(ms: number, zona: string): number {
  const p = partes(ms, zona);
  const local = Date.UTC(p.y, p.m - 1, p.d);
  const t = local - desfaseZona(ms, zona);
  return local - desfaseZona(t, zona);   // por si en el medio cambio el horario de verano
}

/** "2026-10-20": la fecha de ese instante en la zona. */
export function fechaEn(ms: number, zona: string): string {
  const p = partes(ms, zona);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Pasa la hora del servidor de cada deal a UTC, con el desfase del puente (y su
 *  horario de verano, como las velas). */
export function relojDeals(gmtOffset: number | null): (d: Deal) => number {
  if (gmtOffset === null || !Number.isFinite(gmtOffset)) return (d) => d.time_msc;
  const off = mt5.desfases(gmtOffset);
  return (d) => d.time_msc - off(d.time) * 1000;
}

// --------------------------------------------------------------- operaciones

/** Las operaciones cerradas: los deals de cada posicion, juntos. Una posicion con
 *  cierres parciales cuenta cuando se cierra del todo. */
export function armarOperaciones(deals: Deal[], o: {
  aUtc: (d: Deal) => number;
  info: (simbolo: string) => any | null;
  slVisto?: (ticket: number) => number | null;
  magic?: number;
}): Operacion[] {
  const grupos = new Map<number, Deal[]>();
  for (const d of deals) {
    if (!esTrade(d)) continue;
    const g = grupos.get(d.position);
    if (g) g.push(d); else grupos.set(d.position, [d]);
  }
  const out: Operacion[] = [];
  for (const [ticket, g] of grupos) {
    g.sort((a, b) => a.time_msc - b.time_msc);
    const entradas = g.filter((d) => d.entry === "in");
    const salidas = g.filter((d) => d.entry === "out" || d.entry === "out_by" || d.entry === "inout");
    if (!entradas.length || !salidas.length) continue;
    const volIn = suma(entradas.map((d) => d.volume));
    const volOut = suma(salidas.map((d) => d.volume));
    if (volOut < volIn - 1e-9) continue;   // sigue abierta (cerrada en parte)
    const promedio = (ds: Deal[]) => suma(ds.map((d) => d.price * d.volume)) / suma(ds.map((d) => d.volume));
    const primera = entradas[0];
    const ultima = salidas[salidas.length - 1];
    const compra = primera.type === "buy";
    const entrada = promedio(entradas);
    const salida = promedio(salidas);
    const bruto = r2(suma(g.map((d) => d.profit || 0)));
    const costos = r2(suma(g.map((d) => (d.commission || 0) + (d.swap || 0) + (d.fee || 0))));
    const resultado = r2(bruto + costos);
    const slInicial = primera.sl > 0 ? primera.sl : o.slVisto?.(ticket) ?? null;
    const info = o.info(primera.symbol);
    const pp = info ? mt5.porPunto(info) : null;
    // Un SL inicial del lado de la ganancia no es riesgo: esa operacion no tiene R.
    const enContra = slInicial !== null && (compra ? slInicial < entrada : slInicial > entrada);
    const riesgo = enContra && pp ? r2(Math.abs(entrada - slInicial!) * pp * volIn) : null;
    const pip = info ? pipDe(info) : null;
    const motivo = ultima.reason;
    out.push({
      ticket, simbolo: primera.symbol, lado: compra ? "compra" : "venta", volumen: volIn,
      apertura: o.aUtc(primera), cierre: o.aUtc(ultima), entrada, salida,
      slInicial, tp: primera.tp > 0 ? primera.tp : null,
      bruto, costos, resultado, riesgo,
      r: riesgo && riesgo > 0 ? Math.round((resultado / riesgo) * 100) / 100 : null,
      pips: pip ? Math.round(((salida - entrada) * (compra ? 1 : -1) / pip) * 10) / 10 : null,
      cerradaPor: motivo === "sl" ? "sl" : motivo === "tp" ? "tp" : motivo === "so" ? "stop_out"
        : ["client", "mobile", "web", "expert"].includes(motivo) ? "manual" : "otro",
      minutos: Math.max(0, Math.round((o.aUtc(ultima) - o.aUtc(primera)) / 60000)),
      desdeTerminal: o.magic !== undefined && primera.magic === o.magic,
    });
  }
  return out.sort((a, b) => a.cierre - b.cierre);
}

/** El balance despues de cada movimiento (cierres, comisiones, depositos). Si se
 *  pasa el balance actual, la curva se ancla a el: asi da bien aunque el historial
 *  exportado no llegue hasta el primer deposito. */
export function curvaBalance(deals: Deal[], aUtc: (d: Deal) => number, balanceActual: number | null = null) {
  const pts: { t: number; balance: number }[] = [];
  let b = 0;
  for (const d of [...deals].sort((x, y) => x.time_msc - y.time_msc)) {
    const e = efectivo(d);
    if (!e) continue;
    b += e;
    pts.push({ t: aUtc(d), balance: b });
  }
  const ajuste = balanceActual !== null && pts.length ? balanceActual - b : 0;
  return pts.map((p) => ({ t: p.t, balance: r2(p.balance + ajuste) }));
}

/** El balance con que se dio la cuenta: el primer deposito del historial. */
export function primerDeposito(deals: Deal[]): number | null {
  const dep = deals.filter((d) => d.type === "balance" && d.profit > 0).sort((a, b) => a.time_msc - b.time_msc)[0];
  return dep ? dep.profit : null;
}

// ------------------------------------------------------------------ metricas

export interface Metricas {
  operaciones: number; ganadas: number; perdidas: number; pctGanadoras: number | null;
  neto: number; ganado: number; perdido: number;
  gananciaMedia: number | null; perdidaMedia: number | null;
  factorBeneficio: number | null;          // null: sin perdidas (o sin operaciones)
  expectativa: number | null;              // por operacion, en dinero
  expectativaR: number | null;             // por operacion, en R
  conR: number;                            // operaciones con R (SL inicial conocido)
  mejor: number | null; peor: number | null;
  rachaGanadora: number; rachaPerdedora: number; rachaActual: number;   // actual: + ganando, - perdiendo
  costos: number; minutosMedio: number | null;
  caidaMax: number; caidaMaxPct: number;   // del balance, desde un maximo
  conSl: number | null;                    // % con SL desde la entrada
  porMercado: { simbolo: string; operaciones: number; neto: number; pctGanadoras: number }[];
  porMotivo: Record<Motivo, number>;
  porDiaSemana: { operaciones: number; neto: number }[];   // 0 = lunes (hora local)
  porHora: { operaciones: number; neto: number }[];        // hora local de la entrada
  distribucionR: { rotulo: string; n: number; desde: number }[];
}

const TRAMOS_R: [number, number, string][] = [
  [-Infinity, -1.5, "< −1,5"], [-1.5, -1, "−1,5 a −1"], [-1, -0.5, "−1 a −0,5"], [-0.5, 0, "−0,5 a 0"],
  [0, 0.5, "0 a 0,5"], [0.5, 1, "0,5 a 1"], [1, 2, "1 a 2"], [2, 3, "2 a 3"], [3, Infinity, "> 3"],
];

export function metricas(ops: Operacion[], curva: { t: number; balance: number }[] = []): Metricas {
  const n = ops.length;
  const gan = ops.filter((o) => o.resultado > 0);
  const per = ops.filter((o) => o.resultado < 0);
  const ganado = r2(suma(gan.map((o) => o.resultado)));
  const perdido = r2(-suma(per.map((o) => o.resultado)));
  const neto = r2(suma(ops.map((o) => o.resultado)));
  const conR = ops.filter((o) => o.r !== null);
  // Rachas, en orden de cierre.
  let rg = 0, rp = 0, actual = 0;
  for (const o of ops) {
    if (o.resultado > 0) actual = actual > 0 ? actual + 1 : 1;
    else if (o.resultado < 0) actual = actual < 0 ? actual - 1 : -1;
    rg = Math.max(rg, actual);
    rp = Math.max(rp, -actual);
  }
  // Caida maxima del balance desde su maximo.
  let pico = -Infinity, caida = 0, caidaPct = 0;
  for (const p of curva) {
    pico = Math.max(pico, p.balance);
    if (pico - p.balance > caida) { caida = pico - p.balance; caidaPct = pico > 0 ? (caida / pico) * 100 : 0; }
  }
  const mercados = new Map<string, Operacion[]>();
  for (const o of ops) mercados.set(o.simbolo, [...(mercados.get(o.simbolo) ?? []), o]);
  const porMotivo: Record<Motivo, number> = { sl: 0, tp: 0, manual: 0, stop_out: 0, otro: 0 };
  for (const o of ops) porMotivo[o.cerradaPor]++;
  const porDiaSemana = Array.from({ length: 7 }, () => ({ operaciones: 0, neto: 0 }));
  const porHora = Array.from({ length: 24 }, () => ({ operaciones: 0, neto: 0 }));
  for (const o of ops) {
    const f = new Date(o.apertura);
    const dia = porDiaSemana[(f.getDay() + 6) % 7];
    dia.operaciones++; dia.neto = r2(dia.neto + o.resultado);
    const h = porHora[f.getHours()];
    h.operaciones++; h.neto = r2(h.neto + o.resultado);
  }
  return {
    operaciones: n, ganadas: gan.length, perdidas: per.length,
    pctGanadoras: n ? Math.round((gan.length / n) * 1000) / 10 : null,
    neto, ganado, perdido,
    gananciaMedia: gan.length ? r2(ganado / gan.length) : null,
    perdidaMedia: per.length ? r2(perdido / per.length) : null,
    factorBeneficio: perdido > 0 ? Math.round((ganado / perdido) * 100) / 100 : null,
    expectativa: n ? r2(neto / n) : null,
    expectativaR: conR.length ? Math.round((suma(conR.map((o) => o.r!)) / conR.length) * 100) / 100 : null,
    conR: conR.length,
    mejor: n ? Math.max(...ops.map((o) => o.resultado)) : null,
    peor: n ? Math.min(...ops.map((o) => o.resultado)) : null,
    rachaGanadora: rg, rachaPerdedora: rp, rachaActual: actual,
    costos: r2(suma(ops.map((o) => o.costos))),
    minutosMedio: n ? Math.round(suma(ops.map((o) => o.minutos)) / n) : null,
    caidaMax: r2(caida), caidaMaxPct: Math.round(caidaPct * 100) / 100,
    conSl: n ? Math.round((ops.filter((o) => o.slInicial !== null).length / n) * 1000) / 10 : null,
    porMercado: [...mercados].map(([simbolo, os]) => ({
      simbolo, operaciones: os.length, neto: r2(suma(os.map((o) => o.resultado))),
      pctGanadoras: Math.round((os.filter((o) => o.resultado > 0).length / os.length) * 1000) / 10,
    })).sort((a, b) => b.neto - a.neto),
    porMotivo, porDiaSemana, porHora,
    distribucionR: TRAMOS_R.map(([a, b, rotulo]) => ({
      rotulo, desde: a, n: conR.filter((o) => o.r! >= a && o.r! < b).length,
    })),
  };
}

// --------------------------------------------------------------------- dias

export interface Dia {
  fecha: string;              // el dia de la firma (PROP_ZONA)
  operaciones: number;        // cerradas ese dia
  ganadas: number;
  resultado: number;          // todo lo realizado ese dia (incluye cierres parciales y comisiones)
  balance: number;            // al terminar el dia
  pctLimite: number | null;   // de la perdida maxima diaria, cuanto se uso con lo cerrado
}

export function porDia(deals: Deal[], ops: Operacion[], o: {
  aUtc: (d: Deal) => number; zona: string; limiteDiario: number | null; balanceActual: number | null;
}): Dia[] {
  const curva = curvaBalance(deals, o.aUtc, o.balanceActual);
  const dias = new Map<string, Dia>();
  const dia = (f: string) => {
    let x = dias.get(f);
    if (!x) { x = { fecha: f, operaciones: 0, ganadas: 0, resultado: 0, balance: 0, pctLimite: null }; dias.set(f, x); }
    return x;
  };
  for (const d of deals) {
    if (!esTrade(d)) continue;
    const e = efectivo(d);
    if (e) { const x = dia(fechaEn(o.aUtc(d), o.zona)); x.resultado = r2(x.resultado + e); }
  }
  for (const op of ops) {
    const x = dia(fechaEn(op.cierre, o.zona));
    x.operaciones++;
    if (op.resultado > 0) x.ganadas++;
  }
  // Balance al cierre de cada dia: el ultimo punto de la curva hasta ese dia.
  for (const p of curva) {
    const x = dias.get(fechaEn(p.t, o.zona));
    if (x) x.balance = p.balance;
  }
  const lista = [...dias.values()].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  let ultimo = curva.length ? curva[0].balance : 0;
  for (const x of lista) {
    if (!x.balance) x.balance = ultimo;
    ultimo = x.balance;
    x.pctLimite = o.limiteDiario && x.resultado < 0 ? Math.round((-x.resultado / o.limiteDiario) * 1000) / 10 : o.limiteDiario ? 0 : null;
  }
  return lista;
}

// ----------------------------------------------------- riesgo de la cuenta

export interface Limite { limite: number; usado: number; piso: number; pct: number }

export interface Riesgo {
  inicial: number;
  origenInicial: "env" | "historial";
  exacto: boolean;              // false: sin historial, el dia se mide desde el balance actual
  zona: string;
  inicioDia: number;            // ms UTC
  proximoCorte: number;         // ms UTC: cuando arranca el dia siguiente de la firma
  balanceInicioDia: number;
  balance: number;
  equity: number;
  diaria: Limite | null;
  maxima: Limite | null;
  disponible: number | null;    // lo que se puede perder antes del primer limite
  abierto: number | null;       // lo que se pierde (desde ahora) si todo lo abierto toca su SL
  sinSl: number;                // posiciones sin SL: su riesgo no tiene tope
  siTocaSl: number | null;      // lo que quedaria disponible si todo toca SL
}

export function riesgoCuenta(o: {
  deals: Deal[] | null; aUtc: (d: Deal) => number;
  balance: number; equity: number; posiciones: any[];
  inicial: number | null; origenInicial: "env" | "historial";
  diariaPct: number; maximaPct: number; zona: string; ahora?: number;
}): Riesgo | null {
  if (!o.inicial || !(o.inicial > 0)) return null;
  const ahora = o.ahora ?? Date.now();
  const desde = inicioDia(ahora, o.zona);
  const proximo = inicioDia(desde + 26 * 3600_000, o.zona);
  // El balance al empezar el dia: el de ahora menos lo que se movio desde la medianoche.
  const hoy = (o.deals ?? []).filter((d) => o.aUtc(d) >= desde);
  const balanceInicioDia = r2(o.balance - suma(hoy.map(efectivo)));
  const limite = (pct: number, base: number): Limite | null => {
    if (!(pct > 0)) return null;
    const tope = r2((o.inicial! * pct) / 100);
    const usado = r2(Math.max(0, base - o.equity));
    return { limite: tope, usado, piso: r2(base - tope), pct: Math.min(100, Math.round((usado / tope) * 1000) / 10) };
  };
  const diaria = limite(o.diariaPct, balanceInicioDia);
  const maxima = limite(o.maximaPct, o.inicial);
  const margenes = [diaria, maxima].filter(Boolean).map((l) => o.equity - l!.piso);
  const disponible = margenes.length ? r2(Math.max(0, Math.min(...margenes))) : null;
  // Lo que se pierde desde ahora si cada posicion toca su SL (al precio de cierre: bid o ask).
  let abierto = 0, sinSl = 0;
  for (const p of o.posiciones) {
    const compra = String(p.tipo).startsWith("buy");
    const precio = compra ? p.bid : p.ask;
    if (!(p.sl > 0)) { sinSl++; continue; }
    if (!(precio > 0) || !(p.por_punto > 0)) continue;
    abierto += Math.max(0, (compra ? precio - p.sl : p.sl - precio) * p.por_punto * p.volumen);
  }
  return {
    inicial: o.inicial, origenInicial: o.origenInicial, exacto: o.deals !== null,
    zona: o.zona, inicioDia: desde, proximoCorte: proximo,
    balanceInicioDia, balance: o.balance, equity: o.equity,
    diaria, maxima, disponible,
    abierto: r2(abierto), sinSl,
    siTocaSl: disponible !== null ? r2(disponible - abierto) : null,
  };
}

/** El riesgo por operacion del plan, en USD enteros: lo que queda hasta el primer
 *  limite de la cuenta (despues de lo abierto) repartido en `aguantar` SL seguidos, y
 *  como mucho `pct` del balance. Sube con las ganancias y baja con las perdidas; sin
 *  `aguantar` (0) es solo el % del balance. */
export interface RiesgoPlan { usd: number; colchon: number | null; aguantar: number; tope: number }

export function riesgoPlan(r: Riesgo | null, balance: number | null, pct: number, aguantar: number): RiesgoPlan | null {
  const tope = balance && balance > 0 && pct > 0 ? (balance * pct) / 100 : Infinity;
  const queda = r?.siTocaSl ?? r?.disponible ?? null;
  const colchon = queda === null ? null : r2(Math.max(0, queda));
  const porColchon = aguantar > 0 && colchon !== null ? colchon / aguantar : Infinity;
  const usd = Math.min(tope, porColchon);
  if (!Number.isFinite(usd)) return null;
  return { usd: Math.floor(usd), colchon, aguantar: colchon !== null ? aguantar : 0, tope: Number.isFinite(tope) ? Math.floor(tope) : 0 };
}

// ------------------------------------------- el primer SL de cada posicion

/** Recuerda el primer SL que tuvo cada posicion (en datos/sl-iniciales.json). */
export class SlIniciales {
  private datos: Record<string, number> | null = null;
  private ruta = () => join(config.DATOS, "sl-iniciales.json");

  private cargar(): Record<string, number> {
    if (this.datos) return this.datos;
    try { this.datos = JSON.parse(readFileSync(this.ruta(), "utf8")); } catch { this.datos = {}; }
    return this.datos!;
  }

  observar(posiciones: any[]): void {
    const d = this.cargar();
    let cambio = false;
    for (const p of posiciones) {
      const t = String(p.ticket), sl = Number(p.sl) || 0;
      if (sl > 0 && !(t in d)) { d[t] = sl; cambio = true; }
    }
    if (!cambio) return;
    // Solo las ultimas 3000: alcanza para cualquier historial exportado.
    const claves = Object.keys(d);
    if (claves.length > 3000) for (const k of claves.slice(0, claves.length - 3000)) delete d[k];
    try {
      mkdirSync(config.DATOS, { recursive: true });
      writeFileSync(this.ruta(), JSON.stringify(d));
    } catch (exc) {
      log.warn(`No se pudo guardar ${this.ruta()}: ${exc}`);
    }
  }

  get(ticket: number): number | null {
    return this.cargar()[String(ticket)] ?? null;
  }
}
