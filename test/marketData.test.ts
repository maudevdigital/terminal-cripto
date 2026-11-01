import { test } from "node:test";
import assert from "node:assert/strict";
import { BinanceRest, combinedStream, velaValida, type Candle } from "../src/binance.ts";
import { MarketHub } from "../src/market.ts";
import { agrupar } from "../src/usdtd.ts";

const inicio = 1_800_000_000;
const vela = (t = inicio, cambios: Partial<Candle> = {}): Candle => ({
  t, t_ms: t * 1000, close_time: (t + 60) * 1000 - 1,
  o: 1.012345, h: 1.018765, l: 1.001234, c: 1.015678,
  v: 0.12345678, vb: 0.05, trades: 5, closed: false, ...cambios,
});

// No se instancia MarketHub: sus colaboradores reales tienen estado en disco.
function hub(): any {
  return Object.assign(Object.create(MarketHub.prototype), {
    candles: new Map(), tickers: {}, ultimosTrades: new Map(), aMedida: new Map(), streams: new Map(), streamsIniciados: new Set(), eventos: new Map(), graficos: new Map(),
    indiceEnMT5: () => false,
  });
}

test("la historia conserva los decimales de OHLC y volumen", () => {
  const h = hub(), c = vela();
  h.historiaProfunda = () => [c];
  assert.deepEqual(h.velasAntes("BTCUSDT", "1m", inicio + 60, 10).velas,
    [[c.t, c.o, c.h, c.l, c.c, c.v]]);
});

test("un trade atrasado no cambia velas de ninguna temporalidad ni el ticker", () => {
  const h = hub(), m1 = vela(), h1 = vela(inicio - 1800, { close_time: (inicio + 1800) * 1000 - 1 });
  h.candles.set("BTCUSDT|1m", [m1]); h.candles.set("BTCUSDT|1h", [h1]);
  h.applyTrade({ s: "BTCUSDT", p: "8", T: inicio * 1000 - 1, l: 10 });
  assert.equal(m1.c, 1.015678); assert.equal(h1.c, 1.015678);
  assert.deepEqual(h.tickers, {});
});

test("un trade invalido o fuera de orden no contamina precios", () => {
  const h = hub(), c = vela(); h.candles.set("BTCUSDT|1m", [c]);
  h.applyTrade({ s: "BTCUSDT", p: "1.02", T: inicio * 1000 + 20, l: 10 });
  h.applyTrade({ s: "BTCUSDT", p: "1.01", T: inicio * 1000 + 10, l: 9 });
  h.applyTrade({ s: "BTCUSDT", p: "NaN", T: inicio * 1000 + 30, l: 11 });
  assert.equal(c.c, 1.02); assert.equal(h.tickers.BTCUSDT.last, 1.02);
});

test("los klines atrasados no retroceden el ultimo trade ni reabren velas", () => {
  const h = hub(); h.candles.set("BTCUSDT|1m", [vela()]);
  h.applyTrade({ s: "BTCUSDT", p: "1.02", T: inicio * 1000 + 20, l: 10 });
  const k = { t: inicio * 1000, T: (inicio + 60) * 1000 - 1, i: "1m", o: "1.012345", h: "1.018765", l: "1.001234", c: "1.015678", v: "0.2", V: "0.1", n: 6, L: 9, x: false };
  h.applyKline({ s: "BTCUSDT", k });
  assert.equal(h.candles.get("BTCUSDT|1m")[0].c, 1.02);
  h.applyKline({ s: "BTCUSDT", k: { ...k, x: true, L: 11 } });
  h.applyKline({ s: "BTCUSDT", k });
  assert.equal(h.candles.get("BTCUSDT|1m")[0].closed, true);
});

test("resync incorpora correcciones historicas y conserva las velas llegadas durante REST", () => {
  const h = hub(), vieja = vela(inicio - 60), actual = vela();
  const previa = { ...actual };
  h.candles.set("BTCUSDT|1m", [vieja, actual]);
  actual.c = 1.017;
  const nueva = vela(inicio + 60);
  h.candles.get("BTCUSDT|1m").push(nueva);
  h.mezclar("BTCUSDT", "1m", [{ ...vieja, c: 1.016 }, vela()], previa);
  const out = h.candles.get("BTCUSDT|1m");
  assert.deepEqual(out.map((x: Candle) => x.t), [inicio - 60, inicio, inicio + 60]);
  assert.equal(out[0].c, 1.016); assert.equal(out[1].c, 1.017); assert.equal(out[2], nueva);
});

test("la agregacion custom se invalida al corregir un maximo o historia interior", () => {
  const h = hub(), a = vela(), b = vela(inicio + 60);
  h.candles.set("BTCUSDT|1m", [a, b]);
  const inicial = h.serie("BTCUSDT", "3m");
  b.h = 2;
  assert.equal(h.serie("BTCUSDT", "3m")[0].h, 2);
  h.candles.set("BTCUSDT|1m", [{ ...a, l: 0.9 }, b]);
  assert.equal(h.serie("BTCUSDT", "3m")[0].l, 0.9);
  assert.equal(inicial[0].h, 1.018765);
});

test("USDT.D no cierra una vela de 4h antes de terminar el periodo", () => {
  const t = inicio - inicio % 14400;
  const horas = [0, 1].map((k) => vela(t + k * 3600, { close_time: (t + (k + 1) * 3600) * 1000 - 1, closed: true }));
  const out = agrupar(horas, 4, (t + 2 * 3600) * 1000);
  assert.equal(out[0].closed, false);
  assert.equal(out[0].v, horas[0].v + horas[1].v);
});

test("el cache del grafico comparte clientes y respeta ticks, volumen y correcciones historicas", () => {
  const h = hub(), datos = Array.from({ length: 60 }, (_, i) => vela(inicio + i * 60));
  h.candles.set("BTCUSDT|1m", datos);
  const completo = h.grafico("BTCUSDT", "1m");
  assert.equal(h.grafico("BTCUSDT", "1m"), completo);
  const cola = h.grafico("BTCUSDT", "1m", 2);
  assert.equal(h.grafico("BTCUSDT", "1m", 2), cola);
  assert.deepEqual(cola.velas, completo.velas.slice(-2));
  assert.deepEqual(cola.ema, completo.ema.map((v: any[]) => v.slice(-2)));
  assert.deepEqual(cola.fuerza, completo.fuerza.slice(-2));
  datos.at(-1)!.c = 1.017;
  assert.equal(h.grafico("BTCUSDT", "1m", 2).velas.at(-1).close, 1.017);
  datos.at(-1)!.v = 0.2;
  assert.equal(h.grafico("BTCUSDT", "1m", 2).velas.at(-1).volume, 0.2);
  h.candles.set("BTCUSDT|1m", datos.map((x, i) => i === 0 ? { ...x, c: 1.01 } : x));
  assert.equal(h.grafico("BTCUSDT", "1m").velas[0].close, 1.01);
});

test("Binance REST conserva precision, ordena, descarta datos invalidos y cierra por timestamp", async () => {
  const rest = new BinanceRest();
  const raw = (t: number, close = "1.015678") => [t * 1000, "1.012345", "1.018765", "1.001234", close, "0.12345678", (t + 60) * 1000 - 1, "0", 5, "0.05"];
  (rest as any).get = async () => [raw(180), raw(60), raw(120, "NaN"), raw(180)];
  const out = await rest.klines("BTCUSDT", "1m", 10);
  assert.deepEqual(out.map((x) => x.t), [60, 180]);
  assert.equal(out[1].closed, true);
  assert.equal(out[0].c, 1.015678); assert.equal(out[0].v, 0.12345678);
  assert.equal(velaValida({ ...out[0], h: 0 }), false);
});

test("la paginacion de Binance termina aunque el proveedor repita la misma pagina", async () => {
  const rest = new BinanceRest(); let pedidos = 0;
  (rest as any).get = async () => {
    pedidos++;
    assert.ok(pedidos <= 2, "no debe quedar en un bucle infinito");
    return Array.from({ length: 1000 }, (_, k) => [k * 60000, "1", "2", "0.5", "1.5", "1", (k + 1) * 60000 - 1, "1", 1, "0.5"]);
  };
  const out = await rest.klines("BTCUSDT", "1m", 1500);
  assert.equal(pedidos, 2); assert.equal(out.length, 1000);
});

test("cada stream mantiene su estado y los futuros tambien resincronizan al reconectar", async () => {
  const h = hub(); let resyncs = 0;
  h.resyncAll = async () => { resyncs++; };
  await h.onStatus("up", "spot"); await h.onStatus("up", "futuros");
  assert.equal(resyncs, 0);
  await h.onStatus("down", "futuros");
  assert.equal(h.streams.get("spot"), true); assert.equal(h.streams.get("futuros"), false);
  await h.onStatus("up", "futuros");
  assert.equal(resyncs, 1);
});

test("un socket fallido se cierra y ya no entrega eventos tardios", async () => {
  const original = globalThis.WebSocket;
  const sockets: any[] = [];
  class Socket {
    onopen: any; onmessage: any; onerror: any; onclose: any;
    cerrado = false;
    constructor(_url: string) { sockets.push(this); }
    close() { this.cerrado = true; }
  }
  globalThis.WebSocket = Socket as any;
  let detener: (() => void) | undefined;
  try {
    const eventos: any[] = [], estados: string[] = [];
    detener = combinedStream(["BTCUSDT"], ["1m"], (e) => eventos.push(e), (s) => { estados.push(s); });
    const socket = sockets[0];
    socket.onopen(); await Promise.resolve();
    socket.onerror(); await Promise.resolve();
    socket.onmessage({ data: JSON.stringify({ data: { e: "aggTrade" } }) });
    assert.equal(socket.cerrado, true);
    assert.deepEqual(estados, ["up", "down"]); assert.deepEqual(eventos, []);
  } finally {
    detener?.(); globalThis.WebSocket = original;
  }
});
