// Operaciones simuladas del backtest: lotes, llenado de la limite, SL antes que TP y resumen.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: modulo JS de la interfaz, sin tipos
import { avanzarOperaciones, cerrarAMano, lotesPara, nuevaOperacion, resumen, validar } from "../web/src/lib/simulacion.js";

const vela = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c });
const base = { lado: 1, tipo: "limite", entrada: 100, sl: 90, tp: 120, riesgoUsd: 50, valorPunto: 1, cursor: 0, simbolo: "US100", sesion: 1 };

test("lotes para el riesgo, en pasos de 0,01", () => {
  assert.equal(lotesPara(50, 30, 1), 1.66);
  assert.equal(lotesPara(50, 0, 1), 0);
  assert.equal(validar({ lado: 1, entrada: 100, sl: 110, tp: 120 }), "El SL tiene que ir bajo la entrada.");
});

test("la limite se llena al tocar y despues llega al TP", () => {
  let ops = [nuevaOperacion(base)];
  ops = avanzarOperaciones(ops, [vela(60, 105, 106, 101, 102)]);
  assert.equal(ops[0].estado, "pendiente");
  ops = avanzarOperaciones(ops, [vela(120, 102, 103, 99, 101), vela(180, 101, 121, 100, 119)]);
  assert.equal(ops[0].estado, "cerrada");
  assert.equal(ops[0].final, "tp");
  assert.equal(ops[0].r, 2);
  assert.equal(ops[0].usd, 5 * 20);
});

test("si una vela toca el SL y el TP, cuenta el SL", () => {
  let ops = [nuevaOperacion({ ...base, tipo: "mercado" })];
  ops = avanzarOperaciones(ops, [vela(60, 100, 125, 85, 110)]);
  assert.equal(ops[0].final, "sl");
  assert.equal(ops[0].r, -1);
});

test("con el SL en la entrada termina en BE; a mano, al precio del replay", () => {
  let ops = [{ ...nuevaOperacion({ ...base, tipo: "mercado" }), sl: 100 }];
  ops = avanzarOperaciones(ops, [vela(60, 104, 108, 99, 101)]);
  assert.equal(ops[0].final, "be");
  const otra = cerrarAMano(nuevaOperacion({ ...base, tipo: "mercado" }), 105, 300);
  assert.equal(otra.final, "manual");
  assert.equal(otra.r, 0.5);
  const r = resumen([...ops, otra]);
  assert.equal(r.n, 2);
  assert.equal(r.totalR, 0.5);
});
