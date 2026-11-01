/* Las series del grafico (velas, EMAs, squeeze y ADX) armadas en el navegador con
   los mismos calculos que el servidor (src/market.ts). Las usan el replay y el
   grafico cuando suma velas viejas: con toda la serie junta, las medias y el ADX
   quedan iguales que si hubieran llegado de una vez. */

import * as ind from "../../../src/indicators.ts";

// Colores del panel inferior: los mismos que manda el servidor (ChartEngine los pasa a la paleta).
const SQZ = {
  subeFuerte: "#00E676", subeDebil: "#1B8A3A", bajaFuerte: "#FF1744", bajaDebil: "#8B0000",
  comprimido: "#FF9800", liberado: "#787B86", neutro: "#2962FF",
  adxSube: "#E8EAED", adxBaja: "#787B86",
};
const isNum = Number.isFinite;

/** `series`: velas en orden ({t, o, h, l, c, v, closed, buy?}). Devuelve lo que
 *  recibe el grafico desde la vela `desde` (las anteriores solo asientan las medias). */
export function armarGrafico(series, cfg, desde = 0) {
  const { adx: [diLen, adxLen], sqz: [bbLen, bbMult, kcLen, kcMult, tr] } = cfg.indicadores;
  const t = series.map((x) => x.t), h = series.map((x) => x.h), l = series.map((x) => x.l), c = series.map((x) => x.c);
  const sq = ind.squeezeMomentum(h, l, c, bbLen, bbMult, kcLen, kcMult, tr);
  const dmi = ind.adx(h, l, c, diLen, adxLen);
  const linea = (vals) => {
    const out = [];
    for (let i = desde; i < series.length; i++) if (isNum(vals[i])) out.push({ time: t[i], value: vals[i] });
    return out;
  };
  const out = {
    velas: series.slice(desde).map((x) => {
      const buy = x.buy ?? (x.h > x.l ? x.v * (x.c - x.l) / (x.h - x.l) : x.v / 2);
      return { time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v, buy, sell: x.sell ?? Math.max(x.v - buy, 0), closed: x.closed };
    }),
    ema: (cfg.ema ?? [10, 50, 200]).map((n) => linea(ind.ema(c, n))),
    momento: [], compresion: [], fuerza: [],
  };
  for (let i = desde; i < series.length; i++) {
    const v = sq.value[i];
    if (isNum(v)) {
      const prev = i > 0 && isNum(sq.value[i - 1]) ? sq.value[i - 1] : 0;
      out.momento.push({ time: t[i], value: v, color: v > 0 ? (v > prev ? SQZ.subeFuerte : SQZ.subeDebil) : (v < prev ? SQZ.bajaFuerte : SQZ.bajaDebil) });
    }
    const st = sq.state[i];
    out.compresion.push({ time: t[i], value: 0, color: st === "on" ? SQZ.comprimido : st === "off" ? SQZ.liberado : SQZ.neutro });
    if (isNum(dmi.adx[i])) {
      const sube = i > 0 && dmi.adx[i] > dmi.adx[i - 1];
      out.fuerza.push({ time: t[i], value: dmi.adx[i], color: sube ? SQZ.adxSube : SQZ.adxBaja });
    }
  }
  return out;
}

/** Las velas del grafico ({time, open, ...}) en el formato de `armarGrafico`. */
export const desdeGrafico = (v) => ({ t: v.time, o: v.open, h: v.high, l: v.low, c: v.close, v: v.volume ?? 0, closed: v.closed, buy: v.buy, sell: v.sell });
