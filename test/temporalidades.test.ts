// Temporalidades a medida: cual se puede, con que se arma y como se juntan las velas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aperturaMedida, agruparA, base, medida, valida } from "../src/temporalidades.ts";
import type { Candle } from "../src/binance.ts";

const NATIVAS = ["1M", "1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"];
const vela = (t: number, o: number, h: number, l: number, c: number, v = 10, closed = true): Candle =>
  ({ t, t_ms: t * 1000, close_time: (t + 60) * 1000 - 1, o, h, l, c, v, vb: v / 2, trades: 1, closed });

test("con que se arma cada una", () => {
  assert.equal(base("3m", NATIVAS), "1m");
  assert.equal(base("10m", NATIVAS), "5m");
  assert.equal(base("45m", NATIVAS), "15m");
  assert.equal(base("2h", NATIVAS), "1h");
  assert.equal(base("12h", NATIVAS), "4h");
  assert.equal(base("2d", NATIVAS), "1d");
  assert.equal(base("2w", NATIVAS), "1w");
  assert.equal(base("5m", NATIVAS), null);   // de siempre
});

test("lo que no se puede", () => {
  assert.equal(valida("0m", NATIVAS), false);
  assert.equal(valida("2000m", NATIVAS), false);
  assert.equal(valida("3x", NATIVAS), false);
  assert.equal(valida("22m", NATIVAS), true);
  assert.equal(valida("22m", ["5m", "15m"]), false);   // sin las de 1 minuto, 22m no sale
  assert.deepEqual(medida("3h"), { n: 3, unidad: "h", seg: 10_800 });
});

test("3m con velas de 1m: alineadas al reloj, OHLC y volumen; la ultima, abierta", () => {
  const t0 = 1_800_000_000 - (1_800_000_000 % 180);   // un multiplo de 3 minutos
  const m1 = [
    vela(t0, 10, 12, 9, 11), vela(t0 + 60, 11, 15, 10, 14), vela(t0 + 120, 14, 14, 8, 9),
    vela(t0 + 180, 9, 10, 7, 8, 10, false),
  ];
  const r = agruparA(m1, "3m", (t0 + 200) * 1000);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].t, r[0].o, r[0].h, r[0].l, r[0].c, r[0].v], [t0, 10, 15, 8, 9, 30]);
  assert.equal(r[0].closed, true);
  assert.equal(r[1].closed, false);
});

test("2D con diarias: ancla epoch UTC, el ultimo periodo sigue abierto", () => {
  const t = Date.UTC(2026, 9, 30) / 1000;
  const inicio = aperturaMedida(t, medida("2d")!);
  const d = [0, 1, 2, 3, 4].map((k) => vela(inicio + k * 86_400, 10 + k, 20 + k, 5, 11 + k));
  const r = agruparA(d, "2d", (inicio + 5 * 86_400) * 1000);
  assert.deepEqual(r.map((x) => [x.t, x.o, x.c]), [[inicio, 10, 12], [inicio + 2 * 86_400, 12, 14], [inicio + 4 * 86_400, 14, 15]]);
  assert.equal(r[2].closed, false);
  assert.equal(r[2].close_time, (inicio + 6 * 86_400) * 1000 - 1);
});

test("dias y semanas mantienen su ancla al recortar o anteponer historia", () => {
  for (const [interval, paso] of [["2d", 86_400], ["2w", 604_800]] as const) {
    const m = medida(interval)!;
    const inicio = aperturaMedida(Date.UTC(2026, 9, 30) / 1000, m);
    const datos = Array.from({ length: 10 }, (_, k) => vela(inicio + k * paso, 10 + k, 20 + k, 5, 11 + k));
    const ahora = (inicio + 12 * paso) * 1000;
    const completas = agruparA(datos, interval, ahora);
    const cortadas = agruparA(datos.slice(1), interval, ahora);
    const ampliadas = agruparA([vela(inicio - paso, 8, 9, 7, 8), ...datos], interval, ahora);
    // Solo el primer periodo parcialmente disponible puede cambiar sus OHLC.
    assert.deepEqual(cortadas.slice(1), completas.slice(1));
    assert.deepEqual(ampliadas.filter((x) => x.t >= inicio), completas);
    assert.deepEqual(cortadas.map((x) => x.t), completas.map((x) => x.t));
    if (interval === "2w") for (const x of completas) assert.equal(new Date(x.t * 1000).getUTCDay(), 1);
  }
});

test("las semanas usan lunes UTC y no desplazan periodos cuando falta una muestra", () => {
  const lunes = Date.UTC(2026, 9, 26) / 1000, paso = 604_800;
  const m = medida("2w")!, inicio = aperturaMedida(lunes, m);
  const datos = [0, 3].map((k) => vela(inicio + k * paso, 10 + k, 20 + k, 5, 11 + k));
  const out = agruparA(datos, "2w", (inicio + 4 * paso) * 1000);
  assert.deepEqual(out.map((x) => [x.t, x.v]), [[inicio, 10], [inicio + 2 * paso, 10]]);
  assert.ok(out.every((x) => x.closed));
  assert.equal(aperturaMedida(0, medida("1w")!), -3 * 86_400);
});
