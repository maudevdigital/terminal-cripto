// El dato real desde el calendario de MT5: emparejar por moneda, hora y cifras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completar, monedas, cifra } from "../src/calendarioMT5.ts";
import type { Evento } from "../src/calendario.ts";

// 28-10-2026 18:00 UTC (las 15:00 de Chile); el servidor de MT5 esta en UTC+2.
const T = Date.UTC(2026, 9, 28, 18, 0) ;
const srv = (ms: number) => ms / 1000 + 7200;
const ev = (titulo: string, extra: Partial<Evento> = {}): Evento => ({
  t: T, titulo, impacto: "high", moneda: "USD + US Indices + XAUUSD + DXY", restringido: true, tipo: "normal",
  actual: null, pronostico: null, previo: null, ...extra,
});
const mt5 = {
  gmt_offset: 7200,
  eventos: [
    { time: srv(T), moneda: "USD", nombre: "FOMC Statement", actual: "", estimado: "", anterior: "" },
    { time: srv(T), moneda: "USD", nombre: "Fed Interest Rate Decision", actual: "4.00 %", estimado: "4.00 %", anterior: "4.00 %" },
    { time: srv(T - 3.5 * 3600_000), moneda: "USD", nombre: "EIA Crude Oil Stocks Change", actual: "-1.900 M", estimado: "0.100 M", anterior: "-3.100 M" },
  ],
};

test("la tasa de la Fed: FTMO sin el dato, MT5 lo trae (por el anterior y el estimado)", () => {
  const [tasa, comunicado] = completar([ev("Federal Funds Rate", { pronostico: "4 %", previo: "4 %" }), ev("FOMC Statement")], mt5);
  assert.equal(tasa.actual, "4.00 %");
  assert.equal((tasa as any).fuenteActual, "mt5");
  // Sin cifras (un comunicado) no se le pega nada.
  assert.equal(comunicado.actual, null);
});

test("el petroleo: el instrumento de FTMO no es una moneda, pero va con USD", () => {
  const [crudo] = completar([ev("Crude Oil Inventories", { t: T - 3.5 * 3600_000, moneda: "Crude Oil", pronostico: "0.1 M", previo: "-3.1 M" })], mt5);
  assert.equal(crudo.actual, "-1.900 M");
});

test("lo que FTMO ya tiene no se toca; otra hora u otra moneda no empareja", () => {
  const ya = ev("Federal Funds Rate", { actual: "4 %", pronostico: "4 %", previo: "4 %" });
  assert.equal(completar([ya], mt5)[0], ya);
  assert.equal(completar([ev("Federal Funds Rate", { t: T + 3600_000, previo: "4 %" })], mt5)[0].actual, null);
  assert.equal(completar([ev("Federal Funds Rate", { moneda: "EUR", previo: "4 %" })], mt5)[0].actual, null);
  assert.equal(completar([ev("Federal Funds Rate", { previo: "4 %" })], null)[0].actual, null);
});

test("las monedas y las cifras", () => {
  assert.deepEqual(monedas("USD + US Indices + XAUUSD + DXY"), ["USD"]);
  assert.deepEqual(monedas("NATGAS"), ["USD"]);
  assert.deepEqual(monedas("CAD"), ["CAD"]);
  assert.equal(cifra("4 %"), 4);
  assert.equal(cifra("-1.9 M"), -1_900_000);
  assert.equal(cifra("-134.9 B"), -134.9e9);
  assert.equal(cifra("—"), null);
});
