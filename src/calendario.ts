/* Calendario economico de FTMO: el mismo que muestra ftmo.com/calendar, con su
 * API publica (no necesita cuenta). Cada evento trae su impacto (alto, medio,
 * bajo) y si FTMO lo marca como restringido: en las cuentas fondeadas no se puede
 * abrir ni cerrar operaciones del instrumento 2 minutos antes y despues.
 *
 * Se guarda en memoria unos minutos por rango, para no pedirlo con cada envio. */

import { getLogger } from "./log.ts";
import { completar, type CalendarioMT5 } from "./calendarioMT5.ts";

const log = getLogger("calendario");
const API = "https://gw2.ftmo.com/public-api/v1/economic-calendar";
const VIGENCIA = 5 * 60_000;

export interface Evento {
  t: number;                  // ms UTC
  titulo: string;
  impacto: "high" | "medium" | "low" | string;
  moneda: string;             // instrumento de FTMO: USD, EUR, GBP...
  restringido: boolean;
  tipo: string;               // normal | holiday ...
  actual: string | null;
  pronostico: string | null;
  previo: string | null;
}

export function convertir(item: any): Evento | null {
  const t = Date.parse(String(item?.date ?? ""));
  if (!Number.isFinite(t)) return null;
  return {
    t, titulo: String(item.title ?? ""), impacto: String(item.impact ?? "low"), moneda: String(item.instrument ?? ""),
    restringido: Boolean(item.restriction), tipo: String(item.eventType ?? "normal"),
    actual: item.actual ?? null, pronostico: item.forecast ?? null, previo: item.previous ?? null,
  };
}

const fecha = (re: string) => /^\d{4}-\d{2}-\d{2}$/.test(re);

export class Calendario {
  private cache = new Map<string, { at: number; eventos: Evento[] }>();
  estado: { error: string | null; at: number | null } = { error: null, at: null };
  /** El calendario de MT5 (puente v9), para completar el dato real que FTMO no tiene todavia. */
  deMT5: () => CalendarioMT5 | null = () => null;

  /** Los eventos de `desde` a `hasta`, con el dato real de MT5 donde FTMO no lo tiene. */
  async eventos(desde: string, hasta: string, zona = "UTC"): Promise<Evento[]> {
    return completar(await this.deFTMO(desde, hasta, zona), this.deMT5());
  }

  /** Los eventos de FTMO de `desde` a `hasta` (fechas AAAA-MM-DD en la zona `zona`). */
  private async deFTMO(desde: string, hasta: string, zona: string): Promise<Evento[]> {
    if (!fecha(desde) || !fecha(hasta)) throw new Error("Fechas inválidas");
    const clave = `${desde}|${hasta}|${zona}`;
    const c = this.cache.get(clave);
    if (c && Date.now() - c.at < VIGENCIA) return c.eventos;
    try {
      const url = `${API}?${new URLSearchParams({ dateFrom: desde, dateTo: hasta, timezone: zona })}`;
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`FTMO respondió ${r.status}`);
      const j: any = await r.json();
      const eventos = (j.items ?? []).map(convertir).filter(Boolean).sort((a: Evento, b: Evento) => a.t - b.t) as Evento[];
      this.cache.set(clave, { at: Date.now(), eventos });
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      this.estado = { error: null, at: Date.now() };
      return eventos;
    } catch (exc) {
      this.estado.error = exc instanceof Error ? exc.message : String(exc);
      log.warn(`Calendario de FTMO: ${this.estado.error}`);
      if (c) return c.eventos;   // el ultimo que se tuvo
      throw exc;
    }
  }

  /** Las noticias importantes (restringidas o de alto impacto) de las proximas
   *  `horas`, y las que pasaron hace menos de 5 minutos. */
  async proximas(horas = 24, ahora = Date.now()): Promise<Evento[]> {
    const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const todos = await this.eventos(d(ahora - 86_400_000), d(ahora + horas * 3_600_000 + 86_400_000));
    return todos.filter((e) => (e.restringido || e.impacto === "high") && e.t >= ahora - 5 * 60_000 && e.t <= ahora + horas * 3_600_000);
  }
}
