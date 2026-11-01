import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparA, aperturaMedida, medida } from "../src/temporalidades.ts";
import type { Candle } from "../src/binance.ts";
// @ts-ignore El motor JS se ejecuta tambien en el navegador.
import { paso, Replay } from "../web/src/lib/replay.js";

const DIA = 86_400, SEMANA = 7 * DIA;
const inicio = aperturaMedida(Date.UTC(2026, 9, 26) / 1000, medida("2d")!);
const cfg = { ema: [10, 50, 200], indicadores: { adx: [14, 14], sqz: [20, 2, 20, 1.5, true] } };
const vela = (t: number, i = 0, p = 60): Candle => ({
  t, t_ms: t * 1000, close_time: (t + p) * 1000 - 1,
  o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i,
  v: 0.125, vb: 0, trades: 0, closed: true,
});
const compactar = (a: Candle[]) => a.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]);
const resumen = (a: any[]) => a.map(({ t, o, h, l, c, v, closed }) => ({ t, o, h, l, c, v, closed }));

test("replay 3m, 10m, 2h y 2d usa mismos periodos y OHLC que el servidor sin mirar despues del cursor", () => {
  const m1 = Array.from({ length: 3 * 1440 }, (_, i) => vela(inicio + i * 60, i));
  const datos = {
    symbol: "US100", m1: compactar(m1),
    h1: compactar(agruparA(m1, "1h")), h4: compactar(agruparA(m1, "4h")), d1: compactar(agruparA(m1, "1d")),
  };
  const replay = new Replay(datos, cfg);
  replay.cursor = inicio + DIA + 7 * 3600 + 13 * 60;
  const conocidas = m1.filter((x) => x.t + 60 <= replay.cursor);
  for (const interval of ["3m", "10m", "2h", "2d"]) {
    const esperado = agruparA(conocidas, interval, replay.cursor * 1000);
    const resultado = replay.serie(interval, 10_000);
    assert.deepEqual(resumen(resultado), resumen(esperado), interval);
    assert.equal(resultado.at(-1).closed, false, `${interval}: la vela parcial sigue abierta`);
  }
});

test("replay no inventa minutos antes del comienzo de m1 y conserva la base de 5m en 10m", () => {
  const m5 = Array.from({ length: 30 }, (_, i) => vela(inicio + i * 300, i, 300));
  const m1 = [vela(inicio + DIA)];
  const replay = new Replay({ symbol: "US100", m1: compactar(m1), m5: compactar(m5) }, cfg);
  replay.cursor = inicio + 900;
  assert.deepEqual(replay.serie("3m"), []);
  const resultado = replay.serie("10m");
  assert.deepEqual(resumen(resultado), resumen(agruparA(m5.slice(0, 3), "10m", replay.cursor * 1000)));
  assert.equal(resultado.at(-1).closed, false);
});

test("replay semanal aprovecha w1 del snapshot y comparte el ancla de lunes UTC", () => {
  const t = aperturaMedida(inicio, medida("2w")!);
  const w1 = Array.from({ length: 4 }, (_, i) => vela(t + i * SEMANA, i, SEMANA));
  const replay = new Replay({ symbol: "US100", m1: [], w1: compactar(w1) }, cfg);
  replay.cursor = t + 4 * SEMANA;
  assert.deepEqual(resumen(replay.serie("2w")), resumen(agruparA(w1, "2w", replay.cursor * 1000)));
});

test("el semanal en curso usa solo minutos conocidos aunque w1 incluya el cierre futuro", () => {
  const t = aperturaMedida(inicio, medida("2w")!);
  const m1 = Array.from({ length: 60 }, (_, i) => vela(t + i * 60, i));
  const futuro = vela(t, 9999, SEMANA);
  const replay = new Replay({ symbol: "US100", m1: compactar(m1), w1: compactar([futuro]) }, cfg);
  replay.cursor = t + 13 * 60;
  const out = replay.serie("2w");
  assert.equal(out.length, 1);
  assert.deepEqual(resumen(out), resumen(agruparA(m1.slice(0, 13), "2w", replay.cursor * 1000)));
  assert.equal(out[0].closed, false);
});

test("replay semanal sin w1 agrupa diarias en UTC y declara su fuente", () => {
  const t = aperturaMedida(inicio, medida("2w")!);
  const d1 = Array.from({ length: 28 }, (_, i) => vela(t + i * DIA, i, DIA));
  const replay = new Replay({ symbol: "US100", m1: [], d1: compactar(d1) }, cfg);
  replay.cursor = t + 28 * DIA;
  assert.deepEqual(resumen(replay.serie("2w")), resumen(agruparA(d1, "2w", replay.cursor * 1000)));
  const payload = replay.payload("2w");
  assert.equal(payload.ok, true);
  assert.match(payload.fuente.nombre, /UTC.*diarias/);
  assert.equal(payload.fuente.agrupacionUTC, true);
  replay.d1 = replay.d1.slice(1);
  assert.deepEqual(resumen(replay.serie("2w").slice(1)), resumen(agruparA(d1, "2w", replay.cursor * 1000).slice(1)));
});

test("replay rechaza meses explicitamente y publica duracion correcta para pasos custom", () => {
  const replay = new Replay({ symbol: "US100", m1: [] }, cfg);
  const payload = replay.payload("1M");
  assert.equal(payload.ok, false);
  assert.match(payload.error, /no admite 1M.*calendario/);
  assert.equal(paso("3m"), 180);
  assert.equal(paso("10m"), 600);
  assert.equal(paso("2h"), 7200);
  assert.equal(paso("2d"), 2 * DIA);
  assert.equal(paso("2w"), 2 * SEMANA);
  assert.equal(paso("1M"), null);
});
