/* Temporalidades a medida: ademas de las de siempre (1m, 5m, 15m, 30m,
 * 1H, 4H, D, S, M), cualquier cantidad de minutos, horas, dias o semanas ("3m",
 * "10m", "2h", "12h", "2d", "2w"). Se arman juntando las velas de la temporalidad de
 * siempre mas grande que entra justo (3m con las de 1m, 10m con las de 5m, 2H con
 * las de 1H, 12H con las de 4H, 2D con las diarias): asi andan en vivo en todos los
 * mercados. Minutos, horas y dias se anclan al 01-01-1970 00:00 UTC; las semanas,
 * al lunes 05-01-1970 00:00 UTC. Recortar o ampliar historia no cambia los grupos.
 * Se agrupa por la apertura de la vela base, conservando solo los datos recibidos. */

import type { Candle } from "./binance.ts";

const SEG: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "1d": 86_400, "1w": 604_800 };
// Hasta cuanto se puede pedir de cada unidad.
const TOPE = { m: 1440, h: 24, d: 30, w: 12 } as const;

export interface Medida { n: number; unidad: "m" | "h" | "d" | "w"; seg: number }

/** "10m" -> { n: 10, unidad: "m", seg: 600 }; null si no es una temporalidad a medida. */
export function medida(interval: string): Medida | null {
  const m = /^(\d{1,4})([mhdw])$/.exec(interval);
  if (!m) return null;
  const n = Number(m[1]), unidad = m[2] as Medida["unidad"];
  if (!(n >= 1) || n > TOPE[unidad]) return null;
  return { n, unidad, seg: n * { m: 60, h: 3600, d: 86_400, w: 604_800 }[unidad] };
}

/** La temporalidad de siempre con que se arma `interval` (null si es de siempre o no se puede). */
export function base(interval: string, nativas: string[]): string | null {
  if (nativas.includes(interval)) return null;
  const m = medida(interval);
  if (!m) return null;
  if (m.unidad === "d") return nativas.includes("1d") ? "1d" : null;
  if (m.unidad === "w") return nativas.includes("1w") ? "1w" : null;
  const candidatas = ["4h", "1h", "30m", "15m", "5m", "1m"].filter((i) => nativas.includes(i) && m.seg % SEG[i] === 0 && SEG[i] < m.seg);
  return candidatas[0] ?? null;
}

/** Si se puede graficar: una de siempre, o una a medida que se arma con una de siempre. */
export function valida(interval: string, nativas: string[]): boolean {
  return nativas.includes(interval) || base(interval, nativas) !== null;
}

/** Apertura estable del periodo UTC, independiente del comienzo del buffer. */
export function aperturaMedida(t: number, m: Medida): number {
  const ancla = m.unidad === "w" ? 4 * 86_400 : 0;   // primer lunes desde epoch
  return ancla + Math.floor((t - ancla) / m.seg) * m.seg;
}

/** Junta las velas de la base en las de `interval`. */
export function agruparA(velas: Candle[], interval: string, ahoraMs = Date.now()): Candle[] {
  const m = medida(interval);
  if (!m || !velas.length) return [];
  const out: Candle[] = [];
  let actual: Candle | null = null;
  velas.forEach((x) => {
    const t = aperturaMedida(x.t, m);
    if (actual?.t !== t) {
      if (actual) out.push(actual);
      actual = { t, t_ms: t * 1000, close_time: (t + m.seg) * 1000 - 1, o: x.o, h: x.h, l: x.l, c: x.c, v: 0, vb: 0, trades: 0, closed: false };
    }
    const a: Candle = actual;
    a.h = Math.max(a.h, x.h); a.l = Math.min(a.l, x.l); a.c = x.c;
    a.v += x.v; a.vb += x.vb; a.trades += x.trades || 0;
    // El calendario cierra el periodo aunque haya fines de semana o huecos.
    // La falta de una vela no se rellena con precios o volumen inventados.
    a.closed = a.close_time < ahoraMs && x.closed;
  });
  if (actual) out.push(actual);
  return out;
}
