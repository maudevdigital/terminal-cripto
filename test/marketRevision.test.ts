import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketHub } from "../src/market.ts";
import type { Candle } from "../src/binance.ts";

const vela = (i: number, cambios: Partial<Candle> = {}): Candle => ({
  t: i * 60, t_ms: i * 60_000, close_time: (i + 1) * 60_000 - 1,
  o: 100, h: 102, l: 99, c: 101, v: 10, vb: 5, trades: 2, closed: true, ...cambios,
});

function vista(inicial = [1, 2, 3, 4].map((i) => vela(i))) {
  let datos = inicial;
  let broker = false;
  const hub = Object.assign(Object.create(MarketHub.prototype), {
    serie: () => datos,
    indiceEnMT5: () => broker,
  });
  return {
    revision: () => hub.revisionVista("US100", "1m"),
    datos: () => datos,
    cambiar: (nuevos: Candle[]) => { datos = nuevos; },
    usarBroker: () => { broker = true; },
  };
}

test("ticks, resync sin cambios y rotación normal del buffer conservan la revisión", () => {
  const v = vista(), primera = v.revision();
  v.datos().at(-1)!.c = 101.5;
  assert.equal(v.revision(), primera);
  v.cambiar(v.datos().map((c) => ({ ...c })));
  assert.equal(v.revision(), primera);
  v.cambiar(v.datos().slice(1).concat(vela(5)));
  assert.equal(v.revision(), primera);
});

test("corregir, insertar o borrar velas pasadas cambia la revisión sin cambiar de proveedor", () => {
  const v = vista();
  let anterior = v.revision();
  v.cambiar(v.datos().map((c, i) => i === 0 ? { ...c, v: 11 } : c));
  assert.notEqual(v.revision(), anterior);
  anterior = v.revision();
  v.cambiar(v.datos().filter((c) => c.t !== 120));
  assert.notEqual(v.revision(), anterior);
  anterior = v.revision();
  v.cambiar([v.datos()[0], vela(2), ...v.datos().slice(1)]);
  assert.notEqual(v.revision(), anterior);
});

test("un salto de más de una vela o un cambio Yahoo→MT5 requiere snapshot", () => {
  const v = vista();
  const primera = v.revision();
  v.cambiar(v.datos().concat(vela(5), vela(6)));
  assert.notEqual(v.revision(), primera);
  const antesDelBroker = v.revision();
  v.usarBroker();
  assert.notEqual(v.revision(), antesDelBroker);
});
