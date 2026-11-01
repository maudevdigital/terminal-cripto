/* Indicadores calculados con las mismas formulas que Pine Script (TradingView),
 * incluido como arranca cada uno: con la historia completa dan los mismos valores
 * que el grafico de TradingView.
 *
 * Todas las funciones reciben y devuelven arrays alineados con la serie de velas
 * (indice 0 = vela mas antigua). Donde Pine da `na`, aca hay NaN. */

export type Serie = ArrayLike<number>;

// ---------------------------------------------------------------- utilidades

export const arr = (values: Serie): number[] => Array.from(values, Number);

const nanArr = (n: number): number[] => new Array(n).fill(NaN);

/** Media con suma compensada: queda a la par de la suma por pares de numpy. */
function media(v: number[], a: number, b: number): number {
  let s = 0, c = 0;
  for (let i = a; i < b; i++) {
    const y = v[i] - c;
    const t = s + y;
    c = (t - s) - y;
    s = t;
  }
  return s / (b - a);
}

export function sma(values: Serie, length: number): number[] {
  const v = arr(values);
  const out = nanArr(v.length);
  if (length <= 0 || v.length < length) return out;
  for (let i = length - 1; i < v.length; i++) out[i] = media(v, i - length + 1, i + 1);
  return out;
}

/** ta.ema de Pine:
 *    sum := na(sum[1]) ? src : alpha * src + (1 - alpha) * nz(sum[1])
 *  Arranca en el primer valor, sin esperar `length` velas: por eso en TradingView
 *  la EMA 200 tiene valor aunque el grafico tenga menos de 200 velas. */
export function ema(values: Serie, length: number): number[] {
  const v = arr(values);
  const out = nanArr(v.length);
  if (length <= 0) return out;
  const alpha = 2.0 / (length + 1.0);
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    prev = Number.isNaN(prev) ? v[i] : alpha * v[i] + (1.0 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** ta.rma de Pine (suavizado de Wilder):
 *    sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])
 *  Arranca en la primera ventana completa sin `na`, con su promedio. */
export function rma(values: Serie, length: number): number[] {
  const v = arr(values);
  const out = nanArr(v.length);
  if (length <= 0) return out;
  const alpha = 1.0 / length;
  const promedio = sma(v, length);
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    prev = Number.isNaN(prev) ? promedio[i] : alpha * v[i] + (1.0 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** fixnan de Pine: un `na` (o una division por cero) repite el ultimo valor valido. */
export function fixnan(values: Serie): number[] {
  let ultimo = NaN;
  return Array.from(values, (x) => (Number.isFinite(x) ? (ultimo = x) : ultimo));
}

/** Desviacion estandar poblacional movil (ta.stdev de Pine). */
export function stdev(values: Serie, length: number): number[] {
  const v = arr(values);
  const out = nanArr(v.length);
  if (length <= 0 || v.length < length) return out;
  for (let i = length - 1; i < v.length; i++) {
    const a = i - length + 1;
    const m = media(v, a, i + 1);
    let s = 0;
    for (let j = a; j <= i; j++) s += (v[j] - m) ** 2;
    out[i] = Math.sqrt(s / length);
  }
  return out;
}

function ventana(values: Serie, length: number, fn: (v: number[], a: number, b: number) => number): number[] {
  const v = arr(values);
  const out = nanArr(v.length);
  if (length <= 0 || v.length < length) return out;
  for (let i = length - 1; i < v.length; i++) out[i] = fn(v, i - length + 1, i + 1);
  return out;
}

const maxDe = (v: number[], a: number, b: number) => {
  let m = -Infinity;
  for (let i = a; i < b; i++) { if (Number.isNaN(v[i])) return NaN; if (v[i] > m) m = v[i]; }
  return m;
};
const minDe = (v: number[], a: number, b: number) => {
  let m = Infinity;
  for (let i = a; i < b; i++) { if (Number.isNaN(v[i])) return NaN; if (v[i] < m) m = v[i]; }
  return m;
};

export const highest = (values: Serie, length: number) => ventana(values, length, maxDe);
export const lowest = (values: Serie, length: number) => ventana(values, length, minDe);

/** ta.linreg: valor de la recta de regresion lineal en la barra actual. */
export function linreg(values: Serie, length: number, offset = 0): number[] {
  const v = arr(values);
  const n = v.length;
  const out = nanArr(n);
  if (length <= 1 || n < length) return out;
  let sx = 0, sxx = 0;
  for (let x = 0; x < length; x++) { sx += x; sxx += x * x; }
  const denom = length * sxx - sx * sx;
  for (let i = length - 1; i < n; i++) {
    const a = i - length + 1;
    let sy = 0, sxy = 0;
    for (let x = 0; x < length; x++) { sy += v[a + x]; sxy += v[a + x] * x; }
    const slope = (length * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / length;
    out[i] = intercept + slope * (length - 1 - offset);
  }
  return out;
}

/** ta.tr(handle_na) de Pine. En la primera vela no hay cierre anterior: con
 *  `manejarNa` (ta.tr(true), el que usa ta.atr) vale high - low; sin el (ta.tr,
 *  el que usan el DMI y el Squeeze de LazyBear) es `na`. */
export function trueRange(high: Serie, low: Serie, close: Serie, manejarNa = true): number[] {
  const h = arr(high), l = arr(low), c = arr(close);
  const tr = new Array<number>(h.length);
  if (!h.length) return tr;
  tr[0] = manejarNa ? h[0] - l[0] : NaN;
  for (let i = 1; i < h.length; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return tr;
}

// ---------------------------------------------------------------------- ADX

export interface AdxPack { plus_di: number[]; minus_di: number[]; adx: number[] }

/** El indicador "Directional Movement Index" de TradingView, linea por linea:
 *    up = ta.change(high), down = -ta.change(low)
 *    plusDM = na(up) ? na : (up > down and up > 0 ? up : 0)   (igual minusDM)
 *    trur = ta.rma(ta.tr, len)
 *    plus = fixnan(100 * ta.rma(plusDM, len) / trur)          (igual minus)
 *    adx = 100 * ta.rma(math.abs(plus - minus) / (sum == 0 ? 1 : sum), lensig)
 *  Devuelve +DI, -DI y ADX (DI Length y ADX Smoothing: 14 y 14 por defecto). */
export function adx(high: Serie, low: Serie, close: Serie, diLength = 14, adxLength = 14): AdxPack {
  const h = arr(high), l = arr(low);
  const n = h.length;
  const plusDm = nanArr(n), minusDm = nanArr(n);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const down = -(l[i] - l[i - 1]);
    plusDm[i] = up > down && up > 0 ? up : 0.0;
    minusDm[i] = down > up && down > 0 ? down : 0.0;
  }
  const trur = rma(trueRange(high, low, close, false), diLength);
  const rp = rma(plusDm, diLength), rm = rma(minusDm, diLength);
  // En Pine, dividir por cero da na: fixnan repite el valor anterior.
  const plus = fixnan(trur.map((t, i) => 100.0 * rp[i] / t));
  const minus = fixnan(trur.map((t, i) => 100.0 * rm[i] / t));
  const dx = plus.map((p, i) => {
    const total = p + minus[i];
    return Math.abs(p - minus[i]) / (total === 0 ? 1.0 : total);
  });
  return { plus_di: plus, minus_di: minus, adx: rma(dx, adxLength).map((x) => 100.0 * x) };
}

// ------------------------------------------------- Squeeze Momentum LazyBear

export const SQZ_COLORS = {
  up_strong: "#22e39a",   // momentum alcista creciendo
  up_weak: "#0f8f66",     // momentum alcista perdiendo fuerza
  down_strong: "#ff4d5e", // momentum bajista creciendo
  down_weak: "#93313c",   // momentum bajista perdiendo fuerza
};
export const SQZ_DOT_COLORS: Record<string, string> = {
  on: "#ff9f0a",   // compresion activa (BB dentro de KC)
  off: "#4ea1ff",  // compresion liberada
  none: "#6b7280", // sin definicion
};

export interface Squeeze {
  value: number[];
  colors: (string | null)[];
  state: string[];
  dot_colors: string[];
}

/** Squeeze Momentum [LazyBear], con la correccion del autor al multiplicador BB.
 *  Bollinger usa bbMult y Keltner usa kcMult. El codigo publicado inicialmente
 *  reutilizaba multKC para ambos; conservar ese error hacia inoperante BB MultFactor.
 *  Cambiar bbMult modifica la compresion, no el histograma de momentum. */
export function squeezeMomentum(high: Serie, low: Serie, close: Serie, bbLength = 20, bbMult = 2.0,
                                kcLength = 20, kcMult = 1.5, useTrueRange = true): Squeeze {
  const h = arr(high), l = arr(low), c = arr(close);
  const n = c.length;

  const basis = sma(c, bbLength);
  const dev = stdev(c, bbLength).map((x) => bbMult * x);
  const ma = sma(c, kcLength);
  // `tr` del original: na en la primera vela (no hay cierre anterior).
  const rng = useTrueRange ? trueRange(h, l, c, false) : h.map((x, i) => x - l[i]);
  const rangema = sma(rng, kcLength);

  const hh = highest(h, kcLength), ll = lowest(l, kcLength), mc = sma(c, kcLength);
  const delta = c.map((x, i) => x - ((hh[i] + ll[i]) / 2.0 + mc[i]) / 2.0);
  const val = linreg(delta, kcLength, 0);

  const colors: (string | null)[] = [];
  const state: string[] = [];
  const dotColors: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = val[i], p = i > 0 ? val[i - 1] : NaN;
    if (Number.isNaN(v)) colors.push(null);
    else if (v > 0) colors.push(Number.isNaN(p) || v > p ? SQZ_COLORS.up_strong : SQZ_COLORS.up_weak);
    else colors.push(Number.isNaN(p) || v < p ? SQZ_COLORS.down_strong : SQZ_COLORS.down_weak);

    const upperBb = basis[i] + dev[i], lowerBb = basis[i] - dev[i];
    const upperKc = ma[i] + rangema[i] * kcMult, lowerKc = ma[i] - rangema[i] * kcMult;
    const on = lowerBb > lowerKc && upperBb < upperKc;
    const off = lowerBb < lowerKc && upperBb > upperKc;
    const s = on ? "on" : (off ? "off" : "none");
    state.push(s);
    dotColors.push(SQZ_DOT_COLORS[s]);
  }
  return { value: val, colors, state, dot_colors: dotColors };
}

// ------------------------------------------------------------------- ATR

/** ta.atr de Pine: RMA de ta.tr(true). Sirve de unidad de ruido del activo. */
export function atr(high: Serie, low: Serie, close: Serie, length = 14): number[] {
  return rma(trueRange(high, low, close, true), length);
}
