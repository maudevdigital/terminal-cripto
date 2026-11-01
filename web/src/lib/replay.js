/* Replay del grafico: un mercado hasta un instante elegido, que avanza vela a vela.
   Todo se arma en el navegador con la historia que manda el servidor (/api/replay,
   velas de FTMO): cada temporalidad con su vela en curso a medio formar y sus
   indicadores, con lo que se sabia en ese instante.

   La historia de 1 minuto llega unos 3 meses atras (el tope de MT5); antes, 5m y
   15m se arman con la de 5 minutos (1,4 anos) y 1H, 4H y diario con las suyas
   (anos). En 1m, antes de la de 1 minuto no hay velas. */

import { armarGrafico } from "./graficoVelas.js";
import { agruparA, base as baseMedida, medida } from "../../../src/temporalidades.ts";

/** Duracion de cada vela (segundos): lo que avanza un paso del replay. */
export const PASO = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "1d": 86_400, "1w": 604_800 };

/** Duracion nativa o a medida; los meses requieren calendario y no se aproximan. */
export function paso(interval) {
  return PASO[interval] ?? medida(interval)?.seg ?? null;
}

const VISIBLES = 1500;        // velas que van al grafico (al llegar al borde izquierdo se suman mas)
const MAX_VISIBLES = 48_000;
const CALENTAR = 600;         // y las de antes, para que las medias y el ADX lleguen asentados
const FECHA = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" });

const desplegar = (a, d) => (a ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, d }));

/** Primer indice con t >= x. */
function indice(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m].t < x) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Junta velas en grupos de `p` segundos (alineados a la hora). */
function agrupar(velas, p) {
  const out = [];
  for (const x of velas) {
    const t = x.t - (x.t % p);
    const u = out[out.length - 1];
    if (u && u.t === t) {
      u.h = Math.max(u.h, x.h); u.l = Math.min(u.l, x.l); u.c = x.c; u.v += x.v;
    } else {
      out.push({ t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
    }
  }
  return out;
}

export class Replay {
  constructor(datos, cfg) {
    this.cfg = cfg;
    this.symbol = datos.symbol;
    this.m1 = desplegar(datos.m1, 60);
    this.m5 = desplegar(datos.m5, 300);     // solo lo de antes de la de 1 minuto
    this.h1 = desplegar(datos.h1);
    this.h4 = desplegar(datos.h4);
    this.d1 = desplegar(datos.d1);
    this.w1 = desplegar(datos.w1);
    this.cursor = null;            // instante (s): se ve lo que paso antes
    this.visibles = VISIBLES;
  }

  get inicioM1() {
    return this.m1[0]?.t ?? Infinity;
  }

  /** Desde y hasta donde se puede hacer replay en cada temporalidad (s). */
  rango(interval) {
    const ultimo = this.m1.at(-1)?.t + 60;
    const b = !PASO[interval] ? baseMedida(interval, Object.keys(PASO)) : null;
    if (b) return this.rango(b);
    if (interval === "1w" && !this.w1.length) return this.rango("1d");
    const base = interval === "1m" ? this.m1
      : PASO[interval] <= 1800 ? (this.m5.length ? this.m5 : this.m1)
        : interval === "1h" ? this.h1 : interval === "4h" ? this.h4 : interval === "1w" ? this.w1 : this.d1;
    // Unas velas de margen al principio, para que haya algo antes del instante.
    return { desde: base[Math.min(base.length - 1, 300)]?.t ?? 0, hasta: Number.isFinite(ultimo) ? ultimo : (base.at(-1)?.t ?? 0) + (paso(interval) ?? 0) };
  }

  /** El instante del replay, en el borde de una vela de 1 minuto. Vuelve a la cantidad
   *  de velas de siempre. */
  irA(t) {
    const { hasta } = this.rango("1m");
    this.cursor = Math.min(Math.floor(t / 60) * 60, hasta);
    this.visibles = VISIBLES;
  }

  /** Avanza `seg` segundos y devuelve las velas que se completaron (de 1 minuto, o de
   *  5 antes de la historia de 1 minuto): con ellas se llenan y cierran las simuladas. */
  avanzar(seg) {
    const antes = this.cursor;
    const { hasta } = this.rango("1m");
    this.cursor = Math.min(this.cursor + seg, hasta);
    return this.velasPaso(antes, this.cursor);
  }

  get alFinal() {
    return this.cursor >= this.rango("1m").hasta;
  }

  /** Las velas mas finas que cerraron entre dos instantes (cada una con su duracion, `d`). */
  velasPaso(a, b) {
    // Las de 5 minutos que terminan en el paso (aunque hayan empezado antes).
    const m5 = a < this.inicioM1 ? this.m5.slice(indice(this.m5, a - 299), indice(this.m5, Math.min(b - 299, this.inicioM1))) : [];
    return m5.concat(this.m1.slice(indice(this.m1, a), indice(this.m1, b - 59)));
  }

  /** Mas velas hacia atras en el grafico (al llegar a su borde izquierdo). */
  masHistoria() {
    if (this.visibles >= MAX_VISIBLES) return false;
    this.visibles = Math.min(this.visibles * 2, MAX_VISIBLES);
    return true;
  }

  /** Las ultimas velas de una temporalidad hasta el cursor: las cerradas y la que
   *  esta en curso, armada con lo que ya paso. */
  serie(interval, cantidad = this.visibles + CALENTAR) {
    const cur = this.cursor, p = PASO[interval];
    if (!p || (interval === "1w" && !this.w1.length)) {
      const b = interval === "1w" ? "1d" : baseMedida(interval, Object.keys(PASO));
      if (!b) return [];
      const duracion = paso(interval), factor = duracion / PASO[b];
      const fuente = this.serie(b, Math.ceil(cantidad * factor) + 1);
      const velas = fuente.map((x) => ({ ...x, t_ms: x.t * 1000, close_time: (x.t + PASO[b]) * 1000 - 1, vb: x.vb ?? 0, trades: x.trades ?? 0 }));
      return agruparA(velas, interval, cur * 1000).slice(-cantidad);
    }
    if (p <= 1800) {
      const fin = indice(this.m1, cur);
      const ini = Math.max(0, fin - cantidad * (p / 60));
      let base = this.m1.slice(ini, fin);
      // Antes de la historia de 1 minuto, la de 5 minutos (solo velas cerradas).
      if (interval !== "1m" && ini === 0 && this.m5.length) {
        const fin5 = indice(this.m5, Math.min(this.inicioM1, cur - 299));
        const quedan = Math.ceil(cantidad * (p / 300) - base.length / 5);
        if (quedan > 0) base = this.m5.slice(Math.max(0, fin5 - quedan), fin5).concat(base);
      }
      return agrupar(base, p).map((x) => ({ ...x, closed: x.t + p <= cur }));
    }
    const base = interval === "1h" ? this.h1 : interval === "4h" ? this.h4 : interval === "1w" ? this.w1 : this.d1;
    const k = indice(base, cur);
    let fin = k;
    while (fin > 0 && base[fin - 1].t + p > cur) fin--;
    const out = base.slice(Math.max(0, fin - cantidad), fin).map((x) => ({ ...x, closed: true }));
    // La vela en curso: desde su apertura hasta el cursor, con la historia mas fina que haya.
    let t0 = fin < k ? base[fin].t : null;
    if (t0 === null && interval === "1h") t0 = cur - (cur % 3600);
    if (t0 !== null && t0 < cur) {
      const enM1 = this.m1.length && t0 >= this.inicioM1;
      const enM5 = !enM1 && this.m5.length && t0 >= this.m5[0].t;
      const fuente = enM1 ? this.m1 : enM5 ? this.m5 : this.h1;
      const pf = enM1 ? 60 : enM5 ? 300 : 3600;
      const parte = fuente.slice(indice(fuente, t0), indice(fuente, cur - pf + 1));
      if (parte.length) {
        const v = { t: t0, o: parte[0].o, h: -Infinity, l: Infinity, c: parte.at(-1).c, v: 0, closed: false };
        for (const x of parte) { v.h = Math.max(v.h, x.h); v.l = Math.min(v.l, x.l); v.v += x.v; }
        out.push(v);
      }
    }
    return out;
  }

  /** Lo que necesita el grafico (como lo manda el servidor): velas, EMAs, squeeze y ADX. */
  grafico(interval, tail = null) {
    const series = this.serie(interval);
    if (!series.length) return null;
    return armarGrafico(series, this.cfg, Math.max(0, series.length - (tail ?? this.visibles)));
  }

  /** El paquete que recibe el grafico (como el del servidor, sin la cuenta). */
  payload(interval, tipo = "snapshot") {
    if (!paso(interval)) return { ok: false, symbol: this.symbol, interval, error: `El replay no admite ${interval}. Para meses se necesita historia mensual por calendario; elige una temporalidad en minutos, horas, dias o semanas.` };
    const grafico = this.grafico(interval, tipo === "snapshot" ? null : 3);
    if (!grafico) {
      const { desde } = this.rango(interval);
      const error = this.cursor < desde
        ? `En ${interval} el replay empieza el ${FECHA.format(desde * 1000)}${interval === "1m" ? " (lo que guarda MT5 de 1 minuto)" : ""}. Elige una fecha posterior o una temporalidad más grande.`
        : "Sin velas en ese instante.";
      return { ok: false, symbol: this.symbol, interval, error };
    }
    return {
      ok: true, type: tipo, symbol: this.symbol, interval, grafico,
      broker: null, precio: grafico.velas.at(-1)?.close ?? null, replay: this.cursor,
      fuente: medida(interval)?.unidad === "w" && !this.w1.length
        ? { nombre: "FTMO · semanas UTC agrupadas desde velas diarias", broker: true, ultimoDato: this.cursor * 1000, agrupacionUTC: true }
        : null,
    };
  }
}
