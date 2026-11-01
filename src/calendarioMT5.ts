/* El dato real de las noticias desde el calendario economico de MT5 (el de
 * MetaQuotes, que exporta el puente v9 en calendario.json): el de FTMO a veces tarda
 * en publicarlo, y MT5 lo tiene al segundo. Solo se completa lo que FTMO dejo vacio.
 *
 * Los nombres no coinciden (FTMO dice "Federal Funds Rate" y MetaQuotes "Fed Interest
 * Rate Decision"), asi que se empareja por moneda y hora (2 minutos de margen) y,
 * entre los de esa hora, por el anterior y el estimado (las mismas cifras) o, si no,
 * por las palabras del nombre. A un evento sin cifras (un discurso, un comunicado) no
 * se le pega ninguna. */

import type { Evento } from "./calendario.ts";

export interface EventoMT5 { time: number; moneda: string; nombre: string; actual: string; estimado: string; anterior: string }
export interface CalendarioMT5 { gmt_offset: number; eventos: EventoMT5[] }

const MONEDAS = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY"]);
// Lo de FTMO que no es una moneda pero se mueve con una.
const DE_USD = /crude oil|natgas|us indices|dxy|xauusd/i;

/** Las monedas de un instrumento de FTMO ("USD + US Indices + XAUUSD + DXY" -> USD). */
export function monedas(instrumento: string): string[] {
  const out = new Set(instrumento.split(/[^A-Za-z]+/).map((x) => x.toUpperCase()).filter((x) => MONEDAS.has(x)));
  if (!out.size && DE_USD.test(instrumento)) out.add("USD");
  return [...out];
}

/** Una cifra del calendario ("4 %", "-1.9 M", "4.00 %") como numero, o null. */
export function cifra(texto: string | null | undefined): number | null {
  const m = String(texto ?? "").replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*([KMBT])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] ?? "").toUpperCase() as "K"] ?? 1;
  return Number(m[1]) * mult;
}
const iguales = (a: string | null, b: string) => {
  const x = cifra(a), y = cifra(b);
  return x !== null && y !== null && Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6);
};
const palabras = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 2));

/** Los eventos de FTMO con el dato real de MT5 donde FTMO no lo tiene todavia
 *  (marcados con `fuenteActual: "mt5"`). */
export function completar(eventos: Evento[], mt5: CalendarioMT5 | null | undefined): (Evento & { fuenteActual?: "mt5" })[] {
  if (!mt5?.eventos?.length) return eventos;
  const offset = Number(mt5.gmt_offset) || 0;
  const usados = new Set<EventoMT5>();
  return eventos.map((e) => {
    if (e.actual || !(e.previo || e.pronostico)) return e;
    const mon = monedas(e.moneda);
    const candidatos = mt5.eventos.filter((m) => m.actual && !usados.has(m) && mon.includes(m.moneda)
      && Math.abs((m.time - offset) * 1000 - e.t) <= 120_000);
    let mejor: EventoMT5 | null = null, puntos = 0;
    const pe = palabras(e.titulo);
    for (const m of candidatos) {
      let p = 0;
      if (e.previo && iguales(e.previo, m.anterior)) p += 3;
      if (e.pronostico && iguales(e.pronostico, m.estimado)) p += 3;
      for (const w of palabras(m.nombre)) if (pe.has(w)) p += 1;
      if (p > puntos) { puntos = p; mejor = m; }
    }
    if (!mejor) return e;
    usados.add(mejor);
    return { ...e, actual: mejor.actual, fuenteActual: "mt5" as const };
  });
}
