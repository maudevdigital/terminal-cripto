// Ejecuciones: abrir, llenar una limite, mover el SL, cerrar por SL o TP (con el historial o por el precio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ejecuciones, deducirMotivo, motivoMT5, type PosicionVista } from "../src/ejecuciones.ts";

const venta: PosicionVista = { id: "77", simbolo: "US100.cash", lado: "sell", volumen: 0.5, entrada: 25000, actual: 24990, sl: 25050, tp: 24900 };
const tipos = (e: Ejecuciones) => e.recientes(10_000).map((x) => x.tipo);

test("la primera vuelta solo se anota; después, abrir, mover el SL y la cerrada a mano", () => {
  const e = new Ejecuciones();
  e.observar("mt5", "1", [], [], undefined, 0);
  assert.deepEqual(tipos(e), []);
  e.observar("mt5", "1", [venta], [], undefined, 1000);
  e.observar("mt5", "1", [{ ...venta, sl: 25020 }], [], undefined, 2000);
  e.observar("mt5", "1", [], [], undefined, 3000);
  assert.deepEqual(tipos(e), ["abierta", "modificada", "cerrada"]);
});

test("lo que ya estaba abierto al prender la terminal no suena; cambiar de cuenta tampoco", () => {
  const e = new Ejecuciones();
  e.observar("mt5", "1", [venta], [], undefined, 0);
  e.observar("mt5", "2", [], [{ id: "9", simbolo: "XAUUSD", lado: "buy" }], undefined, 1000);
  assert.deepEqual(tipos(e), []);
});

test("una límite que se llena suena como abierta, no como cancelada", () => {
  const e = new Ejecuciones();
  e.observar("mt5", "1", [], [], undefined, 0);
  e.observar("mt5", "1", [], [{ id: "77", simbolo: "US100.cash", lado: "sell" }], undefined, 1000);
  e.observar("mt5", "1", [venta], [], undefined, 2000);
  assert.deepEqual(tipos(e), ["pendiente", "abierta"]);
  // En Binance la posicion no lleva el id de la orden: va por simbolo y lado.
  const b = new Ejecuciones();
  b.observar("binance", "b", [], [{ id: "123", simbolo: "BTCUSDT", lado: "buy" }], undefined, 0);
  b.observar("binance", "b", [{ ...venta, id: "BTCUSDT:buy", simbolo: "BTCUSDT", lado: "buy", sl: null, tp: null }], [], undefined, 1000);
  b.observar("binance", "b", [], [{ id: "124", simbolo: "BTCUSDT", lado: "buy" }], undefined, 2000);
  b.observar("binance", "b", [], [], undefined, 3000);
  assert.deepEqual(tipos(b), ["abierta", "pendiente", "cerrada", "cancelada"]);
});

test("MT5: el motivo sale del historial, que puede llegar unos segundos después", () => {
  const e = new Ejecuciones();
  let deals: any[] = [];
  e.observar("mt5", "1", [venta], [], motivoMT5(deals), 0);
  e.observar("mt5", "1", [], [], motivoMT5(deals), 1000);
  assert.deepEqual(tipos(e), []);   // espera al historial
  deals = [{ position: 77, entry: "in", reason: "client" }, { position: 77, entry: "out", reason: "tp" }];
  e.observar("mt5", "1", [], [], motivoMT5(deals), 3000);
  assert.deepEqual(tipos(e), ["tp"]);
});

test("MT5 sin el historial: a los 8 s se deduce del último precio", () => {
  const e = new Ejecuciones();
  e.observar("mt5", "1", [{ ...venta, actual: 25048 }], [], motivoMT5([]), 0);
  e.observar("mt5", "1", [], [], motivoMT5([]), 1000);
  e.observar("mt5", "1", [], [], motivoMT5([]), 5000);
  assert.deepEqual(tipos(e), []);
  e.observar("mt5", "1", [], [], motivoMT5([]), 9500);
  assert.deepEqual(tipos(e), ["sl"]);
});

test("por el precio: cerca o pasado el SL, el TP, o ninguno", () => {
  assert.equal(deducirMotivo({ ...venta, actual: 25060 }), "sl");
  assert.equal(deducirMotivo({ ...venta, actual: 24910 }), "tp");
  assert.equal(deducirMotivo({ ...venta, actual: 25000 }), "cerrada");
  assert.equal(deducirMotivo({ ...venta, lado: "buy", sl: 24950, tp: 25100, actual: 24955 }), "sl");
  assert.equal(deducirMotivo({ ...venta, sl: null, tp: null, actual: 25060 }), "cerrada");
});

test("cierre parcial, y las de hace más de 2 minutos ya no van", () => {
  const e = new Ejecuciones();
  e.observar("mt5", "1", [venta], [], undefined, 0);
  e.observar("mt5", "1", [{ ...venta, volumen: 0.25 }], [], undefined, 1000);
  assert.deepEqual(e.recientes(2000).map((x) => x.tipo), ["parcial"]);
  assert.deepEqual(e.recientes(1000 + 120_001), []);
});
