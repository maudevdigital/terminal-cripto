// Calendario de FTMO: el evento de su API, en el formato de la terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertir } from "../src/calendario.ts";

test("evento de FTMO: hora con su zona, impacto y restriccion", () => {
  const e = convertir({ title: "CPI m/m", impact: "high", instrument: "USD", restriction: true, eventType: "normal",
    date: "2026-10-21T09:30:00-03:00", forecast: "0.2 %", previous: "0.1 %", actual: null })!;
  assert.equal(e.t, Date.UTC(2026, 9, 21, 12, 30));
  assert.deepEqual([e.titulo, e.impacto, e.moneda, e.restringido, e.pronostico, e.actual], ["CPI m/m", "high", "USD", true, "0.2 %", null]);
  assert.equal(convertir({ title: "sin fecha" }), null);
});
