/* Nucleo del terminal: mantiene las velas vivas y arma lo que ve la interfaz:
 * las series del grafico de la temporalidad elegida (con ADX, squeeze y volumen)
 * y lo de MT5.
 *
 * Fuentes: Binance para cripto (spot) y el oro (su perpetuo), CoinGecko para
 * USDT.D y, para los indices, las velas del CFD en MT5 cuando el puente esta vivo
 * (si no, Yahoo Finance). MT5 ademas da la cotizacion del broker y las posiciones. */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BinanceRest, combinedStream, eventToCandle, futuresStream, velaValida } from "./binance.ts";
import { BinanceCuenta } from "./binanceCuenta.ts";
import type { Candle, Ticker } from "./binance.ts";
import { config, esPerpetuo, esYahoo, mercados, yahoo } from "./config.ts";
import { ampliaSl, cargarVigia, evaluar as evaluarFreno, guardarVigia, PausaReal, planSl, vigilar, type Freno, type PosicionSl, type Vigia } from "./freno.ts";
import { agrupar as agruparVelas, Indices } from "./indices.ts";
import * as ind from "./indicators.ts";
import { lanzador } from "./lanzador.ts";
import { Operativa, pipDe } from "./operativa.ts";
import { Demo, type Cotizar } from "./demo.ts";
import { Diario } from "./diario.ts";
import { Calendario, type Evento } from "./calendario.ts";
import { getLogger } from "./log.ts";
import * as mt5 from "./mt5.ts";
import { horario } from "./horario.ts";
import { planCorte, type Abierta } from "./corte.ts";
import { riesgoPlan } from "./historial.ts";
import { Ejecuciones, motivoMT5 } from "./ejecuciones.ts";
import { agruparA, base as baseDe } from "./temporalidades.ts";
import { agrupar, Dominancia, SIMBOLO as USDTD } from "./usdtd.ts";

const log = getLogger("market");

const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
const isNum = (v: any) => typeof v === "number" && Number.isFinite(v);

// La historia larga del mercado del replay que exporta el puente a pedido (la arma
// con las velas de 1 minuto que MT5 ya tiene en el disco): temporalidad del
// grafico -> la de MT5 y cuantas velas. En 1 minuto el tope son las 100.000 de
// "Maximo de barras en el grafico" de MT5 (unos 3 meses); en 5 minutos, 1,4 anos.
const LARGAS: Record<string, [string, number]> = {
  "1m": ["M1", 100_000], "5m": ["M5", 100_000], "1h": ["H1", 30_000], "4h": ["H4", 8_000], "1d": ["D1", 2_000],
};

/** Dos series del mismo mercado en una, por hora (la segunda pisa a la primera). */
function juntar(a: Candle[] | null | undefined, b: Candle[] | null | undefined): Candle[] {
  const m = new Map<number, Candle>();
  for (const x of a ?? []) m.set(x.t, x);
  for (const x of b ?? []) m.set(x.t, x);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/** Velas compactas para mandar a la interfaz: [t, o, h, l, c, v]. */
const compactar = (v: Candle[]) => v.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]);
const ultimo = <T>(a: T[]): T => a[a.length - 1];
type GraficoCache = { fuente: Candle[]; clave: string; crear: (tail: number | null) => any; salidas: Map<number | null, any> };
type RevisionVista = { origen: string; fuente: Candle[]; primera: number; ultima: number; longitud: number; velas: Map<number, string>; revision: number };

// Colores del panel inferior: los del indicador en TradingView (paleta oscura).
const SQZ = {
  subeFuerte: "#00E676", subeDebil: "#1B8A3A", bajaFuerte: "#FF1744", bajaDebil: "#8B0000",
  comprimido: "#FF9800", liberado: "#787B86", neutro: "#2962FF",
  adxSube: "#E8EAED", adxBaja: "#787B86",
};

function linea(values: number[], times: number[]) {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < times.length; i++) if (isNum(values[i])) out.push({ time: times[i], value: values[i] });
  return out;
}

/** Buffers de velas por (par, temporalidad), alimentados por REST + WebSocket. */
export class MarketHub {
  rest = new BinanceRest();
  broker = new mt5.BrokerBridge();
  velasBroker = new mt5.VelasBroker(this.broker);
  operativa = new Operativa(this.broker);
  // La cuenta de futuros de Binance, solo para mirar (saldo y posiciones).
  binance = new BinanceCuenta();
  // Lo que les pasa a las operaciones (abrir, SL, TP, cerrar, mover), para que la terminal suene.
  ejecuciones = new Ejecuciones();
  demo = new Demo();
  pausaReal = new PausaReal(join(config.DATOS, "pausa-real.json"), config.FRENO_PAUSA_SALIR_MIN);
  // Historial de la cuenta, cabina de riesgo de la cuenta de fondeo y Google Sheets.
  diario = new Diario(this.broker);
  // Calendario economico de FTMO, y las noticias importantes de las proximas 24 h.
  calendario = new Calendario();
  private noticias: Evento[] = [];
  private relojes: ReturnType<typeof setInterval>[] = [];
  // USDT.D no esta en Binance: se reconstruye con CoinGecko y se guarda como un par mas.
  usdtd = new Dominancia(() => this.syncUsdtd());
  candles = new Map<string, Candle[]>();      // "SYMBOL|interval" -> velas
  tickers: Record<string, Ticker> = {};
  indices = new Indices(this);
  streamUp = false;
  lastEventMs = 0;
  private streams = new Map<string, boolean>();
  private eventos = new Map<string, number>();
  private ultimosTrades = new Map<string, { t: number; id: number; precio: number }>();

  private frenoCache: { at: number; valor: Freno | null } = { at: 0, valor: null };
  private largos = new Map<string, { mtime: number; velas: Candle[] }>();
  private profundas = new Map<string, { clave: string; velas: Candle[] }>();
  private extendidas = new Map<string, { clave: string; velas: Candle[]; vivo?: Candle[]; salida?: Candle[] }>();
  private streamsIniciados = new Set<string>();   // el arranque ya trajo todo
  private detenerStream: (() => void) | null = null;
  private detenerPerpetuos: (() => void) | null = null;
  private activo = true;
  private resolverListo!: () => void;
  private listo = new Promise<void>((r) => { this.resolverListo = r; });

  private key(symbol: string, interval: string) { return `${symbol}|${interval}`; }

  // Las temporalidades a medida (10m, 2H...), armadas con su base: se rehacen solo si cambia.
  private aMedida = new Map<string, { fuente: Candle[]; clave: string; velas: Candle[] }>();

  /** Velas de un par. Las de los indices salen de MT5 mientras el puente este vivo.
   *  Una temporalidad a medida se arma con las de su base (temporalidades.ts). */
  serie(symbol: string, interval: string): Candle[] | undefined {
    const b = baseDe(interval, config.INTERVALS);
    if (b) {
      const src = this.serie(symbol, b);
      if (!src?.length) return src;
      const u = src[src.length - 1];
      const clave = `${src.length}|${src[0].t}|${u.t}|${u.o}|${u.h}|${u.l}|${u.c}|${u.v}|${u.vb}|${u.trades}|${u.closed}`;
      const k = `${symbol}|${interval}`;
      const c = this.aMedida.get(k);
      if (c?.fuente === src && c.clave === clave) return c.velas;
      const velas = agruparA(src, interval);
      this.aMedida.set(k, { fuente: src, clave, velas });
      return velas;
    }
    if (this.indiceEnMT5(symbol)) {
      const v = this.velasBroker.serie(symbol, interval);
      if (v) return symbol === config.REPLAY_SIMBOLO ? this.extender(interval, v) : v;
    }
    return this.candles.get(this.key(symbol, interval));
  }

  /** En el mercado del replay, 5m, 15m y 30m llegan dos semanas atras o mas: lo que el
   *  puente exporta (1.000 velas) mas, antes, la historia larga de 1 minuto de FTMO
   *  agrupada. Asi se ven las entradas de esta semana y la pasada. */
  private extender(interval: string, vivo: Candle[]): Candle[] {
    const tope: Record<string, number> = { "5m": 4000, "15m": 2000, "30m": 1000 };
    if (!tope[interval] || !vivo.length) return vivo;
    const m1 = this.historiaLarga("1m");
    if (!m1?.length) return vivo;
    // La parte vieja (agrupada) solo cambia si cambia la historia o el inicio de lo vivo.
    const clave = `${m1.length}|${m1[m1.length - 1].t}|${vivo[0].t}`;
    let previa = this.extendidas.get(interval);
    if (previa?.clave !== clave) {
      previa = { clave, velas: agruparVelas(m1.filter((x) => x.t < vivo[0].t), interval).filter((x) => x.t < vivo[0].t) };
      this.extendidas.set(interval, previa);
    }
    if (previa.vivo === vivo && previa.salida) return previa.salida;
    const todo = previa.velas.concat(vivo);
    const velas = todo.length > tope[interval] ? todo.slice(-tope[interval]) : todo;
    previa.vivo = vivo;
    previa.salida = velas;
    return velas;
  }

  /** Si un indice se grafica con las velas del broker (el puente las publica). */
  indiceEnMT5(symbol: string): boolean {
    return config.MT5_VELAS && esYahoo(symbol) && this.velasBroker.serie(symbol, "1d") !== null;
  }

  /** Los tickers, con los indices de MT5 cuando el puente esta vivo. */
  private tickersVivos(): Record<string, Ticker> {
    if (!config.MT5_VELAS) return this.tickers;
    const out = { ...this.tickers };
    for (const symbol of Object.keys(yahoo())) {
      const t = this.velasBroker.ticker(symbol);
      if (t) out[symbol] = t;
    }
    return out;
  }

  /** Apalancamiento de un simbolo del broker: el nocional de un lote sobre su margen. */
  private apalancamientoMT5(q: any): number | null {
    const margen = mt5.num(q?.margin_per_lot) ?? 0, pp = mt5.porPunto(q) ?? 0;
    const px = ((mt5.num(q?.bid) ?? 0) + (mt5.num(q?.ask) ?? 0)) / 2;
    return margen > 0 && pp > 0 && px > 0 ? Math.round(pp * px / margen) : null;
  }

  /** Lo de MT5 para este mercado: la cotizacion del broker, cuanto se separa del
   *  precio del grafico (Binance o el futuro de Yahoo) y las posiciones abiertas.
   *  Sumada a un nivel del grafico, `diferencia` da el nivel en el broker. */
  private bloqueBroker(symbol: string, precio: number) {
    const lanz = { estado: lanzador.estado, detalle: lanzador.detalle };
    const est = this.broker.estado();
    if (!est.available) return { disponible: false, lanzador: lanz };
    const sym = mt5.brokerSymbol(symbol);
    const q = sym ? mt5.buscar(est.symbols as Record<string, any>, sym) : undefined;
    const bid = mt5.num(q?.bid), ask = mt5.num(q?.ask);
    const medio = bid && ask ? (bid + ask) / 2 : null;
    const propio = this.indiceEnMT5(symbol);   // el grafico ya es el del broker
    const offset = Number(est.gmt_offset) || 0;
    const cta = est.account ?? {};
    // Cada posicion lleva lo de su simbolo (pip, valor del punto, cotizacion), asi
    // al editar su SL o TP se ve cuanto representa aunque sea de otro mercado.
    const posicion = (p: any) => {
      const s = mt5.buscar(est.symbols as Record<string, any>, String(p.symbol));
      return {
        ticket: p.ticket, simbolo: p.symbol, tipo: p.type, volumen: mt5.num(p.volume),
        entrada: mt5.num(p.price_open), actual: mt5.num(p.price_current), sl: mt5.num(p.sl) || null, tp: mt5.num(p.tp) || null,
        profit: mt5.num(p.profit), swap: mt5.num(p.swap), desde: p.time ? Number(p.time) - offset : null,
        magic: p.magic ?? null,
        sl_inicial: config.FRENO_SL_INICIAL ? this.diario.slInicial(p.ticket) : null,
        digitos: s?.digits ?? null, pip: s ? pipDe(s) : null, por_punto: s ? mt5.porPunto(s) : null,
        bid: mt5.num(s?.bid), ask: mt5.num(s?.ask), tick: mt5.num(s?.tick_size) || mt5.num(s?.point),
        horario: horario(s?.sesiones, offset),
      };
    };
    const todas = (est.positions ?? []) as any[];
    const pendientes = (est.orders ?? []) as any[];
    const deEste = (p: any) => Boolean(sym) && String(p.symbol).toUpperCase() === sym!.toUpperCase();
    // Lo que el panel Operar necesita del simbolo: precios, contrato y limites.
    const info = q ? {
      symbol: q.symbol, digits: q.digits, point: mt5.num(q.point), bid: mt5.num(q.bid), ask: mt5.num(q.ask), tick_size: mt5.num(q.tick_size), tick_value: mt5.num(q.tick_value),
      contract_size: mt5.num(q.contract_size), volume_min: mt5.num(q.volume_min), volume_step: mt5.num(q.volume_step),
      volume_max: mt5.num(q.volume_max), stops_level: Number(q.stops_level) || 0, swap_long: mt5.num(q.swap_long),
      swap_short: mt5.num(q.swap_short), margin_per_lot: mt5.num(q.margin_per_lot), spread: Number(q.spread) || 0,
      pip: pipDe(q), por_punto: mt5.porPunto(q), apalancamiento: this.apalancamientoMT5(q),
    } : null;
    const riesgo = this.diario.riesgo(est);
    return {
      disponible: true,
      vivo: est.live,
      edad: est.age_s,
      version: est.version,
      // El puente que corre es mas viejo que el instalado: MT5 lo carga al reiniciar.
      desactualizado: est.version < mt5.VERSION_PUENTE,
      lanzador: lanz,
      cuenta: {
        login: String(cta.login ?? ""), servidor: cta.server ?? "", moneda: cta.currency ?? "USD",
        balance: mt5.num(cta.balance), equity: mt5.num(cta.equity), profit: mt5.num(cta.profit),
      },
      simbolo: q?.symbol ?? sym,
      bid, ask,
      digitos: q?.digits ?? null,
      graficoBroker: propio,
      diferencia: propio ? 0 : medio !== null && est.live ? medio - precio : null,
      posiciones: todas.filter(deEste).map(posicion),
      otras: todas.filter((p) => !deEste(p)).map(posicion),
      ordenes: pendientes.filter(deEste).map(posicion),
      otrasOrdenes: pendientes.filter((p) => !deEste(p)).map(posicion),
      info,
      equity: mt5.num(cta.equity),
      margenLibre: mt5.num(cta.margin_free),
      operador: this.operativa.operador(),
      trading: config.TRADING_ACTIVO,
      // Abierto, cuando cierra y cuando reabre (sesiones de MT5): con el mercado
      // cerrado no se cancela ni se modifica nada.
      horario: q ? horario(q.sesiones, offset) : null,
      riesgo,
      riesgoPct: config.RIESGO_PCT,
      riesgoPlan: riesgoPlan(riesgo, mt5.num(cta.balance), config.RIESGO_PCT, config.RIESGO_AGUANTAR),
      freno: this.freno(),
    };
  }

  /** Corte automatico en MT5: a lo abierto sin SL se le pone uno en la perdida de
   *  CORTE_AUTO_USD, por el EA Operador (si ya la paso, no se toca). Cada posicion se
   *  reintenta como mucho cada 30 s. */
  private corteIntentos = new Map<string, number>();
  private async corteAutomatico(): Promise<void> {
    const tope = config.CORTE_AUTO_USD;
    if (!(tope > 0) || !config.TRADING_ACTIVO) return;
    const est = this.broker.estado();
    if (!est.available || !est.live) return;
    const op = this.operativa.operador();
    if (!op.vivo || !op.habilitado) return;
    const offset = Number(est.gmt_offset) || 0;
    const abiertas: (Abierta & { simbolo: string; tp: number; volumen: number })[] = [];
    for (const p of (est.positions ?? []) as any[]) {
      const s = mt5.buscar(est.symbols as Record<string, any>, String(p.symbol));
      if (horario(s?.sesiones, offset)?.abierto === false) continue;   // con el mercado cerrado no se puede tocar
      const porPunto = s ? mt5.porPunto(s) : null;
      const volumen = mt5.num(p.volume) ?? 0;
      abiertas.push({
        id: String(p.ticket), lado: String(p.type).startsWith("buy") ? "buy" : "sell",
        entrada: mt5.num(p.price_open) ?? 0, actual: mt5.num(p.price_current) ?? 0, sl: mt5.num(p.sl) || null,
        resultado: (mt5.num(p.profit) ?? 0) + (mt5.num(p.swap) ?? 0),
        valorPorUnidad: porPunto ? porPunto * volumen : null, tick: mt5.num(s?.tick_size) || mt5.num(s?.point),
        simbolo: String(p.symbol), tp: mt5.num(p.tp) || 0, volumen,
      });
    }
    for (const c of planCorte(abiertas, tope)) {
      if (Date.now() - (this.corteIntentos.get(c.id) ?? 0) < 30_000) continue;
      this.corteIntentos.set(c.id, Date.now());
      const p = abiertas.find((x) => x.id === c.id)!;
      const que = `${p.lado === "buy" ? "compra" : "venta"} ${p.volumen} ${p.simbolo} (ticket ${p.id})`;
      const r = await this.operativa.enviar({ accion: "modificar", ticket: Number(p.id), sl: c.precio, tp: p.tp } as any);
      const texto = `Corte automático: ${que} estaba sin SL. ${r.ok ? `Le puse SL en ${c.precio} (pérdida máxima ${tope} USD).` : `No se pudo poner el SL en ${c.precio}: ${r.mensaje}`}`;
      log.warn(texto);
    }
  }

  /** El freno en MT5 (FRENO_MT5): con el freno bloqueando, las limite que se ponen por
   *  fuera de la terminal se cancelan por el EA Operador. Las posiciones nunca se cierran:
   *  solo queda el aviso en el registro. Lo que ya estaba al activarse no se toca. */
  private rutaVigia = join(config.DATOS, "freno-vigia.json");
  private frenoVigia: Vigia | null = cargarVigia(this.rutaVigia);
  private frenoIntentos = new Map<string, number>();
  private async frenoEnMT5(): Promise<void> {
    const modo = config.FRENO_MT5;
    if (modo === "no" || !config.TRADING_ACTIVO) return;
    const est = this.broker.estado();
    if (!est.available || !est.live) return;
    const abiertos = [
      ...((est.positions ?? []) as any[]).map((x) => ({ x, pendiente: false })),
      ...((est.orders ?? []) as any[]).map((x) => ({ x, pendiente: true })),
    ];
    const f = this.freno();
    const r = vigilar(this.frenoVigia, String(est.account?.login ?? ""), abiertos.map((a) => String(a.x.ticket)), Boolean(f?.bloquea));
    this.frenoVigia = r.estado;
    try { guardarVigia(this.rutaVigia, r.estado); } catch (e) { log.debug(`Freno: ${e}`); }
    if (!r.nuevos.length || !f) return;
    const op = this.operativa.operador();
    const offset = Number(est.gmt_offset) || 0;
    for (const { x, pendiente } of abiertos.filter((a) => r.nuevos.includes(String(a.x.ticket)))) {
      const ticket = String(x.ticket);
      const accion = pendiente && modo === "cancelar" ? "cancelar" : null;
      // Avisar va una vez; cancelar se reintenta cada 30 s (mercado cerrado, Operador apagado).
      const ultimo = this.frenoIntentos.get(ticket);
      if (ultimo !== undefined && (!accion || Date.now() - ultimo < 30_000)) continue;
      const s = mt5.buscar(est.symbols as Record<string, any>, String(x.symbol));
      if (accion && (horario(s?.sesiones, offset)?.abierto === false || !op.vivo || !op.habilitado)) continue;
      this.frenoIntentos.set(ticket, Date.now());
      const tipo = String(x.type).replace("_", " ").replace("buy", "compra").replace("sell", "venta").replace("limit", "límite");
      const que = `${tipo} ${mt5.num(x.volume) ?? ""} ${x.symbol} (ticket ${ticket})`;
      let texto = `Freno: ${que} se abrió con el freno activo (${f.motivos.join("; ")}).`;
      if (accion) {
        const res = await this.operativa.enviar({ accion: "cancelar", ticket: Number(ticket) } as any);
        // Otro pedido sobre la misma operacion (el corte automatico): se reintenta en la vuelta siguiente.
        if (!res.ok && /en curso/.test(res.mensaje ?? "")) { this.frenoIntentos.delete(ticket); continue; }
        texto += res.ok ? " La cancelé." : ` No se pudo cancelar: ${res.mensaje}`;
      }
      log.warn(texto);
    }
    if (this.frenoIntentos.size > 200) this.frenoIntentos.clear();
  }

  /** Los precios de MT5 para los creditos demo (src/demo.ts): solo se leen. */
  private cotizarDemo(): Cotizar {
    const est = this.broker.estado();
    if (!est.available || !est.live) return () => null;
    const offset = Number(est.gmt_offset) || 0;
    return (nombre) => {
      const s: any = mt5.buscar(est.symbols as Record<string, any>, nombre);
      const bid = mt5.num(s?.bid), ask = mt5.num(s?.ask), porPunto = s ? mt5.porPunto(s) : null;
      if (!s || !bid || !ask || !porPunto) return null;
      return {
        bid, ask, porPunto, volMin: mt5.num(s.volume_min) || 0.01, volPaso: mt5.num(s.volume_step) || 0.01,
        volMax: mt5.num(s.volume_max) || 100, abierto: horario(s.sesiones, offset)?.abierto !== false,
      };
    };
  }

  /** Lo que pide el panel de creditos demo. No pasa por la Operativa. */
  accionDemo(b: any): { ok: boolean; mensaje: string } {
    const cotizar = this.cotizarDemo();
    const de = (id: unknown) => this.demo.c?.ops.find((o) => o.id === id)?.broker;
    switch (b.accion) {
      case "empezar": {
        if (b.modo === "nueva") return this.demo.empezar(10_000, 10_000);
        const est = this.broker.estado();
        const inicial = this.diario.riesgo(est)?.inicial, balance = mt5.num(est.account?.balance);
        if (!inicial || !balance) return { ok: false, mensaje: "Hace falta MT5 conectado para copiar tu cuenta." };
        return this.demo.empezar(inicial, balance);
      }
      case "abrir": {
        const symbol = String(b.symbol ?? "");
        const nombre = mt5.brokerSymbol(symbol) ?? symbol;
        return this.demo.abrir({ symbol, broker: nombre, lado: b.lado, tipo: b.tipo, riesgo: b.riesgo, precio: b.precio, sl: b.sl, tp: b.tp }, cotizar(nombre));
      }
      case "modificar": return this.demo.modificar({ id: b.id, sl: b.sl, tp: b.tp }, cotizar(de(b.id) ?? ""));
      case "cerrar": return this.demo.cerrar(b.id, cotizar(de(b.id) ?? ""));
      case "borrar": return this.demo.borrar();
      default: return { ok: false, mensaje: "Pedido desconocido." };
    }
  }

  /** Compara lo abierto en MT5 y en Binance con la vuelta anterior (cada 1 s). */
  private vigilarEjecuciones(): void {
    const est = this.broker.estado();
    if (est.available && est.live) {
      const lado = (t: unknown): "buy" | "sell" => String(t).startsWith("buy") ? "buy" : "sell";
      const login = String(est.account?.login ?? "");
      // Una posicion que ya no esta: la salida cuenta desde ya, aunque el historial tarde.
      const abiertas = new Set(((est.positions ?? []) as any[]).map((p) => String(p.ticket)));
      if (this.vistaSalidas?.login === login && [...this.vistaSalidas.tickets].some((t) => !abiertas.has(t))) {
        this.ultimaSalida = Date.now();
        this.frenoCache.at = 0;
      }
      this.vistaSalidas = { login, tickets: abiertas };
      this.ejecuciones.observar("mt5", login,
        ((est.positions ?? []) as any[]).map((p) => ({
          id: String(p.ticket), simbolo: String(p.symbol), lado: lado(p.type), volumen: mt5.num(p.volume) ?? 0,
          entrada: mt5.num(p.price_open) ?? 0, actual: mt5.num(p.price_current) ?? 0, sl: mt5.num(p.sl) || null, tp: mt5.num(p.tp) || null,
        })),
        ((est.orders ?? []) as any[]).map((o) => ({ id: String(o.ticket), simbolo: String(o.symbol), lado: lado(o.type) })),
        motivoMT5(this.broker.historial(login)?.deals));
    }
    const bn = this.binance.configurada ? this.binance.estado() : null;
    if (bn?.disponible) {
      this.ejecuciones.observar("binance", "binance",
        bn.posiciones.map((p) => ({
          id: `${p.simbolo}:${p.lado}`, simbolo: p.simbolo, lado: p.lado, volumen: p.cantidad,
          entrada: p.entrada, actual: p.marca, sl: p.sl, tp: p.tp,
        })),
        bn.pendientes.map((o) => ({ id: o.id, simbolo: o.simbolo, lado: o.lado })));
    }
  }

  private ultimaSalida = 0;
  private vistaSalidas: { login: string; tickets: Set<string> } | null = null;

  /** La pausa de la cuenta real (poner, quitar o seguir), desde el panel. */
  accionPausa(accion: unknown) {
    if (accion === "poner" || accion === "seguir") this.pausaReal.poner();
    else if (accion === "quitar") this.pausaReal.quitar();
    this.frenoCache.at = 0;
    return { ok: true, ...this.pausaReal.estado() };
  }

  /** Por que no se puede poner ese SL: el inicial es el techo (FRENO_SL_INICIAL). */
  problemaSl(ticket: unknown, sl: unknown): string | null {
    if (!config.FRENO_SL_INICIAL) return null;
    const est = this.broker.estado();
    const p = ((est.positions ?? []) as any[]).find((x) => Number(x.ticket) === Number(ticket));
    if (!p) return null;   // una pendiente: el riesgo se decide hasta que se ejecuta
    this.diario.riesgo(est);
    const inicial = this.diario.slInicial(p.ticket);
    const lado = String(p.type).startsWith("buy") ? "buy" : "sell";
    if (!ampliaSl(lado, inicial, Number(sl) || 0)) return null;
    const dig = mt5.buscar(est.symbols as Record<string, any>, String(p.symbol))?.digits ?? 2;
    const texto = new Intl.NumberFormat("es-CL", { minimumFractionDigits: dig, maximumFractionDigits: dig }).format(inicial!);
    return `No se amplía el riesgo: el SL inicial (${texto}) es el techo. Puedes acercarlo o cerrar.`;
  }

  /** Lo ampliado directo en MT5 vuelve al SL inicial (o se cierra si el precio ya lo
   *  paso), por el EA Operador. Cada posicion se reintenta como mucho cada 30 s. */
  private slIntentos = new Map<string, number>();
  private async topeSl(): Promise<void> {
    if (!config.FRENO_SL_INICIAL || !config.TRADING_ACTIVO) return;
    const est = this.broker.estado();
    if (!est.available || !est.live) return;
    const op = this.operativa.operador();
    if (!op.vivo || !op.habilitado) return;
    this.diario.riesgo(est);   // anota los SL que aparecieron recien
    const offset = Number(est.gmt_offset) || 0;
    const datos = new Map<string, any>();
    const vistas: PosicionSl[] = [];
    for (const p of (est.positions ?? []) as any[]) {
      const s = mt5.buscar(est.symbols as Record<string, any>, String(p.symbol));
      if (horario(s?.sesiones, offset)?.abierto === false) continue;
      datos.set(String(p.ticket), p);
      vistas.push({
        id: String(p.ticket), lado: String(p.type).startsWith("buy") ? "buy" : "sell", actual: mt5.num(p.price_current) ?? 0,
        sl: mt5.num(p.sl) || null, inicial: this.diario.slInicial(p.ticket),
      });
    }
    for (const c of planSl(vistas)) {
      if (Date.now() - (this.slIntentos.get(c.id) ?? 0) < 30_000) continue;
      this.slIntentos.set(c.id, Date.now());
      const p = datos.get(c.id);
      const que = `${String(p.type).startsWith("buy") ? "compra" : "venta"} ${mt5.num(p.volume) ?? ""} ${p.symbol} (ticket ${c.id})`;
      const r = await this.operativa.enviar({ accion: "modificar", ticket: Number(c.id), sl: c.precio, tp: mt5.num(p.tp) || 0 } as any);
      if (!r.ok && /en curso/.test(r.mensaje ?? "")) { this.slIntentos.delete(c.id); continue; }
      const texto = `Tope del SL: ${que} tenía el SL más lejos que el inicial. ${r.ok ? `Lo volví a ${c.precio}.` : `No se pudo volver a ${c.precio}: ${r.mensaje}`}`;
      log.warn(texto);
    }
    if (this.slIntentos.size > 200) this.slIntentos.clear();
  }

  /** El freno de disciplina, con el historial de la cuenta de fondeo (cada 2 s). */
  freno(): Freno | null {
    const ahora = Date.now();
    if (ahora - this.frenoCache.at < 2000) return this.frenoCache.valor;
    let valor: Freno | null = null;
    const pausa = this.pausaReal.estado(ahora);
    try {
      const est = this.broker.estado();
      const r = this.diario.resumen(0);
      const riesgo = this.diario.riesgo(est);
      if (r?.operaciones && riesgo?.inicioDia) {
        const offset = Number(est.gmt_offset) || 0;
        const deHoy = (xs: any[], campo: string) => (xs ?? []).filter((x) => (Number(x[campo]) - offset) * 1000 >= riesgo.inicioDia).length;
        const abiertasHoy = deHoy(est.positions as any[], "time") + deHoy(est.orders as any[], "time");
        const base = riesgo.balanceInicioDia ?? riesgo.balance ?? 0;
        valor = evaluarFreno(r.operaciones, abiertasHoy, riesgo.inicioDia, riesgo.proximoCorte, {
          perdidasSeguidas: config.FRENO_PERDIDAS, operacionesDia: config.FRENO_OPERACIONES,
          perdidaDia: config.FRENO_PERDIDA_DIA_USD > 0 ? config.FRENO_PERDIDA_DIA_USD : base * config.FRENO_PERDIDA_DIA_PCT / 100,
          modo: config.FRENO_MODO, pausaMin: config.FRENO_PAUSA_MIN,
        }, Math.max(0, riesgo.diaria?.usado ?? 0), { ultimaSalida: this.ultimaSalida, pausa, ahora });
      }
    } catch (exc) {
      log.debug(`Freno: ${exc}`);
    }
    // La pausa vale aunque falte el historial de MT5 (tambien frena Binance).
    if (!valor && pausa.activa) {
      valor = evaluarFreno([], 0, 0, 0, { perdidasSeguidas: 0, operacionesDia: 0, perdidaDia: 0, modo: config.FRENO_MODO }, 0, { pausa, ahora });
    }
    this.frenoCache = { at: ahora, valor };
    return valor;
  }

  // ------------------------------------------------------------- ciclo de vida

  async start(): Promise<void> {
    await this.bootstrap();
    if (config.SYMBOLS.length) this.detenerStream = combinedStream(config.SYMBOLS, config.INTERVALS,
      (ev) => this.onEvent(ev), (s) => this.onStatus(s, "spot"));
    if (config.PERPETUOS.length) {
      this.detenerPerpetuos = futuresStream(config.PERPETUOS, config.INTERVALS, (ev) => this.onEvent(ev), (s) => this.onStatus(s, "futuros"));
    }
    void this.resyncLoop();
    void this.indices.start();
    if (config.USDTD_ACTIVA) void this.usdtd.start();
    this.diario.iniciar();
    this.binance.iniciar();
    // El dato real de las noticias: lo que FTMO no tiene todavia, desde el calendario de MT5.
    this.calendario.deMT5 = () => this.broker.calendario();
    const noticias = () => { this.calendario.proximas(24).then((n) => { this.noticias = n; }).catch(() => {}); };
    noticias();
    this.relojes.push(setInterval(noticias, 60_000));
    // Lo abierto sin SL no pierde mas del tope (MT5; Binance lo hace en su cuenta).
    this.relojes.push(setInterval(() => { void this.corteAutomatico().catch((e) => log.warn(`Corte automático: ${e}`)); }, 3000));
    this.relojes.push(setInterval(() => { void this.frenoEnMT5().catch((e) => log.warn(`Freno en MT5: ${e}`)); }, 3000));
    this.relojes.push(setInterval(() => { void this.topeSl().catch((e) => log.warn(`Tope del SL: ${e}`)); }, 3000));
    this.relojes.push(setInterval(() => { try { for (const x of this.demo.tick(this.cotizarDemo())) log.info(x); } catch (e) { log.warn(`Demo: ${e}`); } }, 1000));
    this.relojes.push(setInterval(() => { try { this.vigilarEjecuciones(); } catch (e) { log.debug(`Ejecuciones: ${e}`); } }, 1000));
    for (const r of this.relojes) r.unref?.();
    // La historia larga del replay: se le pide al puente, de a poco.
    setTimeout(() => this.pedirHistoriaLarga(), 30_000).unref?.();
    this.relojes.push(setInterval(() => this.pedirHistoriaLarga(), 10 * 60_000));
  }

  // ----------------------------------------------- historia larga de FTMO

  /** La carpeta de las velas del puente y el nombre del simbolo del replay en MT5.
   *  Para leer basta lo que quedo en el disco (MT5 cerrado o fin de semana); para
   *  pedirle algo al puente (`vivo`) tiene que estar cotizando. */
  private puenteReplay(vivo = false): { carpeta: string; sym: string } | null {
    const est = this.broker.estado();
    const cot = this.velasBroker.cotizacion(config.REPLAY_SIMBOLO)?.symbol;
    const sym = vivo ? cot : cot ?? mt5.brokerSymbol(config.REPLAY_SIMBOLO);
    return est.path && sym ? { carpeta: dirname(est.path), sym } : null;
  }

  /** La historia larga de una temporalidad del mercado del replay, si el puente la exporto. */
  historiaLarga(interval: string): Candle[] | null {
    const tf = LARGAS[interval]?.[0] ?? null;
    const pm = this.puenteReplay();
    if (!tf || !pm) return null;
    const ruta = join(pm.carpeta, "velas", `${pm.sym}_${tf}_largo.json`);
    try {
      const mtime = statSync(ruta).mtimeMs;
      const previa = this.largos.get(ruta);
      if (previa?.mtime === mtime) return previa.velas;
      const j = JSON.parse(readFileSync(ruta, "utf8"));
      // Exportada con el mercado cerrado, el puente puede anotar desfase 0 (MT5 no
      // sabe la hora del servidor sin cotizaciones): vale el de las velas de siempre.
      const desfase = Number(j.gmt_offset) || this.velasBroker.desfaseArchivo(config.REPLAY_SIMBOLO) || 0;
      const velas = mt5.convertirVelas(j.bars ?? [], interval, desfase);
      this.largos.set(ruta, { mtime, velas });
      return velas;
    } catch {
      return null;
    }
  }

  /** Le pide al puente la historia larga (LARGAS) que falte, este vieja (mas de un
   *  dia) o haya quedado corta, de a dos temporalidades por vez para no frenarlo.
   *  Solo lectura. */
  private pedirHistoriaLarga(): void {
    // Solo con el mercado cotizando: sin conexion MT5 exporta con la hora corrida.
    const pm = this.puenteReplay(true);
    if (!pm) return;
    const pedido = join(pm.carpeta, "historia.txt");
    if (existsSync(pedido)) return;
    const faltan = Object.entries(LARGAS).filter(([interval, [tf, n]]) => {
      let mtime: number;
      try { mtime = statSync(join(pm.carpeta, "velas", `${pm.sym}_${tf}_largo.json`)).mtimeMs; } catch { return true; }
      const edad = Date.now() - mtime;
      return edad > 86_400_000 || ((this.historiaLarga(interval)?.length ?? 0) < n * 0.95 && edad > 6 * 3_600_000);
    }).slice(0, 2);
    if (!faltan.length) return;
    try {
      writeFileSync(pedido, faltan.map(([, [tf, n]]) => `${pm.sym},${tf},${n}`).join("\n\n") + "\n\n", "latin1");
      log.info(`Historia larga de ${pm.sym} pedida al puente: ${faltan.map(([, [tf]]) => tf).join(", ")}`);
    } catch (exc) { log.debug(`historia.txt: ${exc}`); }
  }

  /** Toda la historia que hay de una temporalidad: en el mercado del replay (con
   *  MT5 vivo), la larga de FTMO con lo vivo al final (15m y 30m armadas con la de 5
   *  minutos; sin ella, 5m, 15m y 30m con la de 1 minuto); en los demas, lo cargado. */
  historiaProfunda(symbol: string, interval: string): Candle[] {
    const b = baseDe(interval, config.INTERVALS);
    if (b) return agruparA(this.historiaProfunda(symbol, b), interval);
    const vivo = this.serie(symbol, interval) ?? [];
    if (symbol !== config.REPLAY_SIMBOLO || !vivo.length || !this.indiceEnMT5(symbol)) return vivo;
    let fuente = interval === "15m" || interval === "30m" ? "5m" : interval;
    let largo = this.historiaLarga(fuente);
    if (!largo?.length && ["5m", "15m", "30m"].includes(interval)) { fuente = "1m"; largo = this.historiaLarga("1m"); }
    if (!largo?.length) return vivo;
    // La parte vieja (agrupada si hace falta) solo cambia con la historia.
    const clave = `${fuente}|${largo.length}|${largo[largo.length - 1].t}`;
    let p = this.profundas.get(interval);
    if (p?.clave !== clave) {
      p = { clave, velas: fuente === interval ? largo : agruparVelas(largo, interval) };
      this.profundas.set(interval, p);
    }
    const desde = vivo[0].t;
    return p.velas.filter((x) => x.t < desde).concat(vivo);
  }

  /** Hasta `n` velas anteriores a `antes` (s): el grafico las pide al llegar a su
   *  borde izquierdo. `hayMas` dice si quedan mas atras. */
  velasAntes(symbol: string, interval: string, antes: number, n: number): any {
    const v = this.historiaProfunda(symbol, interval);
    let lo = 0, hi = v.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (v[m].t < antes) lo = m + 1; else hi = m; }
    const ini = Math.max(0, lo - n);
    return { ok: true, symbol, interval, velas: compactar(v.slice(ini, lo)), hayMas: ini > 0 };
  }

  /** Copia la USDT.D reconstruida a los buffers, como si fuera un par mas. */
  private syncUsdtd(): void {
    const v = this.usdtd.velas;
    if (!v.length) return;
    this.candles.set(this.key(USDTD, "1h"), v);
    this.candles.set(this.key(USDTD, "4h"), agrupar(v, 4));
    this.candles.set(this.key(USDTD, "1d"), agrupar(v, 24));
    this.tickers[USDTD] = { last: this.usdtd.valor ?? v[v.length - 1].c, change_pct: this.usdtd.cambio24h ?? undefined };
  }

  stop(): void {
    this.activo = false;
    this.detenerStream?.();
    this.detenerPerpetuos?.();
    this.usdtd.stop();
    this.indices.stop();
    this.diario.detener();
    this.binance.detener();
    for (const r of this.relojes) clearInterval(r);
  }

  waitReady(): Promise<void> {
    return this.listo;
  }

  /** Carga el historico de las cripto y del oro en paralelo. Los indices llegan
   *  despues, en segundo plano. */
  async bootstrap(): Promise<void> {
    const jobs = [
      ...config.SYMBOLS.flatMap((s) => config.INTERVALS.map((i) => [s, i] as const)),
      ...config.PERPETUOS.flatMap((s) => config.INTERVALS.map((i) => [s, i] as const)),
    ];
    const results = await Promise.allSettled(jobs.map(([s, i]) => esPerpetuo(s)
      ? this.rest.futVelas(s, i, config.HISTORY[i]) : this.rest.klines(s, i, config.HISTORY[i])));
    results.forEach((res, k) => {
      const [symbol, interval] = jobs[k];
      if (res.status === "rejected") log.error(`No se pudo cargar ${symbol} ${interval}: ${res.reason}`);
      else this.candles.set(this.key(symbol, interval), res.value);
    });
    try {
      if (config.SYMBOLS.length) Object.assign(this.tickers, await this.rest.ticker24h(config.SYMBOLS));
      if (config.PERPETUOS.length) Object.assign(this.tickers, await this.rest.futTicker24h(config.PERPETUOS));
    } catch (exc) {
      log.error(`No se pudo cargar el ticker 24h: ${exc}`);
    }
    this.resolverListo();
    log.info(`Historico cargado: ${this.candles.size} series`);
  }

  /** Refresco periodico por REST: evita cualquier deriva del stream. */
  private async resyncLoop(): Promise<void> {
    while (this.activo) {
      await sleep(config.RESYNC_SECONDS);
      await this.resyncAll(0.05);
    }
  }

  /** Pide las ultimas velas y las mezcla con el buffer: asi no se pierde la
   *  historia, que es mas larga que un pedido. */
  private async resyncAll(pausa = 0): Promise<void> {
    const pares = [
      ...config.SYMBOLS.flatMap((s) => config.INTERVALS.map((i) => [s, i] as const)),
      ...config.PERPETUOS.flatMap((s) => config.INTERVALS.map((i) => [s, i] as const)),
    ];
    for (const [symbol, interval] of pares) {
      if (!this.activo) return;
      try {
        // El stream sigue avanzando mientras REST responde. Guardamos el estado
        // de la ultima vela para conservar cualquier cambio recibido entre tanto.
        const ultima = this.candles.get(this.key(symbol, interval))?.at(-1);
        const previa = ultima ? { ...ultima } : undefined;
        const fresh = esPerpetuo(symbol) ? await this.rest.futVelas(symbol, interval, Math.min(config.HISTORY[interval], 1500))
          : await this.rest.klines(symbol, interval, Math.min(config.HISTORY[interval], 1000));
        if (fresh.length) this.mezclar(symbol, interval, fresh, previa);
      } catch (exc) {
        log.warn(`Resync fallido ${symbol} ${interval}: ${exc}`);
      }
      if (pausa) await sleep(pausa);  // respeta el rate limit
    }
  }

  private mezclar(symbol: string, interval: string, fresh: Candle[], previa?: Candle): void {
    if (!fresh.length) return;
    const actual = this.candles.get(this.key(symbol, interval)) ?? [];
    const mezcladas = new Map(actual.map((c) => [c.t, c]));
    for (const c of fresh) if (velaValida(c)) mezcladas.set(c.t, c);
    for (const c of actual) {
      // Nunca borres una vela mas nueva que la respuesta REST. Si la vela que
      // estaba abierta cambio durante la peticion, prevalece tambien el stream.
      const cambio = previa && c.t === previa.t && (Object.keys(previa) as (keyof Candle)[]).some((k) => c[k] !== previa[k]);
      if (c.t > fresh[fresh.length - 1].t || cambio || (previa && c.t > previa.t)) mezcladas.set(c.t, c);
    }
    const todo = [...mezcladas.values()].sort((a, b) => a.t - b.t);
    const limite = config.HISTORY[interval];
    this.candles.set(this.key(symbol, interval), todo.length > limite ? todo.slice(-limite) : todo);
  }

  private async onStatus(status: "up" | "down", tipo = "spot"): Promise<void> {
    this.streams.set(tipo, status === "up");
    this.streamUp = [...this.streams.values()].some(Boolean);
    if (status !== "up") return;
    if (!this.streamsIniciados.has(tipo)) this.streamsIniciados.add(tipo);
    else await this.resyncAll();
  }

  private onEvent(event: any): void {
    this.lastEventMs = Date.now();
    if (typeof event?.s === "string") this.eventos.set(event.s, this.lastEventMs);
    if (event.e === "kline") this.applyKline(event);
    else if (event.e === "aggTrade") this.applyTrade(event);
    else if (event.e === "24hrMiniTicker") this.applyMiniTicker(event);
  }

  private applyKline(event: any): void {
    const k = event.k;
    if (!k) return;
    const series = this.candles.get(this.key(event.s, k.i));
    if (!series) return;
    const candle = eventToCandle(k);
    if (!velaValida(candle)) return;
    const trade = this.ultimosTrades.get(event.s);
    if (trade && trade.id > Number(k.L) && trade.t >= candle.t_ms && trade.t <= candle.close_time) {
      // Los streams de trades y klines viajan por separado. El OHLC acumulado
      // sigue siendo util, pero su cierre no debe hacer retroceder el ultimo tick.
      candle.c = trade.precio;
      candle.h = Math.max(candle.h, trade.precio);
      candle.l = Math.min(candle.l, trade.precio);
      const anterior = series.at(-1);
      if (anterior?.t === candle.t) {
        candle.h = Math.max(candle.h, anterior.h);
        candle.l = Math.min(candle.l, anterior.l);
      }
    }
    if (series.length && candle.t === ultimo(series).t) {
      const anterior = ultimo(series);
      // Un mensaje retrasado no puede reabrir una vela cerrada ni reducir el
      // contador acumulado de operaciones de esa misma vela.
      if ((anterior.closed && !candle.closed) || candle.trades < anterior.trades) return;
      series[series.length - 1] = candle;
    }
    else if (!series.length || candle.t > ultimo(series).t) {
      series.push(candle);
      const limit = config.HISTORY[k.i];
      if (series.length > limit) series.splice(0, series.length - limit);
    }
  }

  /** El ultimo trade actualiza el cierre de todas las temporalidades al instante. */
  private applyTrade(event: any): void {
    const price = Number(event.p);
    const ts = Number(event.T);
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(ts)) return;
    const desde = config.INTERVALS.reduce((t, interval) => Math.max(t, this.candles.get(this.key(event.s, interval))?.at(-1)?.t_ms ?? 0), 0);
    if (ts < desde) return;
    const id = Number(event.l), previo = this.ultimosTrades.get(event.s);
    if (previo && (ts < previo.t || (Number.isFinite(id) && Number.isFinite(previo.id) && id <= previo.id))) return;
    this.ultimosTrades.set(event.s, { t: ts, id, precio: price });
    for (const interval of config.INTERVALS) {
      const series = this.candles.get(this.key(event.s, interval));
      if (!series || !series.length) continue;
      const last = ultimo(series);
      if (last.closed || ts < last.t_ms || ts > last.close_time) continue;  // la vela nueva la abre el stream de klines
      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
    }
    (this.tickers[event.s] ??= { last: price }).last = price;
  }

  private applyMiniTicker(event: any): void {
    const open = Number(event.o), close = Number(event.c);
    const high = Number(event.h), low = Number(event.l), volume = Number(event.q);
    if (![open, close, high, low, volume].every(Number.isFinite) || open <= 0 || close <= 0 || high < low || volume < 0) return;
    const trade = this.ultimosTrades.get(event.s);
    const last = trade && Number(event.E) < trade.t ? trade.precio : close;
    this.tickers[event.s] = {
      last,
      change_pct: (last - open) / open * 100.0,
      high: Math.max(high, last), low: Math.min(low, last), volume,
    };
  }

  // ------------------------------------------------------------------ grafico

  /** Series del grafico: velas, EMAs y el panel de squeeze y ADX. Con `tail`
   *  solo las ultimas barras, que es lo que cambia con la vela abierta. */
  /** La lista de seguimiento: cada mercado con su precio, el cambio del dia, la rueda
   *  de hoy (apertura, maximo, minimo, volumen) y las ultimas 24 h en velas de 15
   *  minutos para la minigrafica. Liviana: el panel la pide cada unos segundos. */
  lista(symbols: string[]): any[] {
    const tickers = this.tickersVivos();
    return symbols.map((symbol) => {
      const d = this.serie(symbol, "1d") ?? this.serie(symbol, "1h");
      const hoy = d?.at(-1), previa = d && d.length > 1 ? d[d.length - 2] : null;
      const m15 = this.serie(symbol, "15m") ?? this.serie(symbol, "1h") ?? [];
      const ult = m15.at(-1);
      const puntos = ult ? m15.filter((x) => x.t > ult.t - 86_400).map((x) => x.c) : [];
      const t = tickers[symbol];
      const last = t?.last ?? ult?.c ?? hoy?.c ?? null;
      return {
        symbol, last, change_pct: t?.change_pct ?? (previa && last ? (last - previa.c) / previa.c * 100 : null),
        cambio: previa && last !== null ? last - previa.c : null,
        dia: hoy ? { o: hoy.o, h: hoy.h, l: hoy.l, v: hoy.v } : null,
        puntos,
      };
    });
  }

  // Una sola conversion por version de velas, compartida por las vistas/clientes.
  // Solo se cachea el grafico: cotizaciones, cuenta y feed se leen en cada build.
  private graficos = new Map<string, GraficoCache>();
  private revisionesVista = new Map<string, RevisionVista>();
  private numeroRevision = 0;

  /** La cola de dos velas no puede corregir historia ni cubrir un salto del feed.
   *  Los productores reemplazan el array al corregir pasado; en el mismo array
   *  solo cambian la vela abierta o agregan una nueva. */
  revisionVista(symbol: string, interval: string): number | undefined {
    const serie = this.serie(symbol, interval);
    if (!serie?.length) return undefined;
    const k = this.key(symbol, interval);
    const origen = esYahoo(symbol) ? this.indiceEnMT5(symbol) ? "mt5" : "yahoo" : symbol === USDTD ? "coingecko" : esPerpetuo(symbol) ? "futuros" : "spot";
    const revisiones = this.revisionesVista ??= new Map();
    const anterior = revisiones.get(k);
    const primera = serie[0].t, ultima = serie.at(-1)!.t;
    if (anterior?.origen === origen && anterior.fuente === serie && anterior.primera === primera && anterior.ultima === ultima && anterior.longitud === serie.length) return anterior.revision;
    const velas = new Map<number, string>();
    const frontera = serie[Math.max(0, serie.length - 2)].t;
    let cambio = !anterior || anterior.origen !== origen || anterior.ultima < frontera || ultima < anterior.ultima || primera < anterior.primera;
    for (const v of serie) {
      const firma = [v.o, v.h, v.l, v.c, v.v, v.vb, v.trades, v.closed].join("|");
      velas.set(v.t, firma);
      if (anterior && v.t < frontera && anterior.velas.get(v.t) !== firma) cambio = true;
    }
    if (anterior) {
      for (const t of anterior.velas.keys()) if (t >= primera && t < frontera && !velas.has(t)) cambio = true;
    }
    const revision = cambio ? (this.numeroRevision = (this.numeroRevision ?? 0) + 1) : anterior!.revision;
    if (revisiones.size >= 32 && !revisiones.has(k)) revisiones.delete(revisiones.keys().next().value!);
    revisiones.set(k, { origen, fuente: serie, primera, ultima, longitud: serie.length, velas, revision });
    return revision;
  }

  private colaGrafico(c: GraficoCache, tail: number | null): any {
    const n = tail === null || tail >= c.fuente.length ? null : Math.max(0, Math.trunc(tail));
    const previa = c.salidas.get(n);
    if (previa) return previa;
    const salida = c.crear(n);
    if (c.salidas.size >= 8) c.salidas.delete(c.salidas.keys().next().value!);
    c.salidas.set(n, salida);
    return salida;
  }

  grafico(symbol: string, interval: string, tail: number | null = null): any {
    const series = this.serie(symbol, interval);
    if (!series || !series.length) return null;

    const u = ultimo(series), k = this.key(symbol, interval);
    // Las fuentes reemplazan el array al corregir historia; en vivo solo mutan
    // la ultima vela. Se incluyen todos los campos que el grafico publica.
    const clave = [series.length, series[0].t, u.t, u.o, u.h, u.l, u.c, u.v, u.vb, u.trades, u.closed,
      config.EMA_FAST, config.EMA_SLOW, config.EMA_LARGA, config.SQZ_BB_LENGTH, config.SQZ_BB_MULT,
      config.SQZ_KC_LENGTH, config.SQZ_KC_MULT, config.SQZ_USE_TRUE_RANGE, config.ADX_DI_LENGTH, config.ADX_SMOOTHING].join("|");
    const anterior = this.graficos.get(k);
    if (anterior?.fuente === series && anterior.clave === clave) return this.colaGrafico(anterior, tail);

    const t = series.map((x) => x.t), h = series.map((x) => x.h), l = series.map((x) => x.l), c = series.map((x) => x.c);
    const sq = ind.squeezeMomentum(h, l, c, config.SQZ_BB_LENGTH, config.SQZ_BB_MULT,
                                   config.SQZ_KC_LENGTH, config.SQZ_KC_MULT, config.SQZ_USE_TRUE_RANGE);
    const dmi = ind.adx(h, l, c, config.ADX_DI_LENGTH, config.ADX_SMOOTHING);
    const emas = [config.EMA_FAST, config.EMA_SLOW, config.EMA_LARGA].map((n) => ind.ema(c, n));

    const crear = (tail: number | null) => {
      const desde = Math.max(0, series.length - (tail ?? series.length));
      const out = {
        velas: series.slice(desde).map((x) => ({
          time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v,
          buy: x.vb, sell: Math.max(x.v - x.vb, 0), trades: x.trades, closed: x.closed,
        })),
        ema: emas.map((values) => linea(values.slice(desde), t.slice(desde))),
        momento: [] as any[],
        compresion: [] as any[],
        fuerza: [] as any[],
      };
      for (let i = desde; i < series.length; i++) {
        const v = sq.value[i];
        if (isNum(v)) {
          const p = i > 0 && isNum(sq.value[i - 1]) ? sq.value[i - 1] : 0;
          const color = v > 0 ? (v > p ? SQZ.subeFuerte : SQZ.subeDebil) : (v < p ? SQZ.bajaFuerte : SQZ.bajaDebil);
          out.momento.push({ time: t[i], value: v, color });
        }
        const st = sq.state[i];
        out.compresion.push({ time: t[i], value: 0, color: st === "on" ? SQZ.comprimido : st === "off" ? SQZ.liberado : SQZ.neutro });
        if (isNum(dmi.adx[i])) {
          // El ADX con su valor real (0 a 100): el grafico lo pone en su propia escala.
          const sube = i > 0 && dmi.adx[i] > dmi.adx[i - 1];
          out.fuerza.push({ time: t[i], value: dmi.adx[i], color: sube ? SQZ.adxSube : SQZ.adxBaja });
        }
      }
      return out;
    };
    const cache: GraficoCache = { fuente: series, clave, crear, salidas: new Map() };
    if (this.graficos.size >= 32 && !this.graficos.has(k)) this.graficos.delete(this.graficos.keys().next().value!);
    this.graficos.set(k, cache);
    return this.colaGrafico(cache, tail);
  }

  /** Las velas para el replay (solo el mercado del replay): la historia larga de
   *  FTMO de 1 minuto y 1 hora con lo vivo detras, y el 4H y el diario. Compactas,
   *  como [t, o, h, l, c, v]: la interfaz arma cada temporalidad hasta el instante
   *  del replay. */
  replay(symbol: string): any {
    if (symbol !== config.REPLAY_SIMBOLO) return null;
    const broker = (i: string) => this.velasBroker.serie(symbol, i) ?? this.velasBroker.archivoSerie(symbol, i);
    const m1 = juntar(this.historiaLarga("1m"), broker("1m"));
    if (m1.length < 1000) return { ok: false, error: "Todavía no está la historia de 1 minuto de FTMO (el puente la exporta al arrancar)." };
    // De 5 minutos, solo lo de antes de la de 1 minuto (con la de 1 minuto se arman las velas a medio formar).
    const m5 = (this.historiaLarga("5m") ?? []).filter((x) => x.t < m1[0].t);
    return {
      ok: true, symbol,
      m1: compactar(m1),
      m5: compactar(m5),
      h1: compactar(juntar(this.historiaLarga("1h"), broker("1h"))),
      h4: compactar(juntar(this.historiaLarga("4h"), broker("4h"))),
      d1: compactar(juntar(this.historiaLarga("1d"), broker("1d"))),
      w1: compactar(broker("1w") ?? []),
    };
  }

  /** Paquete para la interfaz: grafico, MT5 y estado del feed. */
  build(symbol: string, interval: string, tail: number | null = null): any {
    const grafico = this.grafico(symbol, interval, tail);
    if (!grafico) {
      const cargando = esYahoo(symbol) ? this.indices.estado : `Sin datos para ${symbol} ${interval}`;
      return { ok: false, error: cargando };
    }
    const series = this.serie(symbol, interval)!;
    return {
      ok: true,
      symbol,
      interval,
      grafico,
      fuente: !esYahoo(symbol) ? null : this.indiceEnMT5(symbol) ? {
        nombre: `FTMO MT5 · ${this.velasBroker.cotizacion(symbol)?.symbol ?? mt5.brokerSymbol(symbol)}`,
        ultimoDato: this.velasBroker.ultimaCotizacion(symbol),
        broker: true,
      } : {
        nombre: `Yahoo Finance · ${mercados()[symbol].fuente}`,
        ultimoDato: this.indices.ultimoDato[symbol] ?? null,
      },
      precio: ultimo(series).c,
      // Noticias restringidas o de alto impacto de las proximas 24 h (calendario de FTMO).
      noticias: this.noticias.filter((e) => e.t >= Date.now() - 5 * 60_000),
      broker: symbol === USDTD ? null : this.bloqueBroker(symbol, ultimo(series).c),
      binance: this.binance.configurada ? this.binance.estado() : null,
      ejecuciones: this.ejecuciones.recientes(),
      demo: this.demo.vista(this.cotizarDemo()),
      tickers: this.tickersVivos(),
      feed: { stream_up: this.streams.get(esPerpetuo(symbol) ? "futuros" : "spot") ?? false, last_event_ms: this.eventos.get(symbol) ?? 0, server_ms: Date.now() },
    };
  }
}
