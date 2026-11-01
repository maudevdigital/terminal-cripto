import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Módulo compartido con el navegador.
import { detectDecimals, fmt, fmtNum, getDecimals, setDecimals } from "../web/src/lib/format.js";

test("la precisión de precios en notación científica conserva los ocho decimales", () => {
  const vela = { open: 1e-8, high: 3e-8, low: 1e-8, close: 2e-8 };
  assert.equal(detectDecimals([vela]), 8);
  assert.equal(fmt(1e-8, detectDecimals([vela])), "0,00000001");
  assert.equal(detectDecimals([{ open: 28763.750000000004, high: 28764, low: 28762, close: 28763.75 }]), 2);
});

test("valores no finitos se muestran vacíos y no corrompen el formateador", () => {
  for (const n of [NaN, Infinity, -Infinity, null, undefined, "no es precio", ""]) assert.equal(fmtNum(n), "—");
  const anterior = getDecimals();
  setDecimals(6);
  setDecimals(undefined);
  setDecimals(-1);
  assert.equal(fmt(0.123456), "0,123456");
  setDecimals(anterior);
});
