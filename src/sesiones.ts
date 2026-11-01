/* Sesiones de mercado: Asia (Tokio), Londres y Nueva York, con el maximo y el
 * minimo de cada una. Cada nivel sigue vigente hasta que el precio lo toca despues
 * de cerrar la sesion (como el indicador de sesiones de TradingView "hasta que
 * se mitiga"): ahi suele haber stops, o sea liquidez.
 *
 * Los horarios van en la hora local de cada plaza, con su horario de verano:
 *   Tokio 09:00-18:00 · Londres 08:00-17:00 · Nueva York 08:00-17:00
 * Se cambian con SESIONES en el .env ("Nombre:Zona:HH:MM-HH:MM,..."). */

import type { Candle } from "./binance.ts";

export interface DefSesion { nombre: string; zona: string; desde: number; hasta: number }   // minutos del dia local
export interface Nivel { p: number; t: number; tomado: number | null }                     // t y tomado: segundos
export interface Sesion { nombre: string; inicio: number; fin: number; enCurso: boolean; max: Nivel; min: Nivel }

export const SESIONES_TV = "Asia:Asia/Tokyo:09:00-18:00,Londres:Europe/London:08:00-17:00,Nueva York:America/New_York:08:00-17:00";

const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export function leerSesiones(spec: string): DefSesion[] {
  const out: DefSesion[] = [];
  for (const parte of spec.split(",")) {
    const m = parte.trim().match(/^(.+?):([A-Za-z_]+\/[A-Za-z_/+-]+):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (m) out.push({ nombre: m[1].trim(), zona: m[2], desde: hm(m[3]), hasta: hm(m[4]) });
  }
  return out;
}

const formatos = new Map<string, Intl.DateTimeFormat>();
function partes(ms: number, zona: string) {
  let f = formatos.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatos.set(zona, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** La hora UTC (ms) de una hora local de `zona` en el dia local y/m/d. */
export function deLocal(y: number, m: number, d: number, minutos: number, zona: string): number {
  const deseado = Date.UTC(y, m - 1, d, Math.floor(minutos / 60), minutos % 60);
  let t = deseado;
  for (let i = 0; i < 3; i++) {   // dos vueltas alcanzan, tambien el dia del cambio de hora
    const p = partes(t, zona);
    t += deseado - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return t;
}

/** Las sesiones de los ultimos `dias` dias (la en curso incluida), con su maximo y
 *  minimo y si el precio ya los tomo. `velas`: de 5 minutos, en orden. */
export function sesiones(velas: Candle[], defs: DefSesion[], dias = 2, ahora = Date.now()): Sesion[] {
  if (!velas.length) return [];
  const out: Sesion[] = [];
  for (const def of defs) {
    const hoy = partes(ahora, def.zona);
    for (let k = dias + 1; k >= 0; k--) {
      const f = new Date(Date.UTC(hoy.y, hoy.m - 1, hoy.d - k));
      const inicio = deLocal(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), def.desde, def.zona) / 1000;
      let fin = deLocal(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), def.hasta, def.zona) / 1000;
      if (fin <= inicio) fin += 86_400;   // una sesion que cruza la medianoche
      if (inicio * 1000 > ahora || fin * 1000 < ahora - (dias + 1) * 86_400_000) continue;
      let max: Nivel | null = null, min: Nivel | null = null;
      let i = 0;
      while (i < velas.length && velas[i].t < inicio) i++;
      for (; i < velas.length && velas[i].t < fin; i++) {
        const v = velas[i];
        if (!max || v.h > max.p) max = { p: v.h, t: v.t, tomado: null };
        if (!min || v.l < min.p) min = { p: v.l, t: v.t, tomado: null };
      }
      if (!max || !min) continue;   // mercado cerrado (fin de semana, feriado)
      const enCurso = ahora < fin * 1000;
      // Despues de la sesion: la primera vela que pasa del nivel lo toma.
      if (!enCurso) {
        for (; i < velas.length && (max.tomado === null || min.tomado === null); i++) {
          if (max.tomado === null && velas[i].h > max.p) max.tomado = velas[i].t;
          if (min.tomado === null && velas[i].l < min.p) min.tomado = velas[i].t;
        }
      }
      out.push({ nombre: def.nombre, inicio, fin, enCurso, max, min });
    }
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}
