// Order blocks: giro, ruptura con cierre, filtro de volumen, invalidacion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderBlocks } from "../src/orderBlocks.ts";

let t = 0;
const vela = (o: number, h: number, l: number, c: number, volume = 100) => ({ time: (t += 300), open: o, high: h, low: l, close: c, volume, buy: volume / 2, closed: true });

/** Un giro alto en 110, una caida a 95 (la vela del OB) y un impulso que cierra arriba de 110. */
function escenario(volImpulso: number) {
  t = 0;
  const v = [];
  for (let i = 0; i < 20; i++) v.push(vela(100, 101, 99, 100));
  v.push(vela(100, 106, 100, 105), vela(105, 110, 104, 108));                 // sube al giro (110)
  for (let i = 0; i < 6; i++) v.push(vela(104, 105, 101, 102));               // baja
  v.push(vela(102, 102, 95, 96, 150));                                        // la vela del OB (minimo 95)
  v.push(vela(96, 104, 96, 103, volImpulso), vela(103, 113, 103, 112, volImpulso));   // impulso: cierra arriba de 110
  for (let i = 0; i < 3; i++) v.push(vela(112, 114, 111, 113));
  return v;
}

test("un OB alcista: la vela del minimo antes de la ruptura, con el volumen del impulso", () => {
  const obs = orderBlocks(escenario(400));
  const ob = obs.find((z) => z.alc);
  assert.ok(ob, "hay OB alcista");
  assert.equal(ob.bot, 95);
  assert.equal(ob.top, 102);
  assert.equal(ob.vol, 150 + 400 + 400);
  assert.ok(ob.fuerza! > 1.2);
  assert.equal(ob.probado, false);
});

test("sin volumen en el impulso no hay OB (no es al azar)", () => {
  assert.equal(orderBlocks(escenario(60)).filter((z) => z.alc).length, 0);
});

test("una vela que cierra debajo del OB lo invalida; una mecha que entra lo deja probado", () => {
  const v = escenario(400);
  const probado = [...v, vela(113, 113, 100, 108)];
  assert.equal(orderBlocks(probado).find((z) => z.alc)?.probado, true);
  const roto = [...v, vela(113, 113, 90, 92)];
  assert.equal(orderBlocks(roto).filter((z) => z.alc).length, 0);
});
