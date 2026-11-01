import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore El transporte se comparte con el navegador.
import { crearConexionMercado } from "../web/src/lib/marketConnection.js";

function entorno() {
  const sockets: any[] = [], solicitudes: any[] = [], timers: any[] = [];
  const recibidos: any[] = [], avisos: any[] = [], estados: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    enviados: any[] = [];
    onopen = () => {};
    onclose = () => {};
    onmessage = (_: any) => {};
    constructor(_url: string) { sockets.push(this); }
    send(p: string) { this.enviados.push(JSON.parse(p)); }
    abrir() { this.readyState = 1; this.onopen(); }
    mensaje(p: any) { this.onmessage({ data: typeof p === "string" ? p : JSON.stringify(p) }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose(); }
  }
  const env = {
    WebSocket: Socket, location: { protocol: "http:", host: "localhost" },
    fetch: (url: string, options: any) => new Promise((resolve, reject) => solicitudes.push({ url, options, resolve: (p: any) => resolve({ json: async () => p }), reject })),
    setTimeout: (fn: any, ms: number) => { const t = { fn, ms, cancelado: false }; timers.push(t); return t; },
    clearTimeout: (t: any) => { if (t) t.cancelado = true; },
    setInterval: (fn: any, ms: number) => { const t = { fn, ms, cancelado: false }; timers.push(t); return t; },
    clearInterval: (t: any) => { if (t) t.cancelado = true; },
  };
  const conexion = crearConexionMercado({ view: { symbol: "BTCUSDT", interval: "5m" }, onPayload: (p: any) => recibidos.push(p), onAviso: (p: any) => avisos.push(p), onConexion: (p: any) => estados.push(p) }, env);
  return { conexion, sockets, solicitudes, timers, recibidos, avisos, estados };
}

const p = (type = "snapshot", symbol = "BTCUSDT", interval = "5m", precio = 100) => ({ ok: true, type, symbol, interval, precio, grafico: { velas: [] } });
const pendiente = () => new Promise((resolve) => setImmediate(resolve));

test("una respuesta REST atrasada no reemplaza las velas más recientes del WebSocket", async () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.sockets[0].mensaje(p());
  e.sockets[0].mensaje(p("update", "BTCUSDT", "5m", 102));
  e.solicitudes[0].resolve(p("snapshot", "BTCUSDT", "5m", 99));
  await pendiente();
  assert.deepEqual(e.recibidos.map((x) => x.precio), [100, 102]);
  e.conexion.cerrar();
});

test("cambiar vista aborta la foto anterior e ignora incrementos hasta recibir la foto correcta", async () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.sockets[0].mensaje(p());
  e.conexion.cambiarVista({ symbol: "ADAUSDT", interval: "1h" });
  assert.equal(e.solicitudes[0].options.signal.aborted, true);
  e.sockets[0].mensaje(p("update", "ADAUSDT", "1h"));
  e.sockets[0].mensaje(p());
  e.solicitudes[0].resolve(p());
  await pendiente();
  assert.equal(e.recibidos.length, 1);
  e.solicitudes[1].resolve(p("snapshot", "ADAUSDT", "1h", 0.123456));
  await pendiente();
  assert.equal(e.recibidos.at(-1).precio, 0.123456);
  assert.deepEqual(e.sockets[0].enviados.at(-1), { symbol: "ADAUSDT", interval: "1h" });
  e.conexion.cerrar();
});

test("reconectar exige snapshot, tolera JSON ilegible y cancela todos los recursos al cerrar", () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.sockets[0].mensaje(p());
  e.sockets[0].close();
  assert.equal(e.estados.at(-1), false);
  const retry = e.timers.find((t) => t.ms === 1000);
  retry.fn();
  e.sockets[1].abrir();
  e.sockets[1].mensaje("{ilegible");
  e.sockets[1].mensaje(p("update"));
  assert.equal(e.recibidos.length, 1);
  e.sockets[1].mensaje(p());
  assert.equal(e.recibidos.length, 2);
  e.conexion.cerrar();
  assert.equal(e.solicitudes[0].options.signal.aborted, true);
  assert.equal(e.sockets[1].readyState, 3);
  assert.ok(e.timers.every((t) => t.cancelado));
});

test("salir del replay espera una foto completa antes de incorporar incrementos", async () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.sockets[0].mensaje(p());
  e.conexion.refrescar();
  e.sockets[0].mensaje(p("update", "BTCUSDT", "5m", 200));
  assert.equal(e.recibidos.length, 1);
  e.solicitudes[1].resolve(p("snapshot", "BTCUSDT", "5m", 201));
  await pendiente();
  e.sockets[0].mensaje(p("update", "BTCUSDT", "5m", 202));
  assert.deepEqual(e.recibidos.map((x) => x.precio), [100, 201, 202]);
  e.conexion.cerrar();
});

test("el vigilante detecta un socket abierto que dejó de entregar mensajes", (t) => {
  const tiempo = Date.now();
  const reloj = t.mock.method(Date, "now", () => tiempo);
  const e = entorno();
  e.sockets[0].abrir();
  reloj.mock.mockImplementation(() => tiempo + 16_000);
  e.timers.find((x) => x.ms === 5000).fn();
  assert.equal(e.estados.at(-1), false);
  assert.match(e.avisos.at(-1), /reconectando/);
  e.conexion.cerrar();
});

test("un fallo temporal al recuperar la foto del replay se reintenta aunque sigan llegando incrementos", async () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.sockets[0].mensaje(p());
  e.conexion.refrescar();
  e.solicitudes[1].reject(new Error("Sin red"));
  await pendiente();
  e.sockets[0].mensaje(p("update"));
  const retry = e.timers.find((x) => x.ms === 1000 && !x.cancelado);
  assert.ok(retry);
  retry.fn();
  e.solicitudes[2].resolve(p("snapshot", "BTCUSDT", "5m", 300));
  await pendiente();
  assert.equal(e.recibidos.at(-1).precio, 300);
  e.conexion.cerrar();
});

test("la foto de WebSocket cancela reintentos REST que reiniciarían la vista", async () => {
  const e = entorno();
  e.sockets[0].abrir();
  e.solicitudes[0].reject(new Error("Servidor ocupado"));
  await pendiente();
  const retry = e.timers.find((x) => x.ms === 1000 && !x.cancelado);
  assert.ok(retry);
  e.sockets[0].mensaje(p());
  assert.equal(retry.cancelado, true);
  retry.fn();
  assert.equal(e.solicitudes.length, 1);
  e.conexion.cerrar();
});
