// Mover SL, TP y precio de lo abierto: lo que calcula la interfaz (web/src/lib/operativa.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const ruta = "../web/src/lib/operativa.js";
const lib: any = await import(ruta as string);

// BTCUSD en FTMO: 1 lote = 1 BTC, pip de 1 dolar.
const compra = {
  ticket: 7, simbolo: "BTCUSD", tipo: "buy", volumen: 0.05, entrada: 81_889.76, sl: 80_584.63, tp: 88_177.99,
  bid: 82_500, ask: 82_520, pip: 1, por_punto: 1,
};
const venta = { ...compra, ticket: 8, tipo: "sell", sl: 84_000, tp: 79_000 };

test("resultado de un nivel: pips desde la entrada y dinero con signo", () => {
  const sl = lib.resultadoEn(compra, compra.sl);
  assert.ok(Math.abs(sl.pips - 1305.13) < 0.01);
  assert.ok(Math.abs(sl.usd - -65.2565) < 1e-6);
  const tp = lib.resultadoEn(compra, compra.tp);
  assert.ok(tp.usd > 0);
  // En una venta, el SL arriba pierde y el TP abajo gana.
  assert.ok(lib.resultadoEn(venta, venta.sl).usd < 0);
  assert.ok(lib.resultadoEn(venta, venta.tp).usd > 0);
  // SL en ganancia: asegura resultado positivo.
  assert.ok(lib.resultadoEn(compra, 82_000).usd > 0);
});

test("el SL y el TP no pueden quedar del lado equivocado del precio", () => {
  assert.equal(lib.problemaCambio(compra, { sl: 82_000, tp: 90_000 }), null);
  assert.match(lib.problemaCambio(compra, { sl: 83_000, tp: 90_000 }), /SL va debajo/);
  assert.match(lib.problemaCambio(compra, { sl: 80_000, tp: 82_000 }), /TP va arriba/);
  // La venta se cierra al ask: el SL va arriba del ask.
  assert.match(lib.problemaCambio(venta, { sl: 82_510, tp: 79_000 }), /SL va arriba/);
  assert.equal(lib.problemaCambio(venta, { sl: 83_000, tp: 79_000 }), null);
});

test("orden pendiente: el precio respeta el tipo y el SL se mide desde el precio nuevo", () => {
  const limite = { ...compra, ticket: 9, tipo: "buy_limit", entrada: 80_000, sl: 79_000, tp: 85_000 };
  assert.equal(lib.problemaCambio(limite, { precio: 81_000, sl: 79_000, tp: 85_000 }), null);
  assert.match(lib.problemaCambio(limite, { precio: 83_000, sl: 79_000, tp: 85_000 }), /compra límite va debajo/);
  assert.match(lib.problemaCambio(limite, { precio: 78_500, sl: 79_000, tp: 85_000 }), /SL va debajo del precio de la orden/);
  const stop = { ...limite, tipo: "sell_stop", entrada: 81_000, sl: 82_000, tp: 79_000 };
  assert.match(lib.problemaCambio(stop, { precio: 83_000, sl: 84_000, tp: 79_000 }), /venta stop va debajo/);
});

test("el pedido mantiene lo que no se toca", () => {
  assert.deepEqual(lib.pedidoModificar(compra, { sl: 81_000 }), { accion: "modificar", ticket: 7, sl: 81_000, tp: 88_177.99 });
  assert.deepEqual(lib.pedidoModificar(compra, { tp: 0 }), { accion: "modificar", ticket: 7, sl: 80_584.63, tp: 0 });
  const limite = { ...compra, ticket: 9, tipo: "buy_limit", entrada: 80_000 };
  assert.deepEqual(lib.pedidoModificar(limite, { precio: 79_500 }),
    { accion: "modificar", ticket: 9, sl: 80_584.63, tp: 88_177.99, precio: 79_500 });
  assert.equal(lib.pedidoModificar(limite, { sl: 79_000 }).precio, 80_000);
});

test("nombres y lo que falta para operar", () => {
  assert.equal(lib.nombreOperacion({ tipo: "sell_stop" }), "Venta stop");
  assert.equal(lib.nombreOperacion({ tipo: "buy_limit" }), "Compra límite");
  assert.equal(lib.nombreOperacion({ tipo: "buy" }), "Compra");
  const broker = { disponible: true, vivo: true, trading: true, operador: { vivo: true, habilitado: false, motivo: "InpCuenta en 0" } };
  assert.equal(lib.faltaParaOperar(broker), "InpCuenta en 0");
  assert.equal(lib.faltaParaOperar({ ...broker, operador: { vivo: true, habilitado: true } }), null);
  assert.match(lib.faltaParaOperar({ ...broker, trading: false }), /TRADING_ACTIVO/);
});

test("el volumen por riesgo respeta pasos fraccionarios sin exceder el riesgo", () => {
  const c = lib.calcularOrden({
    info: { bid: 100, ask: 101, pip: 1, por_punto: 1, volume_step: 0.25, volume_min: 0.25 },
    broker: {}, tipo: "mercado", compra: true, precioLim: "", sl: { modo: "precio", valor: "91" },
    tp: { modo: "precio", valor: "121" }, vol: "", riesgo: "7.5",
  });
  assert.equal(c.v, 0.75);
  assert.equal(c.sl.usd, 7.5);
  assert.deepEqual(c.errores, []);
});

test("un texto o nivel inválido nunca se transforma en quitar SL/TP", () => {
  for (const valor of ["abc", NaN, Infinity, -1]) {
    assert.match(lib.problemaCambio(compra, { sl: valor }), /Revisa el SL/);
    assert.throws(() => lib.pedidoModificar(compra, { sl: valor }), /Revisa el SL/);
    assert.throws(() => lib.pedidoModificar(compra, { tp: valor }), /Revisa el TP/);
  }
  assert.equal(lib.pedidoModificar(compra, { sl: "" }).sl, 0);
  assert.equal(lib.pedidoModificar(compra, { sl: "81 000,5" }).sl, 81000.5);
  assert.equal(lib.pedidoModificar(compra, { sl: 0 }).sl, 0);
});

test("la orden nueva rechaza SL/TP no vacíos inválidos incluso si el SL es opcional", () => {
  const base = {
    info: { bid: 100, ask: 101, pip: 1, por_punto: 1, volume_step: 0.001, volume_min: 0.001 },
    broker: { operador: { sl_obligatorio: false } }, tipo: "mercado", compra: true,
    precioLim: "", sl: { modo: "precio", valor: "" }, tp: { modo: "precio", valor: "" }, vol: "0.005", riesgo: "",
  };
  assert.deepEqual(lib.calcularOrden(base).errores, []);
  for (const campo of ["sl", "tp"]) {
    for (const valor of ["abc", "-1", "Infinity"]) {
      const c = lib.calcularOrden({ ...base, [campo]: { modo: "precio", valor } });
      assert.ok(c.errores.some((e: string) => /Revisa el SL|Revisa el TP/.test(e)));
    }
  }
  assert.ok(lib.calcularOrden({ ...base, sl: { modo: "pips", valor: "1000" } }).errores.some((e: string) => /precio resultante/.test(e)));
});

test("el transporte rechaza NaN antes de que JSON lo convierta en null", async () => {
  const original = globalThis.fetch;
  let llamadas = 0;
  globalThis.fetch = (async () => { llamadas++; throw new Error("no debe enviarse"); }) as any;
  try {
    for (const cuerpo of [{ accion: "modificar", sl: NaN }, { accion: "cerrar", volumen: NaN }, { accion: "modificar", tp: -1 }]) {
      assert.equal((await lib.enviar(cuerpo)).estado, "rechazada");
    }
    assert.equal((await lib.enviarBinance({ accion: "niveles", sl: NaN })).estado, "rechazada");
    assert.equal(llamadas, 0);
  } finally { globalThis.fetch = original; }
});

test("el volumen visible conserva lotes pequeños y pasos fraccionarios", () => {
  assert.equal(lib.decVol({ volumen: 0.005 }), 3);
  assert.equal(lib.decVol(0.005, { volume_step: 0.001 }), 3);
  assert.equal(lib.decVol({ volumen: 0.75, volume_step: 0.25 }), 2);
  assert.equal(lib.decVol(1, { volume_step: 0.0001 }), 4);
  assert.equal(lib.decVol(1e-7), 7);
});

test("el SL inicial es el techo tambien en el panel: se acerca, no se aleja ni se quita", () => {
  const p = { tipo: "buy", entrada: 100, sl: 95, actual: 105, bid: 105, ask: 106, sl_inicial: 90, digitos: 2 };
  assert.equal(lib.problemaCambio(p, { sl: 95 }), null);
  assert.equal(lib.problemaCambio(p, { sl: 90 }), null);
  assert.match(lib.problemaCambio(p, { sl: 89 }), /techo/);
  assert.match(lib.problemaCambio(p, { sl: 0 }), /techo/);
  assert.equal(lib.problemaCambio(p, { tp: 120 }), null);
  const venta = { tipo: "sell", entrada: 100, sl: 105, actual: 95, bid: 94, ask: 95, sl_inicial: 110, digitos: 2 };
  assert.equal(lib.problemaCambio(venta, { sl: 110 }), null);
  assert.match(lib.problemaCambio(venta, { sl: 111 }), /techo/);
  // Una pendiente todavia no tiene techo.
  assert.equal(lib.problemaCambio({ tipo: "buy_limit", entrada: 100, bid: 105, ask: 106, sl_inicial: null }, { sl: 50 }), null);
});
