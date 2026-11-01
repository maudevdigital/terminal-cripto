/* Chequeo del panel Operar: pips, redondeo al tick y la validacion de cada orden
 * contra la especificacion del simbolo. Nada de esto toca MT5. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alTick, enDinero, pipDe, validar } from "../src/operativa.ts";

const ORO = { symbol: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, bid: 4159.64, ask: 4160.05,
  volume_min: 0.01, volume_step: 0.01, volume_max: 100, stops_level: 0, contract_size: 100 };
const US100 = { symbol: "US100.cash", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01, bid: 29578.4, ask: 29580.1,
  volume_min: 0.01, volume_step: 0.01, volume_max: 50, stops_level: 0 };
const EURUSD = { symbol: "EURUSD", digits: 5, point: 0.00001, bid: 1.08, ask: 1.08002 };
const OP = { sl_obligatorio: true, lote_max: 5 };

test("pips: divisas 10 puntos, oro 0,1, indices y cripto 1", () => {
  assert.equal(pipDe(EURUSD), 0.0001);
  assert.equal(pipDe(ORO), 0.1);
  assert.equal(pipDe(US100), 1);
  assert.equal(pipDe({ symbol: "XAGUSD", digits: 3, point: 0.001, bid: 57.4 }), 0.01);
});

test("dinero: distancia por valor del tick por volumen", () => {
  assert.equal(enDinero(40, ORO, 0.1), 400);           // 40 dolares de oro x 100 onzas x 0,1 lote
  assert.equal(enDinero(-100, US100, 1), 100);         // 100 puntos del indice a 1 USD por punto
  assert.equal(alTick(4160.0449, ORO), 4160.04);
});

test("volumen: conserva pasos de 0,25 y rechaza números inválidos antes de operar", () => {
  const info = { ...ORO, volume_step: 0.25, volume_min: 0.25 };
  const r = validar({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.75, sl: 4100 }, info, OP);
  assert.ok("orden" in r && r.orden.volumen === 0.75);
  assert.equal(alTick(12.4, { digits: 0, tick_size: 1 }), 12);
  const pos = { ticket: 7, symbol: "XAUUSD", type: "buy", volume: 0.5, price_open: 4100 };
  for (const volumen of [-0.1, NaN, Infinity]) {
    assert.ok("error" in validar({ accion: "cerrar", ticket: 7, volumen }, ORO, OP, pos), `no cerrar todo por volumen ${volumen}`);
  }
  assert.ok("error" in validar({ accion: "modificar", ticket: 7, sl: NaN }, ORO, { sl_obligatorio: false }, pos));
  assert.ok("error" in validar({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.1, sl: 4000 }, { ...ORO, bid: 0, ask: 0 }, OP));
});

test("abrir: lados del SL y del TP, precio de la limite, volumen y SL obligatorio", () => {
  const ok = validar({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.104, sl: 4120, tp: 4250 }, ORO, OP);
  assert.ok("orden" in ok);
  if ("orden" in ok) assert.equal(ok.orden.volumen, 0.1);             // redondeado al paso
  const err = (p: any) => { const r = validar(p, ORO, OP); return "error" in r ? r.error : null; };
  assert.match(err({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.1, sl: 4170 })!, /SL va debajo/);
  assert.match(err({ accion: "abrir", lado: "sell", tipo: "mercado", volumen: 0.1, sl: 4200, tp: 4170 })!, /TP va debajo/);
  assert.match(err({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.1 })!, /Falta el stop loss/);
  assert.match(err({ accion: "abrir", lado: "buy", tipo: "limite", volumen: 0.1, precio: 4170, sl: 4100 })!, /debajo del ask/);
  assert.match(err({ accion: "abrir", lado: "sell", tipo: "limite", volumen: 0.1, precio: 4150, sl: 4200 })!, /arriba del bid/);
  assert.match(err({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 6, sl: 4100 })!, /InpLoteMax/);
  assert.match(err({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.001, sl: 4100 })!, /mínimo/);
  // Sin SL obligatorio, se puede abrir sin stop.
  assert.ok("orden" in validar({ accion: "abrir", lado: "buy", tipo: "mercado", volumen: 0.1 }, ORO, { sl_obligatorio: false }));
  // La limite toma su propio precio como referencia del SL y del TP.
  const lim = validar({ accion: "abrir", lado: "buy", tipo: "limite", volumen: 0.1, precio: 4100.004, sl: 4080, tp: 4150 }, ORO, OP);
  assert.ok("orden" in lim && lim.orden.precio === 4100);
});

test("cerrar, modificar y cancelar necesitan una posicion u orden que exista", () => {
  const pos = { ticket: 7, symbol: "XAUUSD", type: "buy", volume: 0.5, price_open: 4100, price_current: 4160 };
  assert.ok("error" in validar({ accion: "cerrar", ticket: 7 }, ORO, OP, null));
  const parcial = validar({ accion: "cerrar", ticket: 7, volumen: 0.2 }, ORO, OP, pos);
  assert.ok("orden" in parcial && parcial.orden.volumen === 0.2);
  const total = validar({ accion: "cerrar", ticket: 7, volumen: 0.5 }, ORO, OP, pos);
  assert.ok("orden" in total && total.orden.volumen === 0);
  assert.ok("error" in validar({ accion: "modificar", ticket: 7, sl: 0, tp: 4300 }, ORO, OP, pos));      // no se quita el SL
  assert.ok("error" in validar({ accion: "modificar", ticket: 7, sl: 4170, tp: 4300 }, ORO, OP, pos));   // SL sobre el precio
  assert.ok("orden" in validar({ accion: "modificar", ticket: 7, sl: 4120, tp: 4300 }, ORO, OP, pos));
  const lim = { ticket: 9, symbol: "XAUUSD", type: "buy_limit", volume: 0.1, price_open: 4100 };
  assert.ok("orden" in validar({ accion: "cancelar", ticket: 9 }, ORO, OP, lim));
});

// --------------------------------------------------------------- el circuito
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Operativa } from "../src/operativa.ts";
import { config } from "../src/config.ts";

// La operativa viene apagada por defecto: estas pruebas la encienden.
config.TRADING_ACTIVO = true;

function puenteFalso(dir: string) {
  const estado = join(dir, "estado.json");
  writeFileSync(estado, "{}");
  return {
    estado: () => ({
      available: true, live: true, path: estado, account: { login: 12345678 },
      symbols: { XAUUSD: { ...ORO } }, positions: [{ ticket: 7, symbol: "XAUUSD", type: "buy", volume: 0.5, price_open: 4100 }], orders: [],
    }),
  } as any;
}

test("circuito: la orden llega al EA como clave=valor y vuelve su respuesta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "operativa-"));
  const op = join(dir, "operador");
  mkdirSync(join(op, "entrada"), { recursive: true });
  mkdirSync(join(op, "salida"), { recursive: true });
  writeFileSync(join(op, "estado.json"), JSON.stringify({ vivo_ms: Date.now() + 60_000, habilitado: true, sl_obligatorio: true, lote_max: 5 }));
  // Un EA de mentira: lee la orden y contesta como el de verdad.
  let leida: Record<string, string> = {};
  const ea = setInterval(() => {
    for (const f of readdirSync(join(op, "entrada")).filter((x) => x.endsWith(".txt"))) {
      const texto = readFileSync(join(op, "entrada", f), "ascii");
      rmSync(join(op, "entrada", f));
      leida = Object.fromEntries(texto.split("\r\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      writeFileSync(join(op, "salida", `${leida.id}.json`),
        JSON.stringify({ id: leida.id, ok: true, retcode: 10009, mensaje: "Compra abierta", ticket: 99, precio: 4160.05, volumen: 0.1 }));
    }
  }, 50);
  try {
    const terminal = new Operativa(puenteFalso(dir));
    const pedido = { accion: "abrir", symbol: "XAUUSDT", lado: "buy", tipo: "mercado", volumen: 0.1, sl: 4120, tp: 4250 } as const;
    const primero = terminal.enviar(pedido);
    const repetido = await terminal.enviar(pedido);
    assert.equal(repetido.ok, false);
    assert.match(repetido.mensaje, /pedido en curso/);
    assert.equal(readdirSync(join(op, "entrada")).length, 1);
    const r = await primero;
    assert.equal(r.ok, true);
    assert.equal(r.ticket, 99);
    assert.equal(leida.accion, "abrir");
    assert.equal(leida.symbol, "XAUUSD");          // el simbolo del broker
    assert.equal(leida.cuenta, "12345678");
    assert.equal(Number(leida.volumen), 0.1);
    assert.equal(Number(leida.sl), 4120);
    assert.ok(Math.abs(Date.now() - Number(leida.creado)) < 5000);
    assert.equal(readdirSync(join(op, "salida")).length, 0);   // la respuesta se consume

    // Una orden invalida no llega al EA.
    const mala = await new Operativa(puenteFalso(dir)).enviar({ accion: "abrir", symbol: "XAUUSDT", lado: "buy", tipo: "mercado", volumen: 0.1 });
    assert.equal(mala.ok, false);
    assert.match(mala.mensaje, /stop loss/);
  } finally {
    clearInterval(ea);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("circuito: si el EA no toma la orden a tiempo, se retira y no se ejecuta despues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "operativa-"));
  const op = join(dir, "operador");
  mkdirSync(join(op, "entrada"), { recursive: true });
  writeFileSync(join(op, "estado.json"), JSON.stringify({ vivo_ms: Date.now() + 60_000, habilitado: true, sl_obligatorio: false, lote_max: 5 }));
  try {
    const r = await new Operativa(puenteFalso(dir)).enviar({ accion: "cerrar", ticket: 7 });
    assert.equal(r.ok, false);
    assert.match(r.mensaje, /no se envió/);
    assert.equal(readdirSync(join(op, "entrada")).length, 0);
    assert.ok(!existsSync(join(op, "salida", "x")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
