// Peticiones locales contra dobles: nunca se conecta con brokers ni envía órdenes reales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { config } from "../src/config.ts";
import { crearServidor } from "../src/server.ts";

test("la API rechaza niveles y volúmenes inválidos antes de enviar al operador", async () => {
  const recibidos: any[] = [];
  const enviar = async (p: any) => { recibidos.push(p); return { ok: true }; };
  const app = await crearServidor({ freno: () => null, operativa: { enviar }, binance: { enviar } } as any);
  const headers = { host: "127.0.0.1:8787", "x-terminal": "operativa" };
  try {
    for (const [url, campo, valor] of [
      ["/api/orden", "sl", "inválido"], ["/api/orden", "volumen", -1], ["/api/orden", "volumen", null],
      ["/api/orden", "tp", true], ["/api/binance/orden", "sl", "NaN"], ["/api/binance/orden", "cantidad", "Infinity"],
    ] as const) {
      const r = await app.inject({ method: "POST", url, headers, payload: { accion: "modificar", [campo]: valor } });
      assert.equal(r.statusCode, 400, `${url} ${campo}=${valor}`);
    }
    assert.equal(recibidos.length, 0);
    const cerrar = await app.inject({ method: "POST", url: "/api/orden", headers, payload: { accion: "cerrar", ticket: 7 } });
    assert.equal(cerrar.statusCode, 200);
    assert.equal(recibidos[0].volumen, 0);
    const quitar = await app.inject({ method: "POST", url: "/api/binance/orden", headers, payload: { accion: "niveles", symbol: "BTCUSDT", lado: "buy", sl: null } });
    assert.equal(quitar.statusCode, 200);
    assert.equal(recibidos[1].sl, 0);
  } finally {
    await app.close();
  }
});

test("el freno frena la apertura, deja cerrar, y un SL ampliado no llega al operador", async () => {
  const recibidos: any[] = [];
  const enviar = async (p: any) => { recibidos.push(p); return { ok: true }; };
  const pausas: unknown[] = [];
  const hub = {
    freno: () => ({ bloquea: true, motivos: ["cuenta real en pausa"], hasta: null }),
    problemaSl: (ticket: unknown, sl: unknown) => (Number(sl) < 90 ? `techo ${ticket}` : null),
    accionPausa: (a: unknown) => { pausas.push(a); return { ok: true, activa: true }; },
    operativa: { enviar }, binance: { enviar },
  };
  const app = await crearServidor(hub as any);
  const headers = { host: "127.0.0.1:8787", "x-terminal": "operativa" };
  const orden = (payload: any) => app.inject({ method: "POST", url: "/api/orden", headers, payload });
  try {
    const abrir = await orden({ accion: "abrir", symbol: "US100", lado: "buy", tipo: "mercado", volumen: 0.1, sl: 90 });
    assert.equal(abrir.json().ok, false);
    assert.match(abrir.json().mensaje, /cuenta real en pausa/);
    const binance = await app.inject({ method: "POST", url: "/api/binance/orden", headers, payload: { accion: "abrir", symbol: "BTCUSDT", lado: "buy", cantidad: 1 } });
    assert.equal(binance.json().ok, false);
    const ampliar = await orden({ accion: "modificar", ticket: 7, sl: 80, tp: 0 });
    assert.equal(ampliar.json().ok, false);
    assert.match(ampliar.json().mensaje, /techo 7/);
    assert.equal(recibidos.length, 0);
    // Acercar el SL y cerrar pasan, aunque el freno este puesto.
    assert.equal((await orden({ accion: "modificar", ticket: 7, sl: 95, tp: 0 })).json().ok, true);
    assert.equal((await orden({ accion: "cerrar", ticket: 7 })).json().ok, true);
    assert.equal(recibidos.length, 2);
    // La pausa solo se cambia desde la propia terminal.
    const ajena = await app.inject({ method: "POST", url: "/api/pausa", headers: { host: "127.0.0.1:8787" }, payload: { accion: "quitar" } });
    assert.equal(ajena.statusCode, 403);
    const propia = await app.inject({ method: "POST", url: "/api/pausa", headers, payload: { accion: "poner" } });
    assert.equal(propia.json().activa, true);
    assert.deepEqual(pausas, ["poner"]);
  } finally {
    await app.close();
  }
});

test("un WebSocket lento pausa el envío y se recupera con un snapshot completo", { timeout: 3000 }, async () => {
  const intervaloAnterior = config.PUSH_INTERVAL;
  config.PUSH_INTERVAL = 0.01;
  let construidas = 0;
  const app = await crearServidor({
    waitReady: async () => {},
    build: () => { construidas++; return { ok: true }; },
  } as any);
  let ws: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    await app.ready();
    ws = await app.injectWS("/ws", { headers: { host: "localhost:8787" } });
    const primera = once(ws, "message");
    ws.send(JSON.stringify({ symbol: config.SYMBOLS[0], interval: config.GATILLO_TF }));
    await primera;
    const servidor = [...app.websocketServer.clients][0];
    let pendientes = 2 * 1024 * 1024;
    Object.defineProperty(servidor, "bufferedAmount", { get: () => pendientes });
    await new Promise((r) => setTimeout(r, 30));
    const alPausar = construidas;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(construidas, alPausar);
    const recuperada = once(ws, "message");
    pendientes = 0;
    const [raw] = await recuperada;
    assert.equal(JSON.parse(String(raw)).type, "snapshot");
  } finally {
    ws?.terminate();
    await app.close();
    config.PUSH_INTERVAL = intervaloAnterior;
  }
});

test("snapshot y WebSocket rechazan orígenes externos antes de revelar datos de cuenta", async () => {
  let construidas = 0;
  const app = await crearServidor({
    waitReady: async () => {},
    build: () => { construidas++; return { ok: true, broker: { cuenta: { login: 123 } } }; },
  } as any);
  try {
    await app.ready();
    const url = `/api/snapshot?symbol=${config.SYMBOLS[0]}&interval=${config.GATILLO_TF}`;
    for (const headers of [
      { host: "127.0.0.1:8787", origin: "https://externo.example" },
      { host: "externo.example:8787", origin: "http://localhost:5173" },
    ]) {
      const r = await app.inject({ url, headers });
      assert.equal(r.statusCode, 403);
      assert.ok(!r.body.includes("123"));
      await assert.rejects(app.injectWS("/ws", { headers }), /403/);
    }
    assert.equal(construidas, 0);
    const local = await app.inject({ url, headers: { host: "localhost:8787", origin: "http://localhost:5173" } });
    assert.equal(local.statusCode, 200);
    const ipv6 = await app.inject({ url, headers: { host: "[::1]:8787", origin: "http://[::1]:5173" } });
    assert.equal(ipv6.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("snapshot y handshake mantienen ACCESO_REMOTO autorizado", async () => {
  const anteriores = config.ACCESO_REMOTO;
  config.ACCESO_REMOTO = ["terminal.example.ts.net"];
  const app = await crearServidor({ waitReady: async () => {}, build: () => ({ ok: true }) } as any);
  let ws: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    await app.ready();
    const headers = { host: "terminal.example.ts.net", origin: "https://terminal.example.ts.net" };
    const r = await app.inject({ url: `/api/snapshot?symbol=${config.SYMBOLS[0]}&interval=${config.GATILLO_TF}`, headers });
    assert.equal(r.statusCode, 200);
    ws = await app.injectWS("/ws", { headers });
    assert.equal(ws.readyState, ws.OPEN);
  } finally {
    ws?.terminate();
    await app.close();
    config.ACCESO_REMOTO = anteriores;
  }
});

test("el socket reemplaza la historia cuando cambia la fuente o se corrigen velas pasadas", { timeout: 3000 }, async () => {
  const anterior = config.PUSH_INTERVAL;
  config.PUSH_INTERVAL = 0.01;
  let revision = 1;
  let fuente = "Yahoo";
  const colas: (number | null)[] = [];
  const app = await crearServidor({
    waitReady: async () => {},
    revisionVista: () => revision,
    build: (_s: string, _i: string, tail: number | null) => { colas.push(tail); return { ok: true, fuente: { nombre: fuente } }; },
  } as any);
  let ws: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    await app.ready();
    ws = await app.injectWS("/ws", { headers: { host: "localhost:8787" } });
    const inicial = once(ws, "message");
    ws.send(JSON.stringify({ symbol: config.SYMBOLS[0], interval: config.GATILLO_TF }));
    const primera = JSON.parse(String((await inicial)[0]));
    assert.equal(primera.type, "snapshot");
    assert.equal(primera.conservarVista, false);
    assert.equal(JSON.parse(String((await once(ws, "message"))[0])).type, "update");
    assert.equal(colas.at(-1), 2);
    fuente = "MT5"; revision++;
    const cambioFuente = JSON.parse(String((await once(ws, "message"))[0]));
    assert.equal(cambioFuente.type, "snapshot");
    assert.equal(cambioFuente.conservarVista, true);
    assert.equal(cambioFuente.fuente.nombre, "MT5");
    assert.equal(colas.at(-1), null);
    revision++;
    const historiaCorregida = JSON.parse(String((await once(ws, "message"))[0]));
    assert.equal(historiaCorregida.type, "snapshot");
    assert.equal(historiaCorregida.conservarVista, true);
    assert.equal(colas.at(-1), null);
    const siguiente = config.INTERVALS.find((i) => i !== config.GATILLO_TF)!;
    const otraVista = once(ws, "message");
    ws.send(JSON.stringify({ symbol: config.SYMBOLS[0], interval: siguiente }));
    const cambiada = JSON.parse(String((await otraVista)[0]));
    assert.equal(cambiada.type, "snapshot");
    assert.equal(cambiada.conservarVista, false);
  } finally {
    ws?.terminate();
    await app.close();
    config.PUSH_INTERVAL = anterior;
  }
});
