// Binance (futuros): lo que se manda al abrir, mover el SL y el TP, cerrar y cancelar.
// fetch es falso: nada sale a internet. Se mira que pedidos se arman y en que orden.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { BinanceCuenta } from "../src/binanceCuenta.ts";

interface Pedido { metodo: string; path: string; params: URLSearchParams }
let pedidos: Pedido[] = [];
let respuestas: Record<string, (p: Pedido) => { status?: number; body: any }> = {};

const responder = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });

const base = () => ({
  "GET /fapi/v2/account": () => ({ body: { totalWalletBalance: "1000", totalMarginBalance: "1000", availableBalance: "900", totalUnrealizedProfit: "0" } }),
  "GET /fapi/v2/positionRisk": () => ({ body: [] }),
  "GET /fapi/v1/openOrders": () => ({ body: [] }),
  "GET /fapi/v1/openAlgoOrders": () => ({ body: [] }),
  "GET /fapi/v1/positionSide/dual": () => ({ body: { dualSidePosition: false } }),
  "GET /fapi/v1/premiumIndex": () => ({ body: { markPrice: "60000.00" } }),
  "GET /fapi/v1/exchangeInfo": () => ({ body: { symbols: [{ symbol: "BTCUSDT", status: "TRADING", filters: [
    { filterType: "PRICE_FILTER", tickSize: "0.10" },
    { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    { filterType: "MIN_NOTIONAL", notional: "100" },
  ] }] } }),
  "POST /fapi/v1/order": () => ({ body: { orderId: 1, avgPrice: "60000.0" } }),
  "POST /fapi/v1/algoOrder": () => ({ body: { algoId: 7 } }),
  "DELETE /fapi/v1/order": () => ({ body: {} }),
  "DELETE /fapi/v1/algoOrder": () => ({ body: {} }),
});

globalThis.fetch = (async (url: string, init?: { method?: string }) => {
  const u = new URL(url);
  const p: Pedido = { metodo: init?.method ?? "GET", path: u.pathname, params: u.searchParams };
  pedidos.push(p);
  const r = respuestas[`${p.metodo} ${p.path}`];
  if (!r) return responder({ msg: "sin respuesta" }, 404);
  const { status = 200, body } = r(p);
  return responder(body, status);
}) as any;

const mandados = () => pedidos.filter((p) => p.metodo !== "GET").map((p) => `${p.metodo} ${p.path} ${p.params.get("type") ?? ""}`.trim());

async function cuenta(): Promise<BinanceCuenta> {
  const c = new BinanceCuenta();
  await (c as any).actualizar();
  pedidos = [];
  return c;
}

beforeEach(() => {
  config.BINANCE_API_KEY = "clave-de-prueba";
  config.BINANCE_API_SECRET = "secreto-de-prueba";
  config.BINANCE_TRADING = true;
  config.BINANCE_SL_OBLIGATORIO = true;
  config.CORTE_AUTO_USD = 0;
  pedidos = [];
  respuestas = base();
});

test("compra a mercado con SL y TP: la orden, y el SL y el TP que cierran la posición", async () => {
  const c = await cuenta();
  const r = await c.enviar({ accion: "abrir", symbol: "btcusdt", lado: "buy", tipo: "mercado", cantidad: 0.0129, sl: 59000.04, tp: 62000 });
  assert.equal(r.ok, true, r.mensaje);
  assert.deepEqual(mandados(), ["POST /fapi/v1/order MARKET", "POST /fapi/v1/algoOrder STOP_MARKET", "POST /fapi/v1/algoOrder TAKE_PROFIT_MARKET"]);
  const [orden, sl, tp] = pedidos.filter((p) => p.metodo === "POST");
  assert.equal(orden.params.get("side"), "BUY");
  assert.equal(orden.params.get("quantity"), "0.012");        // hacia abajo, al paso
  assert.ok(orden.params.get("signature"));
  assert.equal(sl.params.get("side"), "SELL");
  assert.equal(sl.params.get("triggerPrice"), "59000");        // al tick
  assert.equal(sl.params.get("closePosition"), "true");
  assert.equal(tp.params.get("triggerPrice"), "62000");
});

test("venta límite: precio al tick y GTC; arriba del precio de marca", async () => {
  const c = await cuenta();
  const r = await c.enviar({ accion: "abrir", symbol: "BTCUSDT", lado: "sell", tipo: "limite", cantidad: 0.01, precio: 61000.06, sl: 61500 });
  assert.equal(r.ok, true, r.mensaje);
  const orden = pedidos.find((p) => p.path === "/fapi/v1/order")!;
  assert.equal(orden.params.get("type"), "LIMIT");
  assert.equal(orden.params.get("price"), "61000.1");
  assert.equal(orden.params.get("timeInForce"), "GTC");
});

test("pasos de cantidad 0,25 no se redondean a un decimal", async () => {
  const exchange = respuestas["GET /fapi/v1/exchangeInfo"];
  respuestas["GET /fapi/v1/exchangeInfo"] = (p) => {
    const r = exchange(p);
    r.body.symbols[0].filters.find((f: any) => f.filterType === "MARKET_LOT_SIZE").stepSize = "0.25";
    return r;
  };
  const c = await cuenta();
  const r = await c.enviar({ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.75, sl: 59000 });
  assert.equal(r.ok, true, r.mensaje);
  assert.equal(pedidos.find((p) => p.path === "/fapi/v1/order")!.params.get("quantity"), "0.75");
});

test("un error al consultar las órdenes no se interpreta como ausencia de SL", async () => {
  config.CORTE_AUTO_USD = 30;
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "0.004", entryPrice: "80000", markPrice: "79900", unRealizedProfit: "-0.4" }] });
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ status: 503, body: { msg: "Servicio no disponible" } });
  const c = new BinanceCuenta();
  await (c as any).actualizar();
  assert.equal(c.estado().disponible, false);
  assert.match(c.estado().motivo!, /Servicio no disponible/);
  assert.deepEqual(mandados(), []);
});

test("un SL inválido no se convierte en una orden para quitar el existente", async () => {
  config.BINANCE_SL_OBLIGATORIO = false;
  const c = await cuenta();
  const r = await c.enviar({ accion: "niveles", symbol: "BTCUSDT", lado: "buy", sl: NaN });
  assert.equal(r.ok, false);
  assert.deepEqual(mandados(), []);
});

test("si falla el SL obligatorio se informa exposición existente sin cerrar una posición previa", async () => {
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "0.02", entryPrice: "60000", markPrice: "60000", unRealizedProfit: "0" }] });
  respuestas["POST /fapi/v1/algoOrder"] = () => ({ status: 400, body: { code: -2021, msg: "Order would immediately trigger." } });
  const c = await cuenta();
  const r = await c.enviar({ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01, sl: 59000 });
  assert.equal(r.ok, false);
  assert.equal(r.estado, "proteccion_incompleta");
  assert.equal(r.ejecutada, true);
  assert.equal(r.orden?.id, "1");
  assert.equal(r.orden?.cantidad, 0.01);
  assert.match(r.mensaje, /antes de repetir/);
  const aperturas = pedidos.filter((p) => p.path === "/fapi/v1/order" && p.metodo === "POST");
  assert.equal(aperturas.length, 1);
  assert.equal(aperturas[0].params.get("side"), "BUY");
  assert.ok(!pedidos.some((p) => p.metodo === "DELETE"));
});

test("dos aperturas simultáneas del mismo mercado sólo envían una orden", async () => {
  const c = await cuenta();
  const p = { accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01, sl: 59000 } as const;
  const primero = c.enviar(p);
  const segundo = await c.enviar(p);
  assert.equal(segundo.ok, false);
  assert.match(segundo.mensaje, /pedido en curso/);
  assert.equal((await primero).ok, true);
  assert.equal(pedidos.filter((p) => p.path === "/fapi/v1/order" && p.metodo === "POST").length, 1);
});

test("un cierre confirmado sigue confirmado si falla consultar las órdenes auxiliares", async () => {
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "0.01", entryPrice: "60000", markPrice: "60100", unRealizedProfit: "1" }] });
  const c = await cuenta();
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ status: 503, body: { msg: "Servicio no disponible" } });
  const r = await c.enviar({ accion: "cerrar", symbol: "BTCUSDT", lado: "buy" });
  assert.equal(r.ok, true);
  assert.match(r.mensaje, /Cerrada/);
  assert.match(r.aviso!, /no se pudo comprobar/);
});

test("lo que no sale: SL del lado equivocado, sin SL, muy chica, límite del lado equivocado, operativa apagada", async () => {
  const c = await cuenta();
  const casos: [any, RegExp][] = [
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "limit", cantidad: 0.01, sl: 59000 }, /mercado o límite/],
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01, sl: 61000 }, /SL de una compra/],
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01 }, /Falta el stop loss/],
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.0001, sl: 59000 }, /mínima/],
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.001, sl: 59000 }, /al menos 100 USDT/],
    [{ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "limite", cantidad: 0.01, precio: 60500, sl: 59000 }, /compra límite va debajo/],
  ];
  for (const [pedido, error] of casos) {
    const r = await c.enviar(pedido);
    assert.equal(r.ok, false);
    assert.match(r.mensaje, error);
  }
  config.BINANCE_TRADING = false;
  const r = await c.enviar({ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01, sl: 59000 });
  assert.match(r.mensaje, /apagada/);
  assert.deepEqual(mandados(), []);
});

test("mover el SL: primero el nuevo y después se quita el viejo", async () => {
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ body: [{ algoId: 5, symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", triggerPrice: "58000", closePosition: true }] });
  const c = await cuenta();
  const r = await c.enviar({ accion: "niveles", symbol: "BTCUSDT", lado: "buy", sl: 59500 });
  assert.equal(r.ok, true, r.mensaje);
  assert.deepEqual(mandados(), ["POST /fapi/v1/algoOrder STOP_MARKET", "DELETE /fapi/v1/algoOrder"]);
  assert.equal(pedidos.find((p) => p.metodo === "DELETE")!.params.get("algoId"), "5");
});

test("si no se puede poner el SL nuevo, el viejo queda", async () => {
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ body: [{ algoId: 5, symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", triggerPrice: "58000", closePosition: true }] });
  respuestas["POST /fapi/v1/algoOrder"] = () => ({ status: 400, body: { code: -2021, msg: "Order would immediately trigger." } });
  const c = await cuenta();
  const r = await c.enviar({ accion: "niveles", symbol: "BTCUSDT", lado: "buy", sl: 59500 });
  assert.equal(r.ok, false);
  assert.ok(!mandados().some((m) => m.startsWith("DELETE")));
});

test("sin el servicio de órdenes algorítmicas, el SL va por el endpoint de siempre", async () => {
  respuestas["POST /fapi/v1/algoOrder"] = () => ({ status: 404, body: null });
  const c = await cuenta();
  const r = await c.enviar({ accion: "abrir", symbol: "BTCUSDT", lado: "buy", tipo: "mercado", cantidad: 0.01, sl: 59000 });
  assert.equal(r.ok, true, r.mensaje);
  const sl = pedidos.filter((p) => p.path === "/fapi/v1/order")[1];
  assert.equal(sl.params.get("type"), "STOP_MARKET");
  assert.equal(sl.params.get("stopPrice"), "59000");
});

test("cerrar: a mercado, solo reducir, toda la posición; después se quitan su SL y su TP", async () => {
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "0.015", entryPrice: "60000", markPrice: "60100", unRealizedProfit: "1.5", liquidationPrice: "0", leverage: "10" }] });
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ body: [{ algoId: 5, symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", triggerPrice: "58000", closePosition: true }] });
  const c = await cuenta();
  const r = await c.enviar({ accion: "cerrar", symbol: "BTCUSDT", lado: "buy" });
  assert.equal(r.ok, true, r.mensaje);
  const orden = pedidos.find((p) => p.metodo === "POST")!;
  assert.equal(orden.params.get("side"), "SELL");
  assert.equal(orden.params.get("quantity"), "0.015");
  assert.equal(orden.params.get("reduceOnly"), "true");
  assert.ok(mandados().includes("DELETE /fapi/v1/algoOrder"));
});

test("la cuenta: posiciones con su SL y TP, y las límites que esperan", async () => {
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "-0.02", entryPrice: "61000", markPrice: "60000", unRealizedProfit: "20", liquidationPrice: "90000", leverage: "5", marginType: "cross" }] });
  respuestas["GET /fapi/v1/openOrders"] = () => ({ body: [{ orderId: 9, symbol: "ETHUSDT", side: "BUY", type: "LIMIT", price: "2500", origQty: "1", executedQty: "0", reduceOnly: false }] });
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ body: [{ algoId: 3, symbol: "BTCUSDT", side: "BUY", orderType: "STOP_MARKET", triggerPrice: "62000", closePosition: true }] });
  const c = await cuenta();
  const e = c.estado();
  assert.equal(e.disponible, true);
  assert.deepEqual(e.posiciones.map((p) => [p.simbolo, p.lado, p.cantidad, p.sl, p.tp, p.liquidacion]), [["BTCUSDT", "sell", 0.02, 62000, null, 90000]]);
  assert.deepEqual(e.pendientes.map((p) => [p.id, p.simbolo, p.lado, p.precio]), [["9", "ETHUSDT", "buy", 2500]]);
});

test("corte automático: a una compra sin SL le pone uno donde pierde 30 USDT", async () => {
  config.CORTE_AUTO_USD = 30;
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "0.004", entryPrice: "80000", markPrice: "79900", unRealizedProfit: "-0.4", liquidationPrice: "0", leverage: "10" }] });
  respuestas["GET /fapi/v1/premiumIndex"] = () => ({ body: { markPrice: "79900.00" } });
  const c = new BinanceCuenta();
  await (c as any).actualizar();
  await new Promise((r) => setTimeout(r, 30));
  const sl = pedidos.find((p) => p.path === "/fapi/v1/algoOrder" && p.metodo === "POST");
  assert.ok(sl, "puso el SL");
  assert.equal(sl!.params.get("type"), "STOP_MARKET");
  assert.equal(sl!.params.get("triggerPrice"), "72500");
});

test("corte automático: si ya perdió 30 USDT, no la cierra; con SL, tampoco toca nada", async () => {
  config.CORTE_AUTO_USD = 30;
  respuestas["GET /fapi/v2/positionRisk"] = () => ({ body: [{ symbol: "BTCUSDT", positionAmt: "-0.01", entryPrice: "60000", markPrice: "63500", unRealizedProfit: "-35", liquidationPrice: "0", leverage: "10" }] });
  const c = new BinanceCuenta();
  await (c as any).actualizar();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(mandados(), []);

  pedidos = [];
  respuestas["GET /fapi/v1/openAlgoOrders"] = () => ({ body: [{ algoId: 5, symbol: "BTCUSDT", side: "BUY", orderType: "STOP_MARKET", triggerPrice: "66000", closePosition: true }] });
  const c2 = new BinanceCuenta();
  await (c2 as any).actualizar();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(mandados(), []);
});
