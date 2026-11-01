// Corte automatico: el SL a la perdida maxima para lo que no tiene SL; nunca se cierra.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCorte, type Abierta } from "../src/corte.ts";

const base: Abierta = { id: "1", lado: "buy", entrada: 29770.33, actual: 29760, sl: null, resultado: -5, valorPorUnidad: 0.5, tick: 0.01 };

test("compra sin SL: el SL donde se pierden 30 USD (0,50 lotes del US100: 60 puntos)", () => {
  assert.deepEqual(planCorte([base], 30), [{ id: "1", accion: "sl", precio: 29710.33 }]);
});

test("venta sin SL: el SL arriba, redondeado al tick hacia la entrada", () => {
  const r = planCorte([{ ...base, lado: "sell", entrada: 100, actual: 100.5, resultado: -1, valorPorUnidad: 7, tick: 0.1 }], 30);
  // 30 / 7 = 4,2857: el SL en 104,2 (pierde 29,40, nunca mas de 30).
  assert.deepEqual(r, [{ id: "1", accion: "sl", precio: 104.2 }]);
});

test("ya perdió 30 o más: no se toca", () => {
  assert.deepEqual(planCorte([{ ...base, resultado: -31.5 }], 30), []);
});

test("el precio ya pasó el nivel (un salto): no se toca", () => {
  assert.deepEqual(planCorte([{ ...base, actual: 29700, resultado: -29 }], 30), []);
});

test("lo que tiene SL no se toca; sin el valor del punto, tampoco; tope 0 apaga", () => {
  assert.deepEqual(planCorte([{ ...base, sl: 29700 }], 30), []);
  assert.deepEqual(planCorte([{ ...base, valorPorUnidad: null }], 30), []);
  assert.deepEqual(planCorte([base], 0), []);
});

test("Binance: 0,004 BTC sin SL, entrada 80.000 → SL en 72.500", () => {
  const r = planCorte([{ id: "BTCUSDT:buy", lado: "buy", entrada: 80000, actual: 79900, sl: null, resultado: -0.4, valorPorUnidad: 0.004, tick: 0.1 }], 30);
  assert.deepEqual(r, [{ id: "BTCUSDT:buy", accion: "sl", precio: 72500 }]);
});
