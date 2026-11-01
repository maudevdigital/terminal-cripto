/* Cliente de datos publicos de Binance: REST para historico y WebSocket para vivo. */

import { config } from "./config.ts";
import { getLogger } from "./log.ts";

const log = getLogger("binance");

export interface Candle {
  t: number;          // segundos, formato lightweight-charts
  t_ms: number;
  close_time: number;
  o: number; h: number; l: number; c: number;
  v: number;
  vb: number;         // volumen comprador (taker buy)
  trades: number;
  closed: boolean;
}

export interface Ticker { last: number; change_pct?: number; high?: number; low?: number; volume?: number }

/** Una vela invalida no debe contaminar indicadores ni llegar al canvas. */
export function velaValida(c: Candle): boolean {
  return [c.t, c.t_ms, c.close_time, c.o, c.h, c.l, c.c, c.v, c.vb, c.trades].every(Number.isFinite)
    && Number.isInteger(c.t) && c.t >= 0 && c.t_ms === c.t * 1000 && c.close_time >= c.t_ms
    && c.h >= Math.max(c.o, c.c, c.l) && c.l <= Math.min(c.o, c.c)
    && c.v >= 0 && c.vb >= 0 && c.vb <= c.v && Number.isInteger(c.trades) && c.trades >= 0;
}

function velasRest(raw: any[][]): Candle[] {
  const ahora = Date.now();
  const velas = raw.map((k) => klineToCandle(k, Number(k[K_CLOSE_TIME]) < ahora)).filter(velaValida);
  return [...new Map(velas.map((c) => [c.t, c])).values()].sort((a, b) => a.t - b.t);
}

/** Vela del perpetuo para el mapa de liquidacion (horas en segundos, volumen en USDT). */
export interface FutBar { t: number; fin: number; h: number; l: number; c: number; qv: number; qvb: number }

// Indices del array de kline que devuelve Binance.
const K_OPEN_TIME = 0, K_OPEN = 1, K_HIGH = 2, K_LOW = 3, K_CLOSE = 4, K_VOLUME = 5, K_CLOSE_TIME = 6;
const K_TRADES = 8, K_TAKER_BUY_BASE = 9;

export function klineToCandle(k: any[], closed: boolean): Candle {
  return {
    t: Math.floor(Number(k[K_OPEN_TIME]) / 1000),
    t_ms: Number(k[K_OPEN_TIME]),
    close_time: Number(k[K_CLOSE_TIME]),
    o: Number(k[K_OPEN]),
    h: Number(k[K_HIGH]),
    l: Number(k[K_LOW]),
    c: Number(k[K_CLOSE]),
    v: Number(k[K_VOLUME]),
    vb: Number(k[K_TAKER_BUY_BASE]),
    trades: Math.trunc(Number(k[K_TRADES])),
    closed,
  };
}

export function eventToCandle(k: any): Candle {
  return {
    t: Math.floor(Number(k.t) / 1000),
    t_ms: Number(k.t),
    close_time: Number(k.T),
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v),
    vb: Number(k.V),
    trades: Math.trunc(Number(k.n)),
    closed: Boolean(k.x),
  };
}

export class BinanceRest {
  private headers: Record<string, string>;

  constructor() {
    this.headers = { "User-Agent": "cripto-terminal/1.0" };
    if (config.BINANCE_API_KEY) this.headers["X-MBX-APIKEY"] = config.BINANCE_API_KEY;
  }

  private async get(path: string, params: Record<string, string | number>, base = config.REST_BASE): Promise<any> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const r = await fetch(`${base}${path}?${qs}`, {
      headers: this.headers, signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}`);
    return r.json();
  }

  async klines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    if (limit > 1000) return this.klinesLargo(symbol, interval, limit);
    const raw: any[][] = await this.get("/api/v3/klines", { symbol, interval, limit: Math.min(limit, 1000) });
    return velasRest(raw);
  }

  /** Mas de 1000 velas: se piden en tramos hacia atras con endTime. */
  private async klinesLargo(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    let out: Candle[] = [];
    let hasta: number | null = null;
    while (out.length < limit) {
      const params: Record<string, string | number> = { symbol, interval, limit: 1000 };
      if (hasta !== null) params.endTime = hasta;
      const raw: any[][] = await this.get("/api/v3/klines", params);
      if (!raw.length) break;
      const tramo = velasRest(raw);
      if (!tramo.length || (hasta !== null && tramo[0].t_ms - 1 >= hasta)) break;
      out = [...tramo.filter((c) => !out.length || c.t < out[0].t), ...out];
      hasta = tramo[0].t_ms - 1;
      if (raw.length < 1000) break;
    }
    return out.slice(-limit);
  }

  // ------------------------------------------------------------ futuros (USDⓈ-M)

  /** Velas del perpetuo, con volumen en USDT y volumen comprador agresor. */
  async futKlines(symbol: string, interval: string, limit: number, endTime?: number): Promise<FutBar[]> {
    const params: Record<string, string | number> = { symbol, interval, limit: Math.min(limit, 1500) };
    if (endTime !== undefined) params.endTime = endTime;
    const raw: any[][] = await this.get("/fapi/v1/klines", params, config.FUTURES_REST);
    return raw.map((k) => ({
      t: Math.floor(Number(k[0]) / 1000),
      fin: Math.floor((Number(k[6]) + 1) / 1000),
      h: Number(k[2]), l: Number(k[3]), c: Number(k[4]),
      qv: Number(k[7]), qvb: Number(k[10]),
    }));
  }

  /** Velas del perpetuo en el formato del grafico (para los que no tienen spot).
   *  Mas de 1500 se piden en tramos hacia atras. */
  async futVelas(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    let out: Candle[] = [];
    let hasta: number | null = null;
    while (out.length < limit) {
      const pedir = Math.min(1500, limit - out.length + 1);
      const params: Record<string, string | number> = { symbol, interval, limit: pedir };
      if (hasta !== null) params.endTime = hasta;
      const raw: any[][] = await this.get("/fapi/v1/klines", params, config.FUTURES_REST);
      if (!raw.length) break;
      const tramo = velasRest(raw);
      if (!tramo.length || (hasta !== null && tramo[0].t_ms - 1 >= hasta)) break;
      out = [...tramo.filter((c) => !out.length || c.t < out[0].t), ...out];
      hasta = tramo[0].t_ms - 1;
      if (raw.length < pedir) break;
    }
    return out.slice(-limit);
  }

  async futTicker24h(symbols: string[]): Promise<Record<string, Ticker>> {
    const out: Record<string, Ticker> = {};
    for (const symbol of symbols) {
      const t = await this.get("/fapi/v1/ticker/24hr", { symbol }, config.FUTURES_REST);
      out[t.symbol] = {
        last: Number(t.lastPrice), change_pct: Number(t.priceChangePercent),
        high: Number(t.highPrice), low: Number(t.lowPrice), volume: Number(t.quoteVolume),
      };
    }
    return out;
  }

  /** Historia del open interest (Binance guarda solo el ultimo mes). Cada punto:
   *  hora en segundos y open interest en la moneda base (BTC). */
  async oiHist(symbol: string, period: string, limit: number, startTime?: number, endTime?: number): Promise<{ t: number; oi: number }[]> {
    const params: Record<string, string | number> = { symbol, period, limit: Math.min(limit, 500) };
    if (startTime !== undefined) params.startTime = startTime;
    if (endTime !== undefined) params.endTime = endTime;
    const raw: any[] = await this.get("/futures/data/openInterestHist", params, config.FUTURES_REST);
    return raw.map((x) => ({ t: Math.floor(Number(x.timestamp) / 1000), oi: Number(x.sumOpenInterest) }));
  }

  async oiAhora(symbol: string): Promise<{ t: number; oi: number }> {
    const x = await this.get("/fapi/v1/openInterest", { symbol }, config.FUTURES_REST);
    return { t: Number(x.time) / 1000, oi: Number(x.openInterest) };
  }

  async ticker24h(symbols: string[]): Promise<Record<string, Ticker>> {
    const data: any[] = await this.get("/api/v3/ticker/24hr", { symbols: JSON.stringify(symbols) });
    const out: Record<string, Ticker> = {};
    for (const t of data) {
      out[t.symbol] = {
        last: Number(t.lastPrice),
        change_pct: Number(t.priceChangePercent),
        high: Number(t.highPrice),
        low: Number(t.lowPrice),
        volume: Number(t.quoteVolume),
      };
    }
    return out;
  }

  async serverTime(): Promise<number> {
    return Number((await this.get("/api/v3/time", {})).serverTime);
  }
}

export function streamNames(symbols: string[], intervals: string[]): string[] {
  const names: string[] = [];
  for (const symbol of symbols) {
    const s = symbol.toLowerCase();
    for (const interval of intervals) names.push(`${s}@kline_${interval}`);
    names.push(`${s}@aggTrade`);   // precio tick a tick y trades grandes (alta frecuencia)
    names.push(`${s}@miniTicker`); // estadisticas 24h
  }
  return names;
}

/** Consume el stream combinado y reconecta con backoff exponencial.
 *
 *  Ademas de los eventos de Binance avisa el estado de la conexion
 *  (`onStatus("up" | "down")`), para que la UI muestre el estado real. */
export function combinedStream(symbols: string[], intervals: string[],
                               onEvent: (data: any) => void,
                               onStatus: (s: "up" | "down") => void | Promise<void>): () => void {
  return stream(config.WS_BASE, streamNames(symbols, intervals), "WebSocket", onEvent, onStatus);
}

/** Velas, trades y estadisticas de 24h de perpetuos sin spot (oro, plata...). */
export function futuresStream(symbols: string[], intervals: string[],
                              onEvent: (data: any) => void,
                              onStatus: (s: "up" | "down") => void | Promise<void>): () => void {
  return stream(config.FUTURES_WS, streamNames(symbols, intervals), "WebSocket de perpetuos", onEvent, onStatus);
}

/** Liquidaciones forzadas del perpetuo, de todo el mercado (se filtra afuera).
 *  Binance manda, por simbolo, la mas grande de cada segundo: es una muestra,
 *  no el total. */
export function liquidationStream(onEvent: (data: any) => void): () => void {
  return stream(config.FUTURES_WS, ["!forceOrder@arr"], "WebSocket de liquidaciones", onEvent, () => {});
}

function stream(base: string, names: string[], etiqueta: string,
                onEvent: (data: any) => void,
                onStatus: (s: "up" | "down") => void | Promise<void>): () => void {
  const url = `${base}/stream?streams=${names.join("/")}`;
  let backoff = 1.0;
  let detenido = false;
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const conectar = () => {
    if (detenido) return;
    let caido = false;
    const notificar = (s: "up" | "down") => {
      Promise.resolve().then(() => onStatus(s)).catch((exc) => log.warn(`Estado del ${etiqueta}: ${exc}`));
    };
    const caer = (motivo: string) => {
      if (caido || detenido) return;
      caido = true;
      log.warn(`${etiqueta} caido (${motivo}). Reintentando en ${backoff.toFixed(1)}s`);
      notificar("down");
      socket.close();
      timer = setTimeout(conectar, backoff * 1000);
      backoff = Math.min(backoff * 2, 30.0);
    };
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      if (caido || detenido || socket !== ws) return;
      log.info(`${etiqueta} conectado (${names.length} streams)`);
      backoff = 1.0;
      notificar("up");
    };
    socket.onmessage = (ev) => {
      if (caido || detenido || socket !== ws) return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.data) onEvent(msg.data);
      } catch (exc) {
        log.debug(`Mensaje ilegible del stream: ${exc}`);
      }
    };
    socket.onerror = () => caer("error de red");
    socket.onclose = (ev) => caer(`cerrado ${ev.code}`);
  };
  conectar();

  return () => {
    detenido = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
