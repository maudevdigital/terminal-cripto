/* Dominancia de USDT (USDT.D), reconstruida con datos gratuitos de CoinGecko.
 *
 * Binance no la publica, y la historia de la capitalizacion total en CoinGecko
 * es de pago. Pero la de cada moneda es gratis, hora por hora, 30 dias atras:
 *
 *   USDT.D(t) = capitalizacion de USDT(t) / total(t)
 *   total(t)  ≈ suma de las 10 mayores(t) × (total de hoy / suma de hoy)
 *
 * Comparada con CRYPTOCAP:USDT.D de TradingView: los cambios hora a hora
 * coinciden en 0,99 y queda del mismo lado de la EMA 50 el 92 % de las horas. El
 * nivel queda unas centesimas abajo (CoinGecko cuenta otras monedas en el total).
 *
 * El plan gratuito de CoinGecko corta rapido (429), asi que:
 *   - la historia se reconstruye una sola vez y se guarda en disco;
 *   - despues alcanza con /global (una llamada) cada pocos minutos;
 *   - si la app estuvo apagada y falta un tramo, se vuelve a reconstruir;
 *   - siempre se respeta el Retry-After que manda CoinGecko. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "./binance.ts";
import { config } from "./config.ts";
import { getLogger } from "./log.ts";

const log = getLogger("usdtd");
const API = "https://api.coingecko.com/api/v3";
const HORA = 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SIMBOLO = "USDT.D";

class Limitado extends Error {
  esperaMs: number;
  constructor(esperaMs: number) {
    super("CoinGecko limitó las llamadas");
    this.esperaMs = esperaMs;
  }
}

async function pedir(ruta: string): Promise<any> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = config.COINGECKO_API_KEY;
  const r = await fetch(API + ruta, { headers, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) {
    const seg = Number(r.headers.get("retry-after")) || 60;
    throw new Limitado((seg + 2) * 1000);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${ruta}`);
  return r.json();
}

/** Reintenta lo que CoinGecko limita, esperando lo que pide. */
async function pedirConEspera(ruta: string, alEsperar: (ms: number) => void): Promise<any> {
  for (let intento = 0; intento < 6; intento++) {
    try {
      return await pedir(ruta);
    } catch (exc) {
      if (!(exc instanceof Limitado)) throw exc;
      alEsperar(exc.esperaMs);
      await sleep(exc.esperaMs);
    }
  }
  throw new Error("CoinGecko sigue limitando las llamadas");
}

function vela(t: number, o: number, c: number, cerrada: boolean): Candle {
  return {
    t, t_ms: t * 1000, close_time: (t + HORA) * 1000 - 1,
    o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0, vb: 0, trades: 0, closed: cerrada,
  };
}

/** Agrupa velas de 1h en velas de `horas` (4h, 1d), alineadas en UTC. */
export function agrupar(v1h: Candle[], horas: number, ahoraMs = Date.now()): Candle[] {
  if (!Number.isInteger(horas) || horas < 1) return [];
  const out: Candle[] = [];
  for (const x of v1h) {
    const t = Math.floor(x.t / (horas * HORA)) * horas * HORA;
    const u = out[out.length - 1];
    if (u && u.t === t) {
      u.h = Math.max(u.h, x.h); u.l = Math.min(u.l, x.l); u.c = x.c;
      u.v += x.v; u.vb += x.vb; u.trades += x.trades;
    } else {
      out.push({ ...x, t, t_ms: t * 1000, close_time: (t + horas * HORA) * 1000 - 1 });
    }
    const actual = out[out.length - 1];
    actual.closed = actual.close_time < ahoraMs && x.closed;
  }
  return out;
}

export class Dominancia {
  velas: Candle[] = [];               // 1h
  valor: number | null = null;        // ultimo valor en vivo (%)
  cambio24h: number | null = null;
  listo = false;
  estado = "Cargando USDT.D desde CoinGecko…";
  private activo = true;
  private onCambio: () => void;
  private archivo = join(config.DATOS, "usdtd.json");

  constructor(onCambio: () => void) {
    this.onCambio = onCambio;
  }

  stop(): void {
    this.activo = false;
  }

  /** Corre en segundo plano: la app no lo espera. */
  async start(): Promise<void> {
    this.cargarDisco();
    while (this.activo) {
      try {
        // Sin historia, o con un hueco de mas de 3 horas (la app estuvo apagada): reconstruir.
        const ultima = this.velas.length ? this.velas[this.velas.length - 1].t : 0;
        if (!this.listo || Date.now() / 1000 - ultima > 3 * HORA) await this.historia();
        else await this.enVivo();
      } catch (exc) {
        this.estado = `USDT.D sin datos por ahora: ${exc instanceof Error ? exc.message : exc}`;
        log.warn(this.estado);
      }
      await sleep(config.USDTD_CADA * 1000);
    }
  }

  private esperando = (ms: number) => {
    this.estado = `CoinGecko pidió esperar ${Math.round(ms / 1000)} s: se reintenta solo`;
    log.info(this.estado);
  };

  private cargarDisco(): void {
    try {
      if (!existsSync(this.archivo)) return;
      const d = JSON.parse(readFileSync(this.archivo, "utf8"));
      if (Array.isArray(d.velas) && d.velas.length > 60) {
        this.velas = d.velas.map((x: any) => vela(x.t, x.o, x.c, (x.t + HORA) * 1000 <= Date.now())).map((v: Candle, i: number) => ({
          ...v, h: d.velas[i].h, l: d.velas[i].l,
        }));
        this.listo = true;
        const u = this.velas[this.velas.length - 1];
        this.valor = u.c;
        this.estado = "USDT.D recuperada del disco";
        log.info(`USDT.D recuperada del disco: ${this.velas.length} velas de 1h`);
        this.onCambio();
      }
    } catch (exc) {
      log.warn(`USDT.D en disco ilegible, se reconstruye: ${exc}`);
    }
  }

  private guardar(): void {
    try {
      mkdirSync(config.DATOS, { recursive: true });
      const tmp = this.archivo.replace(/\.json$/, ".tmp");
      const velas = this.velas.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c }));
      writeFileSync(tmp, JSON.stringify({ guardado: Math.trunc(Date.now() / 1000), velas }), "utf8");
      renameSync(tmp, this.archivo);
    } catch (exc) {
      log.warn(`No se pudo guardar USDT.D: ${exc}`);
    }
  }

  private async historia(): Promise<void> {
    const ids = config.USDTD_MONEDAS;
    this.estado = `Reconstruyendo USDT.D (0 de ${ids.length} monedas)…`;
    const caps = new Map<string, Map<number, number>>();
    for (const [k, id] of ids.entries()) {
      const datos = await pedirConEspera(`/coins/${id}/market_chart?vs_currency=usd&days=30`, this.esperando);
      const m = new Map<number, number>();
      for (const [t, v] of datos.market_caps as [number, number][]) m.set(Math.floor(t / 1000 / HORA) * HORA, v);
      caps.set(id, m);
      this.estado = `Reconstruyendo USDT.D (${k + 1} de ${ids.length} monedas)…`;
      await sleep(config.COINGECKO_API_KEY ? 2_500 : 15_000);
    }
    const g = (await pedirConEspera("/global", this.esperando)).data;
    const horas = [...(caps.get("tether") ?? new Map()).keys()].sort((a, b) => a - b)
      .filter((h) => ids.every((id) => caps.get(id)!.has(h)));
    if (horas.length < 60) throw new Error("historia de CoinGecko incompleta");
    const suma = (h: number) => ids.reduce((s, id) => s + caps.get(id)!.get(h)!, 0);
    const factor = g.total_market_cap.usd / suma(horas[horas.length - 1]);
    const crudo = horas.map((h) => ({ h, d: caps.get("tether")!.get(h)! / (suma(h) * factor) * 100 }));
    // El ultimo punto se ajusta al valor exacto de /global; el resto en la misma proporcion.
    const ajuste = g.market_cap_percentage.usdt / crudo[crudo.length - 1].d;

    // El punto de la hora h es el cierre de la vela que empezo una hora antes.
    const velas: Candle[] = [];
    let prev = crudo[0].d * ajuste;
    for (const p of crudo.slice(1)) {
      const c = p.d * ajuste;
      velas.push(vela(p.h - HORA, prev, c, true));
      prev = c;
    }
    this.velas = velas;
    this.listo = true;
    this.actualizar(g.market_cap_percentage.usdt);
    log.info(`USDT.D reconstruida: ${velas.length} velas de 1h, ahora ${this.valor?.toFixed(3)} %`);
  }

  private async enVivo(): Promise<void> {
    const g = (await pedirConEspera("/global", this.esperando)).data;
    this.actualizar(g.market_cap_percentage.usdt);
  }

  /** Suma un valor en vivo a la vela de la hora en curso y lo guarda. */
  private actualizar(valor: number): void {
    if (!Number.isFinite(valor) || valor <= 0 || valor > 100) throw new Error("Dominancia de USDT invalida");
    const ahora = Math.floor(Date.now() / 1000 / HORA) * HORA;
    const u = this.velas[this.velas.length - 1];
    if (u && u.t === ahora) {
      u.c = valor; u.h = Math.max(u.h, valor); u.l = Math.min(u.l, valor);
    } else {
      if (u) u.closed = true;
      this.velas.push(vela(ahora, u ? u.c : valor, valor, false));
    }
    if (this.velas.length > 1000) this.velas.splice(0, this.velas.length - 1000);
    this.valor = valor;
    const hace24 = this.velas.find((x) => x.t >= ahora - 24 * HORA);
    this.cambio24h = hace24 ? (valor - hace24.o) / hace24.o * 100 : null;
    this.estado = "En vivo";
    this.guardar();
    this.onCambio();
  }
}
