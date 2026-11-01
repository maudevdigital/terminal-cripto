/* Creditos demo: una cuenta virtual para practicar con los precios de MT5.
 *
 * Vive solo aca y en DATOS/demo.json. No recibe la Operativa ni escribe para el EA
 * Operador, asi que nada de esto puede llegar a la cuenta real.
 *
 * Tiene las reglas de la evaluacion: perdida diaria y total sobre el equity. Si se toca
 * un limite se cierra todo y la cuenta queda perdida hasta recargar. El SL es
 * obligatorio al abrir. Lo demas no se bloquea, se mide: reentradas a menos de 5
 * minutos de la salida, SL ampliados, BE antes de +1 R y cierres a mano.
 *
 * Cada operacion tambien se sigue "sin tocar", con su SL y su TP originales: asi se ve
 * cuanto cuesta (o cuanto salva) moverlos o salirse antes. Sin comisiones ni swap: el
 * costo es el spread, y el SL se llena al precio que haya en ese momento. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { fechaEn, inicioDia, riesgoPlan, type RiesgoPlan } from "./historial.ts";

export interface Cotizacion { bid: number; ask: number; porPunto: number; volMin: number; volPaso: number; volMax: number; abierto: boolean }
export type Cotizar = (broker: string) => Cotizacion | null;
export type Resultado = { ok: boolean; mensaje: string; id?: string };

export interface OpDemo {
  id: string; cuenta: number; simbolo: string; broker: string; lado: 1 | -1; tipo: "mercado" | "limite";
  lotes: number; valorPunto: number; riesgoUsd: number; riesgoMaxUsd: number;
  entrada: number; sl: number; slInicial: number; tp: number | null; tpInicial: number | null;
  estado: "pendiente" | "abierta" | "cerrada" | "cancelada";
  creada: number; entro: number | null; cerrada: number | null; salida: number | null;   // tiempos en segundos UTC
  final: "sl" | "tp" | "be" | "manual" | "limite" | null; usd: number | null; r: number | null;
  reentradaSeg: number | null; slAmpliado: boolean; beTemprano: boolean;
  sombra: { final: "sl" | "tp"; usd: number } | null;   // lo que habria pasado con el SL y el TP originales
}

interface Cuenta {
  inicial: number; balance: number; balanceDia: number; dia: number;
  perdida: string | null; numero: number; recargas: number; ops: OpDemo[];
}

const REENTRADA_SEG = 5 * 60;
const SOMBRA_SEG = 14 * 86_400;
const VISIBLES = 15;
const r2 = (x: number) => Math.round(x * 100) / 100;
const nuevoId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const n2 = (x: number) => new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
const nivel = (x: number) => new Intl.NumberFormat("es-CL", { maximumFractionDigits: 8 }).format(x);
const positivo = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Precio al que se cierra: la compra vende al bid; la venta compra al ask. */
const cierre = (op: OpDemo, q: Cotizacion) => (op.lado === 1 ? q.bid : q.ask);
const usdDe = (op: OpDemo, precio: number) => op.lotes * op.valorPunto * (precio - op.entrada) * op.lado;
const riesgoPts = (op: OpDemo) => Math.abs(op.entrada - op.slInicial);

/** Si un SL o un TP puede ponerse: del lado correcto de la referencia. */
function problemaNiveles(lado: 1 | -1, ref: number, sl: unknown, tp: unknown): string | null {
  if (!positivo(sl)) return "El SL es obligatorio.";
  if (lado === 1 ? sl >= ref : sl <= ref) return `El SL tiene que ir ${lado === 1 ? "bajo" : "sobre"} ${nivel(ref)}.`;
  if (tp !== null && tp !== undefined && !positivo(tp)) return "Revisa el TP.";
  if (positivo(tp) && (lado === 1 ? tp <= ref : tp >= ref)) return `El TP tiene que ir ${lado === 1 ? "sobre" : "bajo"} ${nivel(ref)}.`;
  return null;
}

export class Demo {
  ruta: string;
  zona: string;
  diariaPct: number;
  maximaPct: number;
  c: Cuenta | null = null;

  constructor(ruta = join(config.DATOS, "demo.json"), { zona = config.PROP_ZONA, diariaPct = config.PROP_DIARIA_PCT, maximaPct = config.PROP_MAXIMA_PCT } = {}) {
    this.ruta = ruta;
    this.zona = zona;
    this.diariaPct = diariaPct;
    this.maximaPct = maximaPct;
    try { if (existsSync(ruta)) this.c = JSON.parse(readFileSync(ruta, "utf8")); } catch { this.c = null; }
  }

  private guardar(): void {
    mkdirSync(dirname(this.ruta), { recursive: true });
    const tmp = `${this.ruta}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.c));
    renameSync(tmp, this.ruta);
  }

  private pisoTotal(): number { return this.c!.inicial * (1 - this.maximaPct / 100); }
  private pisoDia(): number { return this.c!.balanceDia - this.c!.inicial * this.diariaPct / 100; }

  /** Empieza o recarga la cuenta. Lo anterior queda en el archivo, pero ya no suma. */
  empezar(inicial: number, balance: number, ahora = Date.now()): Resultado {
    if (!positivo(inicial) || !positivo(balance)) return { ok: false, mensaje: "Faltan los créditos para empezar." };
    if (balance <= inicial * (1 - this.maximaPct / 100)) return { ok: false, mensaje: "Ese balance ya está bajo el límite total." };
    const antes = this.c;
    this.c = {
      inicial, balance, balanceDia: balance, dia: inicioDia(ahora, this.zona), perdida: null,
      numero: (antes?.numero ?? 0) + 1, recargas: antes ? antes.recargas + 1 : 0,
      ops: (antes?.ops ?? []).filter((o) => o.estado === "cerrada").slice(-500),
    };
    this.guardar();
    return { ok: true, mensaje: `Cuenta demo con ${n2(balance)} de créditos.` };
  }

  /** Borra la cuenta y todo su historial. */
  borrar(): Resultado {
    this.c = null;
    try { rmSync(this.ruta, { force: true }); } catch { /* ya no esta */ }
    return { ok: true, mensaje: "Cuenta demo borrada." };
  }

  private actuales(): OpDemo[] { return this.c ? this.c.ops.filter((o) => o.cuenta === this.c!.numero) : []; }

  abrir(p: { symbol: string; broker: string; lado: unknown; tipo: unknown; riesgo: unknown; precio?: unknown; sl: unknown; tp?: unknown }, q: Cotizacion | null, ahora = Date.now()): Resultado {
    const c = this.c;
    if (!c) return { ok: false, mensaje: "Primero elige con qué cuenta empezar." };
    if (c.perdida) return { ok: false, mensaje: "Esta cuenta demo se perdió: recarga los créditos." };
    if (!q) return { ok: false, mensaje: "MT5 no está publicando ese mercado ahora." };
    if (!q.abierto) return { ok: false, mensaje: "Mercado cerrado: se podrá practicar cuando abra." };
    const lado = p.lado === 1 || p.lado === "buy" ? 1 : p.lado === -1 || p.lado === "sell" ? -1 : 0;
    if (!lado) return { ok: false, mensaje: "Elige comprar o vender." };
    const tipo = p.tipo === "limite" ? "limite" : "mercado";
    const entrada = tipo === "mercado" ? (lado === 1 ? q.ask : q.bid) : Number(p.precio);
    if (!positivo(entrada)) return { ok: false, mensaje: "Falta el precio de la orden límite." };
    if (tipo === "limite" && (lado === 1 ? entrada >= q.ask : entrada <= q.bid)) {
      return { ok: false, mensaje: `Una ${lado === 1 ? "compra" : "venta"} límite va ${lado === 1 ? "bajo" : "sobre"} el precio actual.` };
    }
    const sl = Number(p.sl), tp = positivo(Number(p.tp)) ? Number(p.tp) : null;
    // A mercado, el SL y el TP tambien tienen que quedar bien contra el precio de cierre.
    const problema = problemaNiveles(lado, entrada, sl, tp) ?? (tipo === "mercado" ? problemaNiveles(lado, lado === 1 ? q.bid : q.ask, sl, tp) : null);
    if (problema) return { ok: false, mensaje: problema };
    const riesgo = Number(p.riesgo);
    if (!positivo(riesgo)) return { ok: false, mensaje: "Falta el riesgo en USD." };
    const pts = Math.abs(entrada - sl);
    const pasos = Math.floor(riesgo / (pts * q.porPunto) / q.volPaso + 1e-9);
    const lotes = Math.min(q.volMax, Number((pasos * q.volPaso).toFixed(8)));
    if (lotes < q.volMin) {
      return { ok: false, mensaje: `Con ese SL, el mínimo (${nivel(q.volMin)} lotes) arriesga ${n2(q.volMin * pts * q.porPunto)} USD: acerca el SL o sube el riesgo.` };
    }
    const t = Math.floor(ahora / 1000);
    const salidas = this.actuales().filter((o) => o.broker === p.broker && o.cerrada !== null && o.entro !== null).map((o) => o.cerrada!);
    const espera = salidas.length ? t - Math.max(...salidas) : null;
    const riesgoUsd = r2(lotes * q.porPunto * pts);
    const op: OpDemo = {
      id: nuevoId(), cuenta: c.numero, simbolo: p.symbol, broker: p.broker, lado, tipo, lotes, valorPunto: q.porPunto,
      riesgoUsd, riesgoMaxUsd: riesgoUsd, entrada, sl, slInicial: sl, tp, tpInicial: tp,
      estado: tipo === "mercado" ? "abierta" : "pendiente", creada: t, entro: tipo === "mercado" ? t : null,
      cerrada: null, salida: null, final: null, usd: null, r: null,
      reentradaSeg: espera !== null && espera < REENTRADA_SEG ? espera : null, slAmpliado: false, beTemprano: false, sombra: null,
    };
    c.ops.push(op);
    this.guardar();
    return { ok: true, id: op.id, mensaje: `Demo: ${lado === 1 ? "compra" : "venta"} de ${nivel(lotes)} lotes, riesgo ${n2(riesgoUsd)} USD.` };
  }

  /** Mover el SL o el TP no se bloquea (ni ampliar el SL): queda anotado. */
  modificar(p: { id: unknown; sl: unknown; tp?: unknown }, q: Cotizacion | null): Resultado {
    const op = this.actuales().find((o) => o.id === p.id && (o.estado === "abierta" || o.estado === "pendiente"));
    if (!op) return { ok: false, mensaje: "Esa operación demo ya no está abierta." };
    if (op.estado === "abierta" && !q?.abierto) return { ok: false, mensaje: "Mercado cerrado: se podrá mover cuando abra." };
    const sl = Number(p.sl), tp = positivo(Number(p.tp)) ? Number(p.tp) : null;
    const problema = problemaNiveles(op.lado, op.estado === "abierta" ? cierre(op, q!) : op.entrada, sl, tp);
    if (problema) return { ok: false, mensaje: problema };
    const inicial = riesgoPts(op);
    const riesgoNuevo = (op.entrada - sl) * op.lado;   // positivo: del lado de la perdida
    if (riesgoNuevo > inicial + 1e-9) {
      op.slAmpliado = true;
      op.riesgoMaxUsd = Math.max(op.riesgoMaxUsd, r2(op.lotes * op.valorPunto * riesgoNuevo));
    }
    // A break even (o mas) antes de ir ganando 1 R.
    const yaEnBe = (op.entrada - op.sl) * op.lado <= inicial * 0.1;
    if (op.estado === "abierta" && riesgoNuevo <= inicial * 0.1 && !yaEnBe
        && (cierre(op, q!) - op.entrada) * op.lado < inicial) op.beTemprano = true;
    op.sl = sl;
    op.tp = tp;
    this.guardar();
    return { ok: true, mensaje: "SL y TP actualizados en la demo." };
  }

  private liquidar(op: OpDemo, precio: number, t: number, motivo: "sl" | "tp" | "manual" | "limite"): void {
    const usd = r2(usdDe(op, precio));
    const r = riesgoPts(op) > 0 ? ((precio - op.entrada) * op.lado) / riesgoPts(op) : 0;
    Object.assign(op, { estado: "cerrada", salida: precio, cerrada: t, usd, r, final: motivo === "sl" && Math.abs(r) < 0.05 ? "be" : motivo });
    this.c!.balance = r2(this.c!.balance + usd);
  }

  /** Cierra a mercado una abierta, o cancela una limite. */
  cerrar(id: unknown, q: Cotizacion | null, ahora = Date.now()): Resultado {
    const op = this.actuales().find((o) => o.id === id && (o.estado === "abierta" || o.estado === "pendiente"));
    if (!op) return { ok: false, mensaje: "Esa operación demo ya no está abierta." };
    const t = Math.floor(ahora / 1000);
    if (op.estado === "pendiente") {
      op.estado = "cancelada";
      op.cerrada = t;
      this.guardar();
      return { ok: true, mensaje: "Límite cancelada." };
    }
    if (!q?.abierto) return { ok: false, mensaje: "Mercado cerrado: se podrá cerrar cuando abra." };
    this.liquidar(op, cierre(op, q), t, "manual");
    this.guardar();
    return { ok: true, mensaje: `Cerrada en ${n2(op.usd!)} USD.` };
  }

  /** Con cada precio: limites, SL, TP, el seguimiento "sin tocar" y los limites de la cuenta. */
  tick(cotizar: Cotizar, ahora = Date.now()): string[] {
    const c = this.c;
    if (!c) return [];
    const t = Math.floor(ahora / 1000), avisos: string[] = [];
    let cambio = false;
    const dia = inicioDia(ahora, this.zona);
    if (dia !== c.dia) { c.dia = dia; c.balanceDia = c.balance; cambio = true; }
    for (const op of this.actuales()) {
      const q = cotizar(op.broker);
      if (!q?.abierto) continue;
      if (op.estado === "pendiente" && (op.lado === 1 ? q.ask <= op.entrada : q.bid >= op.entrada)) {
        op.estado = "abierta";
        op.entro = t;
        cambio = true;
      }
      if (op.estado === "abierta") {
        const p = cierre(op, q);
        const tocaSl = op.lado === 1 ? p <= op.sl : p >= op.sl;
        const tocaTp = op.tp !== null && (op.lado === 1 ? p >= op.tp : p <= op.tp);
        if (tocaSl || tocaTp) {
          this.liquidar(op, tocaSl ? p : op.tp!, t, tocaSl ? "sl" : "tp");
          avisos.push(`Demo: ${op.broker} ${op.final} ${op.usd} USD`);
          cambio = true;
        }
      }
      if (op.entro !== null && !op.sombra && t - op.entro <= SOMBRA_SEG) {
        const p = cierre(op, q);
        if (op.lado === 1 ? p <= op.slInicial : p >= op.slInicial) { op.sombra = { final: "sl", usd: r2(usdDe(op, op.slInicial)) }; cambio = true; }
        else if (op.tpInicial !== null && (op.lado === 1 ? p >= op.tpInicial : p <= op.tpInicial)) { op.sombra = { final: "tp", usd: r2(usdDe(op, op.tpInicial)) }; cambio = true; }
      }
    }
    if (!c.perdida) {
      const eq = this.equity(cotizar);
      const piso = Math.max(this.pisoTotal(), this.pisoDia());
      if (eq <= piso) {
        for (const op of this.actuales()) {
          if (op.estado === "pendiente") { op.estado = "cancelada"; op.cerrada = t; }
          const q = cotizar(op.broker);
          if (op.estado === "abierta" && q) this.liquidar(op, cierre(op, q), t, "limite");
        }
        c.perdida = this.pisoDia() > this.pisoTotal() ? "Tocaste el límite de pérdida diaria." : "Tocaste el límite de pérdida total.";
        avisos.push(`Demo: ${c.perdida}`);
        cambio = true;
      }
    }
    if (cambio) this.guardar();
    return avisos;
  }

  private equity(cotizar: Cotizar): number {
    let flotante = 0;
    for (const op of this.actuales()) {
      const q = op.estado === "abierta" ? cotizar(op.broker) : null;
      if (q) flotante += usdDe(op, cierre(op, q));
    }
    return this.c!.balance + flotante;
  }

  /** Lo que ve el panel y el grafico. */
  vista(cotizar: Cotizar, ahora = Date.now()): any {
    const c = this.c;
    if (!c) return { iniciada: false };
    const ops = this.actuales();
    const vivas = ops.filter((o) => o.estado === "abierta" || o.estado === "pendiente").map((o) => {
      const q = o.estado === "abierta" ? cotizar(o.broker) : null;
      const usd = q ? r2(usdDe(o, cierre(o, q))) : null;
      return { ...o, flotanteUsd: usd, flotanteR: q && riesgoPts(o) > 0 ? ((cierre(o, q) - o.entrada) * o.lado) / riesgoPts(o) : null };
    });
    const equity = r2(this.equity(cotizar));
    const piso = Math.max(this.pisoTotal(), this.pisoDia());
    const disponible = r2(Math.max(0, equity - piso));
    let abierto = 0;
    for (const o of vivas) {
      const q = o.estado === "abierta" ? cotizar(o.broker) : null;
      if (q) abierto += Math.max(0, o.lotes * o.valorPunto * (cierre(o, q) - o.sl) * o.lado);
    }
    const plan: RiesgoPlan | null = riesgoPlan({ disponible, siTocaSl: r2(disponible - abierto) } as any, c.balance, config.RIESGO_PCT, config.RIESGO_AGUANTAR);
    return {
      iniciada: true, inicial: c.inicial, balance: c.balance, equity, flotante: r2(equity - c.balance), objetivo: r2(c.inicial * 1.1),
      disponible, pisoTotal: r2(this.pisoTotal()), pisoDia: r2(this.pisoDia()), perdida: c.perdida, recargas: c.recargas, plan,
      ops: [...vivas, ...ops.filter((o) => o.estado === "cerrada").sort((a, b) => b.cerrada! - a.cerrada!).slice(0, VISIBLES)],
      resumen: this.resumen(ahora),
    };
  }

  /** Resultado y conducta de la cuenta actual. */
  resumen(ahora = Date.now()) {
    const ops = this.actuales().filter((o) => o.estado !== "cancelada");
    const cerradas = ops.filter((o) => o.estado === "cerrada");
    const ganadas = cerradas.filter((o) => o.r! > 0.05).length, perdidas = cerradas.filter((o) => o.r! < -0.05).length;
    const conSombra = cerradas.filter((o) => o.sombra);
    const porDia = new Map<string, number>();
    for (const o of ops) {
      const d = fechaEn((o.entro ?? o.creada) * 1000, this.zona);
      porDia.set(d, (porDia.get(d) ?? 0) + 1);
    }
    return {
      n: cerradas.length, ganadas, perdidas, be: cerradas.length - ganadas - perdidas,
      usd: r2(cerradas.reduce((s, o) => s + o.usd!, 0)), r: Math.round(cerradas.reduce((s, o) => s + o.r!, 0) * 100) / 100,
      reentradas: ops.filter((o) => o.reentradaSeg !== null).length,
      slAmpliados: ops.filter((o) => o.slAmpliado).length,
      beTempranos: ops.filter((o) => o.beTemprano).length,
      aMano: cerradas.filter((o) => o.final === "manual").length,
      sinTocar: { n: conSombra.length, real: r2(conSombra.reduce((s, o) => s + o.usd!, 0)), usd: r2(conSombra.reduce((s, o) => s + o.sombra!.usd, 0)) },
      dias: porDia.size, diasUna: [...porDia.values()].filter((x) => x === 1).length,
      hoy: porDia.get(fechaEn(ahora, this.zona)) ?? 0,
    };
  }
}
