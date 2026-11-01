/* Chequeo de las velas de los indices: como se alinean con las de Yahoo y como
 * se arman las de 4H y las de segundos. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agrupar, apertura, convertir, inicioDia, inicioMes, inicioSemana } from "../src/indices.ts";

const iso = (s: number) => new Date(s * 1000).toISOString();
const seg = (texto: string) => Date.parse(texto) / 1000;

test("indices: la vela diaria es la de la rueda (empieza la tarde anterior)", () => {
  // Domingo 18:30 de Nueva York (horario de verano) ya es la rueda del lunes.
  assert.equal(iso(inicioDia(seg("2026-10-18T22:30:00Z"))), "2026-10-19T04:00:00.000Z");
  // Viernes 16:59: rueda del viernes.
  assert.equal(iso(inicioDia(seg("2026-10-16T20:59:00Z"))), "2026-10-16T04:00:00.000Z");
  // En invierno la medianoche de Nueva York son las 05:00 Z.
  assert.equal(iso(inicioDia(seg("2026-12-15T15:00:00Z"))), "2026-12-15T05:00:00.000Z");
});

test("indices: la vela semanal empieza el lunes", () => {
  assert.equal(iso(inicioSemana(seg("2026-10-16T20:59:58Z"))), "2026-10-12T04:00:00.000Z");
  // El domingo a la tarde ya es la semana siguiente.
  assert.equal(iso(inicioSemana(seg("2026-10-18T22:30:00Z"))), "2026-10-19T04:00:00.000Z");
  assert.equal(apertura(seg("2026-10-16T20:59:58Z"), "1h"), seg("2026-10-16T20:00:00Z"));
});

test("indices: la vela en curso de Yahoo se junta con la de su semana", () => {
  const res = {
    timestamp: [seg("2026-10-05T04:00:00Z"), seg("2026-10-12T04:00:00Z"), seg("2026-10-16T20:59:58Z")],
    indicators: { quote: [{
      open: [10, 20, 25], high: [12, 26, 27], low: [9, 19, 24], close: [11, 25, 26], volume: [5, 6, 1],
    }] },
  };
  const v = convertir(res, "1w", Date.parse("2026-10-17T00:00:00Z"));
  assert.equal(v.length, 2);
  assert.equal(iso(v[1].t), "2026-10-12T04:00:00.000Z");
  assert.equal(v[1].h, 27);
  assert.equal(v[1].c, 26);
  assert.equal(v[1].v, 7);
});

test("indices: 4H con velas de 1H, y nulls de Yahoo afuera", () => {
  const t0 = seg("2026-10-15T00:00:00Z");
  const res = {
    timestamp: [0, 1, 2, 3, 4, 5].map((k) => t0 + k * 3600),
    indicators: { quote: [{
      open: [1, 2, null, 4, 5, 6], high: [2, 3, null, 5, 6, 7], low: [0, 1, null, 3, 4, 5],
      close: [2, 3, null, 5, 6, 7], volume: [1, 1, null, 1, 1, 1],
    }] },
  };
  const v = convertir(res, "4h", Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(v.length, 2);
  assert.deepEqual([v[0].o, v[0].h, v[0].l, v[0].c, v[0].v], [1, 5, 0, 5, 3]);
  assert.equal(v[1].t, t0 + 4 * 3600);
  assert.equal(v[1].closed, true);
});

test("indices: la vela mensual empieza el dia 1 y la junta con la en curso", () => {
  // El 31 a la tarde (despues de las 18:00 de Nueva York) ya es la rueda del mes siguiente.
  assert.equal(new Date(inicioMes(seg("2026-08-31T22:30:00Z")) * 1000).toISOString(), "2026-09-01T04:00:00.000Z");
  assert.equal(new Date(inicioMes(seg("2026-12-15T15:00:00Z")) * 1000).toISOString(), "2026-12-01T05:00:00.000Z");
  const res = {
    timestamp: [seg("2026-09-01T04:00:00Z"), seg("2026-10-01T04:00:00Z"), seg("2026-10-18T23:04:36Z")],
    indicators: { quote: [{ open: [1, 2, 3], high: [2, 3, 5], low: [0, 1, 2], close: [2, 3, 4], volume: [1, 1, 1] }] },
  };
  const v = convertir(res, "1M", Date.parse("2026-10-19T00:00:00Z"));
  assert.equal(v.length, 2);
  assert.deepEqual([v[1].h, v[1].c, v[1].closed], [5, 4, false]);
  assert.equal(new Date(v[0].close_time + 1).toISOString(), "2026-09-30T22:00:00.000Z");
});

test("indices: ordena muestras, deduplica y descarta timestamps u OHLC invalidos", () => {
  const t = seg("2026-10-15T00:00:00Z");
  const res = {
    timestamp: [t + 3600, NaN, t, t, t + 7200],
    indicators: { quote: [{
      open: [2, 2, 1, 1, 5], high: [3, 3, 2, 2, 4], low: [1, 1, 0, 0, 3],
      close: [3, 3, 2, 2, 6], volume: [2, 1, 1, 1, 1],
    }] },
  };
  const out = convertir(res, "4h", Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].t, out[0].o, out[0].h, out[0].l, out[0].c, out[0].v], [t, 1, 3, 0, 3, 3]);
});
