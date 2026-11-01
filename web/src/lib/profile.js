/* Perfiles de volumen calculados en el navegador sobre lo que hay en pantalla:
   el del rango visible (VPVR) y uno por sesion (VPSV), que se pueden ver juntos.
   Por defecto como en TradingView: 24 filas y area de valor del 70 %. */

export const FILAS_TV = 24;

// Sesion segun temporalidad: en intradia la sesion natural es el dia; en
// temporalidades altas un dia seria una sola vela, asi que se agrupa mas grueso.
const SESSION_BY_INTERVAL = { "5m": "día", "15m": "día", "30m": "día", "1h": "día", "4h": "semana", "1d": "mes", "1w": "año", "1M": "año" };

export function sessionKind(interval) {
  return SESSION_BY_INTERVAL[interval] || "día";
}

function sessionKey(timeSec, kind) {
  const d = new Date(timeSec * 1000);
  if (kind === "día") return Math.floor(timeSec / 86400);
  if (kind === "semana") return Math.floor((timeSec - 345600) / 604800);  // semanas de lunes
  if (kind === "mes") return d.getUTCFullYear() * 12 + d.getUTCMonth();
  return d.getUTCFullYear();
}

/** Perfil de volumen de un tramo de velas.
 *  El volumen de cada vela se reparte proporcionalmente entre los niveles que
 *  cubre su rango high-low, y se separa en compra y venta con el taker buy
 *  volume de Binance. */
export function computeProfile(bars, bins = FILAS_TV, valueArea = 0.70) {
  if (!bars || !bars.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  if (!(hi > lo)) return null;

  const size = (hi - lo) / bins;
  const buy = new Float64Array(bins);
  const sell = new Float64Array(bins);

  for (const b of bars) {
    const span = b.high - b.low;
    if (span <= 0) {
      const k = Math.min(bins - 1, Math.max(0, Math.floor((b.high - lo) / size)));
      buy[k] += b.buy; sell[k] += b.sell;
      continue;
    }
    const k0 = Math.max(0, Math.floor((b.low - lo) / size));
    const k1 = Math.min(bins - 1, Math.floor((b.high - lo) / size));
    for (let k = k0; k <= k1; k++) {
      const top = Math.min(b.high, lo + (k + 1) * size);
      const bot = Math.max(b.low, lo + k * size);
      const w = Math.max(0, top - bot) / span;
      if (w > 0) { buy[k] += b.buy * w; sell[k] += b.sell * w; }
    }
  }

  let total = 0, maxBin = 0, poc = 0;
  const tot = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    tot[k] = buy[k] + sell[k];
    total += tot[k];
    if (tot[k] > maxBin) { maxBin = tot[k]; poc = k; }
  }
  if (total <= 0) return null;

  // Value area: se expande desde el POC hacia el lado con mas volumen.
  let loI = poc, hiI = poc, acc = tot[poc];
  const target = total * valueArea;
  while (acc < target && (loI > 0 || hiI < bins - 1)) {
    const below = loI > 0 ? tot[loI - 1] : -1;
    const above = hiI < bins - 1 ? tot[hiI + 1] : -1;
    if (above >= below) acc += tot[++hiI];
    else acc += tot[--loI];
  }

  const out = [];
  let buyT = 0, sellT = 0;
  for (let k = 0; k < bins; k++) {
    buyT += buy[k]; sellT += sell[k];
    out.push({
      low: lo + k * size, high: lo + (k + 1) * size,
      buy: buy[k], sell: sell[k], total: tot[k],
      in_va: k >= loI && k <= hiI,
    });
  }
  return {
    bins: out, maxBin, total, buy: buyT, sell: sellT, bars: bars.length,
    poc: lo + (poc + 0.5) * size,
    val: lo + loI * size,
    vah: lo + (hiI + 1) * size,
  };
}

/** Perfil del rango visible (VPVR). */
export function perfilRango(bars, filas = FILAS_TV) {
  return bars.length ? computeProfile(bars, filas) : null;
}

/** Un perfil por sesion (VPSV) sobre las velas visibles. `from` es el indice
 *  logico de la primera vela visible. */
export function perfilSesiones(interval, bars, from, filas = FILAS_TV) {
  if (!bars.length) return [];
  const kind = sessionKind(interval);
  const sessions = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const k = sessionKey(bars[i].time, kind);
    if (!cur || cur.key !== k) { cur = { key: k, bars: [], i0: i, i1: i }; sessions.push(cur); }
    cur.bars.push(bars[i]);
    cur.i1 = i;
  }
  for (const s of sessions) {
    s.prof = computeProfile(s.bars, filas);
    s.from = from + s.i0;
    s.to = from + s.i1;
  }
  return sessions.filter((s) => s.prof);
}
