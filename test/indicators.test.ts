// Los indicadores contra Pine Script: cada uno se compara, vela por vela, con una
// traduccion literal del codigo de TradingView ("the same on pine" de la
// referencia de Pine v5 y el codigo de los indicadores publicos), ejecutada como
// lo hace Pine: una vela a la vez, con na, nz y fixnan.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ind from "../src/indicators.ts";

// Generador con semilla: la serie es aleatoria pero siempre la misma.
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mu: number, sd: number) => mu + sd * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const uniforme = (a: number, b: number) => a + (b - a) * u();
  return { normal, uniforme };
}

const r = rng(7);
const n = 400;
const close: number[] = [];
let acc = 0;
for (let i = 0; i < n; i++) { acc += r.normal(0, 1); close.push(100 + acc); }
const high = close.map((c) => c + r.uniforme(0.1, 2));
const low = close.map((c) => c - r.uniforme(0.1, 2));
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

// ------------------------------------------------- Pine, una vela a la vez

const na = NaN;
const isna = (x: number) => Number.isNaN(x);
const nz = (x: number) => (isna(x) ? 0 : x);
/** Una serie de Pine: x(i) es el valor en la vela i; x(i - 1) es x[1]. */
type S = (i: number) => number;
const serie = (v: number[]): S => (i) => (i < 0 ? na : v[i]);
/** Calcula una funcion "vela a vela" que puede mirar su propio pasado. */
function porVela(f: (i: number, propio: S) => number): number[] {
  const out: number[] = [];
  const propio: S = (i) => (i < 0 ? na : out[i]);
  for (let i = 0; i < n; i++) out.push(f(i, propio));
  return out;
}
// pine_sma: sum := sum + x[i] / y, para i = 0 .. y-1 (na si hay algun na)
const pineSma = (x: S, y: number) => porVela((i) => {
  let sum = 0;
  for (let k = 0; k < y; k++) sum = sum + x(i - k) / y;
  return sum;
});
// pine_ema: sum := na(sum[1]) ? src : alpha * src + (1 - alpha) * nz(sum[1])
const pineEma = (src: S, length: number) => {
  const alpha = 2 / (length + 1);
  return porVela((i, sum) => (isna(sum(i - 1)) ? src(i) : alpha * src(i) + (1 - alpha) * nz(sum(i - 1))));
};
// pine_rma: sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])
const pineRma = (src: S, length: number) => {
  const alpha = 1 / length;
  const s = serie(pineSma(src, length));
  return porVela((i, sum) => (isna(sum(i - 1)) ? s(i) : alpha * src(i) + (1 - alpha) * nz(sum(i - 1))));
};
// ta.tr(handle_na)
const pineTr = (handleNa: boolean) => porVela((i) => {
  const h = high[i], l = low[i], c1 = i > 0 ? close[i - 1] : na;
  if (isna(c1)) return handleNa ? h - l : na;
  return Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1));
});
const pineStdev = (src: S, length: number) => porVela((i) => {   // biased (poblacional), como ta.stdev
  const m = pineSma(src, length)[i];
  let s = 0;
  for (let k = 0; k < length; k++) s += (src(i - k) - m) ** 2;
  return Math.sqrt(s / length);
});
const pineLinreg = (src: S, length: number) => porVela((i) => {
  // minimos cuadrados con x = 0 .. length-1 (la vela actual es length-1)
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let x = 0; x < length; x++) { const y = src(i - (length - 1 - x)); sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const slope = (length * sxy - sx * sy) / (length * sxx - sx * sx);
  const intercept = (sy - slope * sx) / length;
  return intercept + slope * (length - 1);
});
const pineHighest = (src: S, length: number) => porVela((i) => {
  let m = -Infinity; for (let k = 0; k < length; k++) { const v = src(i - k); if (isna(v)) return na; m = Math.max(m, v); } return m;
});
const pineLowest = (src: S, length: number) => porVela((i) => {
  let m = Infinity; for (let k = 0; k < length; k++) { const v = src(i - k); if (isna(v)) return na; m = Math.min(m, v); } return m;
});

/** Iguales vela por vela: los mismos na y los valores a 1e-9 relativo. */
function iguales(nombre: string, a: number[], b: number[]) {
  assert.equal(a.length, b.length, nombre);
  for (let i = 0; i < a.length; i++) {
    if (isna(b[i])) assert.ok(isna(a[i]), `${nombre}[${i}]: tendria que ser na y es ${a[i]}`);
    else assert.ok(Math.abs(a[i] - b[i]) <= 1e-9 * Math.max(1, Math.abs(b[i])), `${nombre}[${i}]: ${a[i]} contra ${b[i]} de Pine`);
  }
}

// --------------------------------------------------------------------- tests

test("SMA como ta.sma", () => {
  iguales("sma", ind.sma(close, 20), pineSma(serie(close), 20));
});

test("EMA como ta.ema: arranca en el primer cierre (la EMA 200 existe con menos de 200 velas)", () => {
  for (const L of [10, 50, 200, 600]) iguales(`ema${L}`, ind.ema(close, L), pineEma(serie(close), L));
  assert.equal(ind.ema(close, 200)[0], close[0]);
});

test("RMA como ta.rma: arranca con la SMA de la primera ventana completa", () => {
  iguales("rma", ind.rma(close, 14), pineRma(serie(close), 14));
  // Con na al principio (como el TR de la primera vela) arranca una vela despues.
  const tr = pineTr(false);
  iguales("rma(tr)", ind.rma(ind.trueRange(high, low, close, false), 14), pineRma(serie(tr), 14));
  assert.ok(isna(ind.rma(tr, 14)[13]) && !isna(ind.rma(tr, 14)[14]));
});

test("True range: ta.tr y ta.tr(true)", () => {
  iguales("tr", ind.trueRange(high, low, close, false), pineTr(false));
  iguales("tr(true)", ind.trueRange(high, low, close, true), pineTr(true));
});

test("ATR como ta.atr: RMA de ta.tr(true)", () => {
  iguales("atr", ind.atr(high, low, close, 14), pineRma(serie(pineTr(true)), 14));
});

test("stdev poblacional y linreg como en Pine", () => {
  iguales("stdev", ind.stdev(close, 20), pineStdev(serie(close), 20));
  iguales("linreg", ind.linreg(close, 20), pineLinreg(serie(close), 20));
});

test("DMI/ADX igual al indicador de TradingView (14, 14)", () => {
  const len = 14, lensig = 14;
  const up = porVela((i) => high[i] - (i > 0 ? high[i - 1] : na));
  const down = porVela((i) => -(low[i] - (i > 0 ? low[i - 1] : na)));
  const plusDM = porVela((i) => (isna(up[i]) ? na : up[i] > down[i] && up[i] > 0 ? up[i] : 0));
  const minusDM = porVela((i) => (isna(down[i]) ? na : down[i] > up[i] && down[i] > 0 ? down[i] : 0));
  const trur = pineRma(serie(pineTr(false)), len);
  const fixnan = (v: number[]) => { let u = na; return v.map((x) => (Number.isFinite(x) ? (u = x) : u)); };
  const rp = pineRma(serie(plusDM), len), rm = pineRma(serie(minusDM), len);
  const plus = fixnan(rp.map((x, i) => 100 * x / trur[i]));
  const minus = fixnan(rm.map((x, i) => 100 * x / trur[i]));
  const adx = pineRma(serie(plus.map((p, i) => { const s = p + minus[i]; return Math.abs(p - minus[i]) / (s === 0 ? 1 : s); })), lensig)
    .map((x) => 100 * x);
  const a = ind.adx(high, low, close, len, lensig);
  iguales("+DI", a.plus_di, plus);
  iguales("-DI", a.minus_di, minus);
  iguales("ADX", a.adx, adx);
  // Una suba sostenida: ADX alto, +DI arriba.
  const sube = Array.from({ length: 201 }, (_, i) => i + 1);
  const a2 = ind.adx(sube.map((x) => x + 1), sube.map((x) => x - 1), sube, 14, 14);
  assert.ok(a2.adx[200] > 90 && a2.plus_di[200] > a2.minus_di[200]);
});

test("DMI: un rango cero no rompe nada (fixnan repite el ultimo valor)", () => {
  const plano = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100 + i : 129));
  const a = ind.adx(plano, plano, plano, 14, 14);
  for (const v of a.adx.slice(28)) assert.ok(Number.isFinite(v));
});

test("Squeeze Momentum [LazyBear] corregido: Bollinger y Keltner usan sus propios multiplicadores", () => {
  const length = 20, multBB = 2, lengthKC = 20, multKC = 1.5;
  const src = serie(close);
  const basis = pineSma(src, length);
  const dev = pineStdev(src, length).map((x) => multBB * x);
  const ma = pineSma(src, lengthKC);
  const rangema = pineSma(serie(pineTr(false)), lengthKC);       // `tr` del original
  const hh = pineHighest(serie(high), lengthKC), ll = pineLowest(serie(low), lengthKC), mc = pineSma(serie(close), lengthKC);
  const val = pineLinreg(serie(close.map((c, i) => c - ((hh[i] + ll[i]) / 2 + mc[i]) / 2)), lengthKC);
  const estado = close.map((_, i) => {
    const upperBB = basis[i] + dev[i], lowerBB = basis[i] - dev[i];
    const upperKC = ma[i] + rangema[i] * multKC, lowerKC = ma[i] - rangema[i] * multKC;
    const on = lowerBB > lowerKC && upperBB < upperKC, off = lowerBB < lowerKC && upperBB > upperKC;
    return on ? "on" : off ? "off" : "none";
  });
  const z = ind.squeezeMomentum(high, low, close, 20, 2.0, 20, 1.5, true);
  iguales("val", z.value, val);
  assert.deepEqual(z.state, estado);
  assert.ok(z.state.includes("on") && z.state.includes("off"), "la serie de prueba pasa por compresion y liberacion");
});

test("cambiar BB MultFactor modifica compresion sin cambiar momentum ni su color", () => {
  const estrecho = ind.squeezeMomentum(high, low, close, 20, 1, 20, 1.5, true);
  const ancho = ind.squeezeMomentum(high, low, close, 20, 3, 20, 1.5, true);
  assert.notDeepEqual(estrecho.state, ancho.state);
  assert.ok(estrecho.state.filter((x) => x === "on").length > ancho.state.filter((x) => x === "on").length);
  assert.deepEqual(estrecho.value, ancho.value);
  assert.deepEqual(estrecho.colors, ancho.colors);
});

test("ATR de la primera ventana: promedio de los primeros 14 TR", () => {
  const at = ind.atr(high, low, close, 14);
  const tr = ind.trueRange(high, low, close, true);
  assert.ok(Math.abs(at[13] - mean(tr.slice(0, 14))) < 1e-10);
});
