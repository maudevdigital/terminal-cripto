/* Indices de EE.UU. (US30, US100, US500) con datos gratuitos de Yahoo Finance.
 *
 * Por defecto se usan los futuros de CME (YM=F, NQ=F, ES=F): cotizan casi 24
 * horas, como los CFD del broker. El futuro lleva una prima sobre el indice
 * contado (unos puntos que se achican hasta el vencimiento), asi que los niveles
 * quedan corridos esa diferencia respecto del CFD; el dibujo es el mismo. Yahoo
 * los entrega con unos 10 minutos de retraso (el dato gratuito de CME).
 *
 * - Historia: cada temporalidad se pide a Yahoo (el 4H se arma con velas de 1H).
 * - En vivo: velas de 1m cada INDICES_CADA segundos, que rehacen la ultima vela
 *   de cada temporalidad. Con el mercado cerrado se consulta cada minuto.
 * - Cada 5 minutos se vuelve a pedir todo, para corregir cualquier deriva.
 * - Yahoo no tiene volumen comprador: se estima con donde cerro la vela dentro
 *   de su rango (solo lo usa el perfil de volumen). */

import type { Candle, Ticker } from "./binance.ts";
import { config, yahoo } from "./config.ts";
import { getLogger } from "./log.ts";

const log = getLogger("indices");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const API = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HORA = 3600, DIA = 86400;

// Que se le pide a Yahoo para cada temporalidad de la terminal.
const PEDIDOS: Record<string, { intervalo: string; rango: string; agrupar?: number }> = {
  "1m": { intervalo: "1m", rango: "2d" },
  "5m": { intervalo: "5m", rango: "10d" },
  "15m": { intervalo: "15m", rango: "30d" },
  "30m": { intervalo: "30m", rango: "60d" },   // Yahoo da 30 minutos de los ultimos 60 dias
  "1h": { intervalo: "60m", rango: "3mo" },
  "4h": { intervalo: "60m", rango: "1y", agrupar: 4 },
  "1d": { intervalo: "1d", rango: "5y" },
  "1w": { intervalo: "1wk", rango: "10y" },
  "1M": { intervalo: "1mo", rango: "20y" },
};
const SEG: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": HORA, "4h": 4 * HORA, "1d": DIA, "1w": 7 * DIA };

// ---------------------------------------------------------- horas de Nueva York

const fmtNY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

function partesNY(s: number) {
  const p: Record<string, string> = {};
  for (const x of fmtNY.formatToParts(new Date(s * 1000))) p[x.type] = x.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) };
}

/** Medianoche de Nueva York de una fecha, en segundos UTC (04:00 o 05:00 Z segun el horario de verano). */
export function medianocheNY(y: number, m: number, d: number): number {
  for (const off of [4, 5]) {
    const s = Date.UTC(y, m - 1, d, off) / 1000;
    if (partesNY(s).h === 0) return s;
  }
  return Date.UTC(y, m - 1, d, 5) / 1000;
}

/** Apertura de la vela diaria de Yahoo para un instante: la medianoche de la
 *  fecha de la rueda. La rueda de los futuros empieza a las 18:00 del dia
 *  anterior, de ahi las 6 horas de corrimiento. */
export function inicioDia(s: number): number {
  const p = partesNY(s + 6 * HORA);
  return medianocheNY(p.y, p.m, p.d);
}

/** Apertura de la vela semanal de Yahoo: el lunes de esa rueda, a medianoche. */
export function inicioSemana(s: number): number {
  const p = partesNY(s + 6 * HORA);
  const fecha = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const atras = (fecha.getUTCDay() + 6) % 7;   // dias desde el lunes
  fecha.setUTCDate(fecha.getUTCDate() - atras);
  return medianocheNY(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, fecha.getUTCDate());
}

/** Apertura de la vela mensual de Yahoo: el dia 1 de la rueda, a medianoche. */
export function inicioMes(s: number): number {
  const p = partesNY(s + 6 * HORA);
  return medianocheNY(p.y, p.m, 1);
}

/** Apertura de la vela de `interval` que contiene el instante s. */
export function apertura(s: number, interval: string): number {
  if (interval === "1d") return inicioDia(s);
  if (interval === "1w") return inicioSemana(s);
  if (interval === "1M") return inicioMes(s);
  return Math.floor(s / SEG[interval]) * SEG[interval];
}

// ------------------------------------------------------------------- velas

function vela(t: number, interval: string, o: number, h: number, l: number, c: number, v: number, ahoraMs: number): Candle {
  // La diaria y la semanal cierran cuando abre la rueda siguiente (18:00 de Nueva York).
  const fin = interval === "1d" ? inicioDia(t + DIA + 6 * HORA) - 6 * HORA
    : interval === "1w" ? inicioSemana(t + 8 * DIA) - 6 * HORA
    : interval === "1M" ? inicioMes(t + 32 * DIA) - 6 * HORA : t + SEG[interval];
  const close_time = fin * 1000 - 1;
  // Volumen comprador estimado: cierre en el maximo = todo compra, en el minimo = todo venta.
  const vb = h > l ? v * (c - l) / (h - l) : v / 2;
  return { t, t_ms: t * 1000, close_time, o, h, l, c, v, vb, trades: 0, closed: close_time < ahoraMs };
}

/** Junta velas en las de `interval` (alineadas con `apertura`). */
export function agrupar(velas: Candle[], interval: string, ahoraMs = Date.now()): Candle[] {
  const out: Candle[] = [];
  for (const x of velas) {
    const t = apertura(x.t, interval);
    const u = out[out.length - 1];
    if (u && u.t === t) {
      u.h = Math.max(u.h, x.h); u.l = Math.min(u.l, x.l); u.c = x.c; u.v += x.v; u.vb += x.vb;
    } else {
      out.push(vela(t, interval, x.o, x.h, x.l, x.c, x.v, ahoraMs));
    }
  }
  for (const u of out) {
    u.vb = u.h > u.l ? u.v * (u.c - u.l) / (u.h - u.l) : u.v / 2;
    u.closed = u.close_time < ahoraMs;
  }
  return out;
}

/** `rango` es un rango de Yahoo ("2d", "5y"). Con period1/period2 los futuros
 *  vuelven sin velas, y "1d" queda vacio al abrir la rueda del domingo. */
async function pedir(simbolo: string, intervalo: string, rango: string): Promise<any> {
  const url = `${API}${encodeURIComponent(simbolo)}?interval=${intervalo}&range=${rango}&includePrePost=false`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Yahoo respondio ${r.status} para ${simbolo} ${intervalo}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description ?? `sin datos de ${simbolo}`);
  return res;
}

/** Velas de Yahoo en el formato de la terminal, alineadas a `interval`. Yahoo
 *  manda la vela en curso con la hora del ultimo dato: se alinea y, si cae en la
 *  misma vela que la anterior, se junta con ella. */
export function convertir(res: any, interval: string, ahoraMs = Date.now()): Candle[] {
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const crudas: Candle[] = [];
  const base = interval === "4h" ? "1h" : interval;
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (!Number.isInteger(ts[i]) || ts[i] < 0) continue;
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    if (h < Math.max(o, c, l) || l > Math.min(o, c)) continue;
    const volumen = Number(q.volume?.[i]);
    crudas.push(vela(ts[i], base, o, h, l, c, Number.isFinite(volumen) && volumen >= 0 ? volumen : 0, ahoraMs));
  }
  // Se deduplica por timestamp original: Yahoo puede mandar una muestra parcial
  // con otra hora dentro de la misma vela semanal/mensual y esa si se agrega.
  const ordenadas = [...new Map(crudas.map((x) => [x.t, x])).values()].sort((a, b) => a.t - b.t);
  return agrupar(ordenadas, interval, ahoraMs);
}

// ------------------------------------------------------------------ fuente

interface Destino {
  candles: Map<string, Candle[]>;
  tickers: Record<string, Ticker>;
}

export class Indices {
  private destino: Destino;
  private historia = new Map<string, Candle[]>();   // lo ultimo que dio Yahoo por temporalidad
  private vivo = new Map<string, Candle[]>();       // velas de 1m de las ultimas horas
  private activo = true;
  estado = "Cargando índices desde Yahoo Finance…";
  ultimoDato: Record<string, number> = {};          // ms del ultimo dato de 1m por indice

  constructor(destino: Destino) {
    this.destino = destino;
  }

  get symbols(): string[] {
    return Object.keys(yahoo());
  }

  stop(): void {
    this.activo = false;
  }

  /** Corre en segundo plano: la terminal no lo espera. */
  async start(): Promise<void> {
    if (!this.symbols.length) return;
    let ultimaHistoria = 0;
    while (this.activo) {
      if (Date.now() - ultimaHistoria > 5 * 60_000) {
        await this.cargarHistoria();
        ultimaHistoria = Date.now();
      }
      await this.enVivo();
      // Con el mercado cerrado alcanza con una lectura por minuto. Los futuros
      // llegan con unos 10 minutos de retraso: cerrado es sin datos en 25.
      const abierto = this.symbols.some((s) => Date.now() - (this.ultimoDato[s] ?? 0) < 25 * 60_000);
      await sleep(abierto ? config.INDICES_CADA * 1000 : 60_000);
    }
  }

  /** Un mercado nuevo (abierto desde el buscador): su historia y lo ultimo de 1m ya. */
  async agregar(symbol: string): Promise<void> {
    await this.cargarHistoria([symbol]);
    try {
      const m1 = convertir(await pedir(yahoo()[symbol], "1m", "2d"), "1m");
      if (m1.length) { this.ultimoDato[symbol] = m1[m1.length - 1].t * 1000; this.vivo.set(symbol, m1); }
    } catch (exc) { log.debug(`${symbol} en vivo: ${exc}`); }
    this.publicar();
  }

  private async cargarHistoria(lista = this.symbols): Promise<void> {
    let fallas = 0;
    for (const symbol of lista) {
      const simbolo = yahoo()[symbol];
      for (const [interval, p] of Object.entries(PEDIDOS)) {
        if (!this.activo) return;
        try {
          const velas = convertir(await pedir(simbolo, p.intervalo, p.rango), interval).slice(-config.HISTORY[interval]);
          if (velas.length) this.historia.set(`${symbol}|${interval}`, velas);
          if (interval === "1m" && velas.length) {
            this.ultimoDato[symbol] = Math.max(this.ultimoDato[symbol] ?? 0, velas[velas.length - 1].t * 1000);
          }
        } catch (exc) {
          fallas++;
          log.warn(`${symbol} ${interval}: ${exc instanceof Error ? exc.message : exc}`);
        }
        await sleep(250);
      }
    }
    if (!fallas) this.estado = "En vivo";
    else if (fallas && !this.historia.size) this.estado = "Yahoo Finance no responde: se reintenta en 5 minutos";
    this.publicar();
  }

  /** Lee las velas de 1m y rehace con ellas la ultima vela de cada temporalidad. */
  private async enVivo(): Promise<void> {
    for (const symbol of this.symbols) {
      if (!this.activo) return;
      try {
        const m1 = convertir(await pedir(yahoo()[symbol], "1m", "2d"), "1m");
        if (m1.length) {
          this.ultimoDato[symbol] = m1[m1.length - 1].t * 1000;
          this.vivo.set(symbol, m1);
        }
      } catch (exc) {
        log.debug(`${symbol} en vivo: ${exc}`);
      }
    }
    this.publicar();
  }

  /** Historia + lo ultimo de 1m, en los buffers que lee el grafico. */
  private publicar(): void {
    const ahora = Date.now();
    for (const symbol of this.symbols) {
      const m1 = this.vivo.get(symbol) ?? [];
      for (const interval of Object.keys(PEDIDOS)) {
        const h = this.historia.get(`${symbol}|${interval}`);
        if (!h?.length) continue;
        const serie = h.map((x) => ({ ...x }));
        const u = serie[serie.length - 1];
        // Las velas de 1m de la ultima vela de la historia en adelante (la rueda
        // diaria arranca la tarde anterior: se compara la vela, no la hora).
        const nuevas = agrupar(m1.filter((x) => apertura(x.t, interval) >= u.t), interval, ahora);
        for (const n of nuevas) {
          const ult = serie[serie.length - 1];
          if (n.t === ult.t) {
            // La vela de la historia ya tiene su apertura y su volumen: solo se extiende.
            ult.h = Math.max(ult.h, n.h); ult.l = Math.min(ult.l, n.l); ult.c = n.c;
            ult.closed = ult.close_time < ahora;
          } else if (n.t > ult.t) {
            serie.push(n);
          }
        }
        for (const x of serie) x.closed = x.close_time < ahora;
        const limite = config.HISTORY[interval];
        this.destino.candles.set(`${symbol}|${interval}`, serie.length > limite ? serie.slice(-limite) : serie);
      }
      this.ticker(symbol);
    }
  }

  private ticker(symbol: string): void {
    const d = this.destino.candles.get(`${symbol}|1d`);
    const m = this.destino.candles.get(`${symbol}|1m`);
    if (!d?.length) return;
    const u = m?.length ? m[m.length - 1] : d[d.length - 1];
    const last = u.c;
    // Variacion contra el cierre de la rueda anterior a la del ultimo dato.
    const rueda = inicioDia(u.t);
    const previa = [...d].reverse().find((x) => x.t < rueda);
    this.destino.tickers[symbol] = {
      last,
      change_pct: previa ? (last - previa.c) / previa.c * 100 : undefined,
    };
  }
}
