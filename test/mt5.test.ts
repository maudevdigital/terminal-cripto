/* Chequeo del puente MT5: la aritmetica que pasa el riesgo a lotes. Las filas
 * son las de la planilla de lotaje y una operacion real de ADA en FTMO. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mt5 from "../src/mt5.ts";
import { config } from "../src/config.ts";

const SIMBOLO = {
  symbol: "ADAUSD", contract_size: 100000.0, tick_size: 0.0001, tick_value: 10.0,
  volume_min: 0.01, volume_step: 0.01,
};
const ADA_SHEET = { contract_size: 100000.0, volume_step: 0.01, volume_min: 0.01 };
const XRP_SHEET = { contract_size: 10000.0, volume_step: 0.01, volume_min: 0.01 };

test("simbolo del terminal -> simbolo del broker", () => {
  assert.equal(mt5.brokerSymbol("adausdt"), "ADAUSD");
  assert.equal(mt5.brokerSymbol("SOLUSDT"), null);
});

test("una cuenta MT5 fijada nunca se sustituye por otra cuenta disponible", () => {
  const cuentaAnterior = config.MT5_ACCOUNT;
  const puente = new mt5.BrokerBridge() as any;
  const otra = { login: "111", leer: () => ({ available: true, live: true }) };
  const elegida = { login: "222", leer: () => ({ available: true, live: true }) };
  puente.lectores.set("otra", otra);
  try {
    config.MT5_ACCOUNT = "222";
    assert.equal(puente.elegir(), null);
    puente.lectores.set("elegida", elegida);
    assert.equal(puente.elegir(), elegida);
    config.MT5_ACCOUNT = "";
    assert.equal(puente.elegir(), otra);
  } finally {
    config.MT5_ACCOUNT = cuentaAnterior;
  }
});

test("las filas de la planilla, con la formula del terminal", () => {
  // tick_value / tick_size == contract_size
  assert.equal(mt5.porPunto(SIMBOLO), 100000.0);
  assert.equal(mt5.porPunto({ contract_size: 10000.0 }), 10000.0);
  assert.equal(mt5.porPunto({}), null);

  assert.equal(mt5.volumenPorRiesgo(0.45, 0.40, ADA_SHEET, 10000.0 * 0.01), 0.02);
  assert.equal(mt5.volumenPorRiesgo(0.45, 0.40, ADA_SHEET, 50000.0 * 0.01), 0.10);
  assert.equal(mt5.volumenPorRiesgo(0.19, 0.17, ADA_SHEET, 100.0), 0.05);
  assert.equal(mt5.volumenPorRiesgo(1.30, 1.15, XRP_SHEET, 100.0), 0.06);

  // el redondeo es HACIA ABAJO: el riesgo real nunca pasa el objetivo
  const v = mt5.volumenPorRiesgo(0.45, 0.40, ADA_SHEET, 149.0)!;
  assert.ok(v === 0.02 && 0.05 * 100000.0 * v <= 149.0);
  // sin distancia al stop no hay lotaje (no divide por cero)
  assert.equal(mt5.volumenPorRiesgo(0.45, 0.45, ADA_SHEET, 100.0), null);
});

test("riesgo y margen", () => {
  // 47 puntos de 0,0001 con 0,10 lotes de ADA = 47 USD
  assert.ok(Math.abs(mt5.riesgo(0.2334 - 0.2287, SIMBOLO, 0.10)! - 47.0) < 1e-6);
  // con el dato del EA (OrderCalcMargin) se usa tal cual; sin el, nocional completo
  assert.equal(mt5.margenRequerido(0.5, 0.2250, { ...SIMBOLO, margin_per_lot: 22500.0 }), 11250.0);
  assert.ok(Math.abs(mt5.margenRequerido(0.05, 0.2250, SIMBOLO)! - 1125.0) < 1e-9);
});

test("regresion: el piso no se come un paso de lote por coma flotante", () => {
  const XLM = { symbol: "XLMUSD", contract_size: 100000.0, volume_min: 0.01, volume_step: 0.01 };
  assert.equal(mt5.volumenPorRiesgo(0.1904, 0.1404, XLM, 100.0), 0.02);
  assert.equal(mt5.volumenPorRiesgo(0.1904, 0.1404, XLM, 149.0), 0.02);
  assert.equal(mt5.volumenPorRiesgo(0.1904, 0.1404, XLM, 99.0), 0.01);
  for (const objetivo of [99.0, 100.0, 149.0, 150.0, 260.0]) {
    const v = mt5.volumenPorRiesgo(0.1904, 0.1404, XLM, objetivo)!;
    assert.ok(v * 0.05 * 100000 <= objetivo + 1e-6);
  }
});

// ------------------------------------------------------------ velas del broker

const S = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;   // hora del servidor
const AHORA = Date.UTC(2026, 9, 19, 2) ;   // lunes 19/10/2026, horario de verano de EE.UU.

test("velas MT5: intradia a UTC con el desfase de cada fecha (cierre 17:00 NY)", () => {
  // FTMO hoy: GMT+3. En enero (invierno de EE.UU.) el servidor iba en GMT+2.
  const [ver, inv] = mt5.convertirVelas([[S(2026, 10, 19, 3), 1, 2, 0.5, 1.5, 10], [S(2026, 1, 15, 10), 1, 2, 0.5, 1.5, 10]],
    "1h", 3 * 3600, AHORA);
  assert.equal(ver.t, S(2026, 10, 19, 0));
  assert.equal(ver.close_time, (S(2026, 10, 19, 1)) * 1000 - 1);
  assert.equal(inv.t, S(2026, 1, 15, 8));
  // Volumen comprador estimado con el cierre dentro del rango.
  assert.equal(ver.vb, 10 * (1.5 - 0.5) / (2 - 0.5));
  // Un servidor que no cierra a las 17:00 de Nueva York: el mismo desfase para todas.
  const [g] = mt5.convertirVelas([[S(2026, 1, 15, 10), 1, 2, 0.5, 1.5, 10]], "1h", 0, AHORA);
  assert.equal(g.t, S(2026, 1, 15, 10));
});

test("velas MT5: diaria, semanal y mensual ancladas a la medianoche de Nueva York", () => {
  const [d] = mt5.convertirVelas([[S(2026, 10, 16), 1, 2, 0.5, 1.5, 10]], "1d", 3 * 3600, AHORA);
  assert.equal(d.t, S(2026, 10, 16, 4));                       // medianoche de NY (EDT)
  assert.equal(d.close_time, S(2026, 10, 16, 21) * 1000 - 1);   // 17:00 de NY
  assert.equal(d.closed, true);
  // MT5 abre la semana el domingo: la terminal la marca el lunes.
  const [w] = mt5.convertirVelas([[S(2026, 10, 18), 1, 2, 0.5, 1.5, 10]], "1w", 3 * 3600, AHORA);
  assert.equal(w.t, S(2026, 10, 19, 4));
  assert.equal(w.closed, false);
  const [m] = mt5.convertirVelas([[S(2026, 10, 1), 1, 2, 0.5, 1.5, 10]], "1M", 3 * 3600, AHORA);
  assert.equal(m.t, S(2026, 10, 1, 4));
  assert.equal(m.close_time, S(2026, 10, 31, 21) * 1000 - 1);
});

test("velas MT5: nombres de simbolo sin importar mayusculas", () => {
  assert.equal(mt5.buscar({ "US30.cash": 1 }, "US30.CASH"), 1);
  assert.equal(mt5.buscar({ XAUUSD: 2 }, "xauusd"), 2);
  assert.equal(mt5.buscar({ XAUUSD: 2 }, "XAGUSD"), undefined);
});
