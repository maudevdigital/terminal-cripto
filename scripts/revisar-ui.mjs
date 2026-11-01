/** Prueba visual con datos deterministas y sin conexión a cuentas reales.
 * Ejecutar después de npm run build. CHROME_PATH permite elegir Chromium/Edge. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { armarGrafico } from "../web/src/lib/graficoVelas.js";

// El servidor ya incluye ws mediante este plugin; resuelve también instalaciones sin hoisting.
const { WebSocketServer } = createRequire(import.meta.resolve("@fastify/websocket"))("ws");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".revision");
mkdirSync(output, { recursive: true });
const candidatos = [process.env.CHROME_PATH,
  join(homedir(), "AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
const ejecutable = candidatos.find((p) => existsSync(p));
assert.ok(ejecutable, "Configura CHROME_PATH con la ruta a Chromium o Edge.");
const cfg = {
  symbols: ["BTCUSDT", "ADAUSDT", "US100", "US500", "XAUUSDT", "USDCLP"],
  mercados: { BTCUSDT: { nombre: "BTC", tipo: "cripto", fuente: "Binance" }, ADAUSDT: { nombre: "ADA", tipo: "cripto", fuente: "Binance" },
    US100: { nombre: "US100", tipo: "indice", fuente: "NQ=F" }, US500: { nombre: "US500", tipo: "indice", fuente: "ES=F" },
    XAUUSDT: { nombre: "ORO", tipo: "materia", fuente: "Binance" }, USDCLP: { nombre: "USD/CLP", tipo: "divisa", fuente: "CLP=X" } },
  intervals: ["1M", "1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"],
  interval_labels: { "1M": "Mensual", "1w": "Semanal", "1d": "Diario", "4h": "4H", "1h": "1H", "30m": "30m", "15m": "15m", "5m": "5m", "1m": "1m" },
  replay_simbolo: "US100", riesgo_pct: 0.5,
  indicadores: { adx: [14, 14], sqz: [20, 2, 20, 1.5, true] }, ema: [10, 50, 200], adx_clave: 23, vp_filas: 24, trading: false,
  mt5_simbolos: {}, usdtd: { symbol: "USDT.D", intervals: ["1h", "4h", "1d"] },
};
const bases = { BTCUSDT: 69431.12, ADAUSDT: 0.123456, US100: 22123.25, US500: 6021.75, XAUUSDT: 3210.23, USDCLP: 931.45, "USDT.D": 5.123 };
const pasos = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
const cache = new Map();
let brokerActivo = false, pedidosDeOrden = 0;
const pausaSim = { activa: false, quitarEn: null, esperaMin: 10 };
function payload(symbol, interval, type = "snapshot") {
  const key = `${symbol}:${interval}`;
  if (!cache.has(key)) {
    const b = bases[symbol], paso = pasos[interval] ?? 300, amplitud = symbol === "ADAUSDT" ? 0.00001 : symbol === "USDT.D" ? 0.001 : 5;
    const final = Math.floor(Date.now() / 1000 / paso) * paso;
    const velas = Array.from({ length: 1500 }, (_, i) => {
      const o = b + Math.sin(i / 20) * amplitud * 6, c = o + Math.cos(i / 7) * amplitud;
      return { t: final - (1499 - i) * paso, o, h: Math.max(o, c) + amplitud, l: Math.min(o, c) - amplitud, c, v: 120.123 + i % 30, closed: i !== 1499 };
    });
    cache.set(key, armarGrafico(velas, cfg));
  }
  const g = cache.get(key), grafico = type === "snapshot" ? g : Object.fromEntries(Object.entries(g).map(([k, v]) => [k, k === "ema" ? v.map((s) => s.slice(-2)) : v.slice(-2)]));
  if (type === "update") {
    const b = g.velas.at(-1), amplitud = symbol === "ADAUSDT" ? 0.000002 : symbol === "USDT.D" ? 0.0001 : .2;
    const close = b.close + Math.sin(Date.now() / 500) * amplitud;
    grafico.velas = [...grafico.velas.slice(0, -1), { ...b, close, high: Math.max(b.high, close), low: Math.min(b.low, close), volume: b.volume + Math.abs(Math.sin(Date.now() / 500)) }];
  }
  const ahora = Date.now();
  const broker = brokerActivo ? {
    disponible: true, vivo: true, trading: true, simbolo: "BTCUSD", digitos: 2, bid: bases.BTCUSDT, ask: bases.BTCUSDT + 1, diferencia: 0,
    cuenta: { login: 123456, servidor: "Cuenta simulada", moneda: "USD", balance: 10000, equity: 10000 }, equity: 10000, margenLibre: 10000,
    operador: { vivo: true, habilitado: true, sl_obligatorio: true }, posiciones: [], otras: [], ordenes: [], otrasOrdenes: [],
    freno: { activo: pausaSim.activa, bloquea: pausaSim.activa, motivos: pausaSim.activa ? ["cuenta real en pausa"] : [], hasta: pausaSim.quitarEn, porDia: false, pausa: { ...pausaSim }, hoy: 0, seguidas: 0, reglas: { operacionesDia: 1, perdidaDia: 30 } },
    info: { symbol: "BTCUSD", digits: 2, bid: bases.BTCUSDT, ask: bases.BTCUSDT + 1, pip: 1, por_punto: 1, volume_step: .01, volume_min: .01, volume_max: 10 },
  } : { disponible: false, vivo: false, posiciones: [], otras: [] };
  return { ok: true, type, symbol, interval, grafico, precio: g.velas.at(-1).close, fuente: null,
    broker, binance: null, noticias: [], ejecuciones: [],
    tickers: Object.fromEntries(Object.entries(bases).map(([s, last]) => [s, { last, change_pct: 1.23 }])),
    feed: { stream_up: true, server_ms: ahora, last_event_ms: ahora } };
}
const lista = Object.entries(bases).map(([symbol, last]) => ({ symbol, last, cambio: last * .0123, change_pct: 1.23, puntos: Array.from({ length: 24 }, (_, i) => last * (1 + Math.sin(i) * .003)), dia: { o: last * .99, h: last * 1.02, l: last * .98 } }));
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    if (u.pathname.endsWith("/orden")) { pedidosDeOrden++; res.statusCode = 405; return res.end(JSON.stringify({ ok: false, mensaje: "Prueba visual: envío deshabilitado" })); }
    if (u.pathname === "/api/pausa") {
      let cuerpo = "";
      for await (const x of req) cuerpo += x;
      const { accion } = JSON.parse(cuerpo || "{}");
      if (accion === "quitar") pausaSim.quitarEn = Date.now() + 10 * 60_000;
      else Object.assign(pausaSim, { activa: true, quitarEn: null });
      return res.end(JSON.stringify({ ok: true, ...pausaSim }));
    }
    if (u.pathname === "/api/config") return res.end(JSON.stringify(cfg));
    if (u.pathname === "/api/lista") return res.end(JSON.stringify(lista));
    if (u.pathname === "/api/snapshot") return res.end(JSON.stringify(payload(u.searchParams.get("symbol"), u.searchParams.get("interval"))));
    if (u.pathname === "/api/backtest/operaciones") return res.end(JSON.stringify({ operaciones: [], ok: true }));
    if (u.pathname === "/api/sonidos") return res.end(JSON.stringify({ disponibles: [], ninjatrader: false }));
    if (u.pathname === "/api/velas") return res.end(JSON.stringify({ ok: true, velas: [], hayMas: false }));
    return res.end(JSON.stringify({ ok: true, eventos: [], registros: [], resumen: {}, operaciones: [] }));
  }
  const archivo = u.pathname === "/" ? join(root, "web/dist/index.html") : resolve(root, "web/dist", u.pathname.replace(/^\/static\//, ""));
  if (!archivo.startsWith(join(root, "web/dist") + "/") && !archivo.startsWith(join(root, "web/dist") + "\\")) { res.statusCode = 403; return res.end(); }
  try {
    const tipos = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    res.setHeader("Content-Type", tipos[extname(archivo)] ?? "application/octet-stream"); res.end(readFileSync(archivo));
  } catch { res.statusCode = 404; res.end(); }
});
const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set();
let pushMs = 400;
wss.on("connection", (ws) => {
  sockets.add(ws);
  let view = null;
  let ultimoEnvio = 0;
  ws.on("message", (raw) => { view = JSON.parse(String(raw)); ws.send(JSON.stringify(payload(view.symbol, view.interval))); });
  const t = setInterval(() => {
    if (view && ws.readyState === ws.OPEN && Date.now() - ultimoEnvio >= pushMs) {
      ultimoEnvio = Date.now(); ws.send(JSON.stringify(payload(view.symbol, view.interval, "update")));
    }
  }, 100);
  ws.on("close", () => { sockets.delete(ws); clearInterval(t); });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, cdp;
try {
  browser = spawn(ejecutable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${join(output, "browser-profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("El navegador no inició CDP")), 15000);
    let stderr = "";
    browser.on("error", (e) => { clearTimeout(t); reject(e); });
    browser.on("exit", (code) => { clearTimeout(t); reject(new Error(`El navegador terminó (${code}): ${stderr}`)); });
    browser.stderr.on("data", (b) => { stderr += String(b); const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  cdp = new WebSocket(endpoint);
  await new Promise((r, j) => { cdp.onopen = r; cdp.onerror = j; });
  let id = 0;
  const pendientes = new Map(), errores = [];
  cdp.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pendientes.get(m.id); pendientes.delete(m.id); clearTimeout(p.t); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id, t = setTimeout(() => { pendientes.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pendientes.set(n, { resolve, reject, t }); cdp.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const command = (m, p) => send(m, p, sessionId);
  await command("Page.enable"); await command("Runtime.enable");
  const evaluate = async (expression) => {
    const r = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression) => {
    const limite = Date.now() + 10000;
    while (!(await evaluate(expression))) { if (Date.now() > limite) throw new Error(`No se cumplió: ${expression}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  const medir = async (rueda = false) => {
    await new Promise((r) => setTimeout(r, 800));
    const cuadros = evaluate(`new Promise(resolve => { const gaps=[]; let prev=performance.now(), start=prev; function f(t){ gaps.push(t-prev);prev=t;if(t-start<2000) requestAnimationFrame(f);else {gaps.sort((a,b)=>a-b);resolve({frames:gaps.length,p95:gaps[Math.floor(gaps.length*.95)],max:Math.max(...gaps)});}} requestAnimationFrame(f);})`);
    if (rueda) for (let n = 0; n < 15; n++) {
      await command("Input.dispatchMouseEvent", { type: "mouseWheel", x: 250, y: 300, deltaX: 0, deltaY: n < 8 ? -35 : 35 });
      await new Promise((r) => setTimeout(r, 20));
    }
    return cuadros;
  };
  await command("Emulation.setTimezoneOverride", { timezoneId: "America/Santiago" });
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('terminal-cripto:v3', JSON.stringify({symbol:'BTCUSDT',interval:'5m',sonidos:false}));` });
  await command("Page.navigate", { url });
  await waitFor("document.querySelector('.ohlc') && document.querySelectorAll('canvas').length > 2");
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('terminal-cripto:v4')).interval"), "1h");
  assert.equal(await evaluate("!!document.querySelector('.compra-rapida')"), false);
  await waitFor("!!document.querySelector('[aria-label=\"En vivo\"]')");
  // El grafico sin barra de contexto: la barra principal va pegada a las velas.
  assert.equal(await evaluate("!!document.querySelector('.contexto-barra')"), false);
  const uno = await medir(true);
  const desktop = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "escritorio.png"), Buffer.from(desktop.data, "base64"));
  // Arrastrar el eje Y del panel de abajo: el SQZ y el ADX se mueven juntos (una sola escala).
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 1355, y: 720, button: "left", clickCount: 1 });
  for (let y = 720; y <= 800; y += 10) await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1355, y, button: "left", buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1355, y: 800, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const arrastrado = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "panel-arrastrado.png"), Buffer.from(arrastrado.data, "base64"));
  // Seis gráficos mezclan cotizaciones de dos y seis decimales.
  await evaluate("document.querySelector('[aria-label=\"Diseño de los gráficos\"]').click()");
  await evaluate("document.querySelector('button[title=\"Seis (3 × 2)\"]').click()");
  await waitFor("document.querySelectorAll('section.grafico .ohlc').length === 6");
  const ohlc = await evaluate("Array.from(document.querySelectorAll('section.grafico .ohlc'), x => x.textContent)");
  assert.match(ohlc[1], /0,\d{6}/);
  assert.match(ohlc[0], /\d{2}\.\d{3},\d{2}/);
  const seis = await medir(true);
  pushMs = 100;
  const estres = await medir(true);
  const multiple = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "seis-graficos.png"), Buffer.from(multiple.data, "base64"));
  // Reconexión después de interrumpir todos los sockets activos.
  for (const ws of sockets) ws.close();
  await waitFor("!!document.querySelector('[aria-label=\"Sin conexión\"]')");
  await waitFor("!!document.querySelector('[aria-label=\"En vivo\"]') && document.querySelectorAll('section.grafico .ohlc').length === 6");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor("!!document.querySelector('.app.movil') && document.querySelectorAll('section.grafico').length === 1");
  const overflow = await evaluate("document.documentElement.scrollWidth > innerWidth");
  assert.equal(overflow, false);
  const movil = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "movil.png"), Buffer.from(movil.data, "base64"));
  // El buscador se abre también con teclado; su lista debe caber en 390 px.
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
  await waitFor("!!document.querySelector('[role=dialog]')");
  const dialogo = await evaluate("(() => { const r = document.querySelector('[role=dialog]').getBoundingClientRect(); return {left:r.left,right:r.right}; })()");
  assert.ok(dialogo.left >= 0 && dialogo.right <= 390);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await new Promise((r) => setTimeout(r, 600));
  const apaisado = await evaluate("(() => { const n = document.querySelector('.nav-movil').getBoundingClientRect(), g = document.querySelector('.panel-osc').getBoundingClientRect(); return {navegacion:n.bottom,finGrafico:g.bottom}; })()");
  const paisaje = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "apaisado.png"), Buffer.from(paisaje.data, "base64"));
  assert.ok(apaisado.navegacion <= 390 && apaisado.finGrafico <= 390, JSON.stringify(apaisado));
  // Una respuesta incierta persiste entre paneles y bloquea aperturas, sin enviar nada.
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`sessionStorage.setItem('terminal-cripto:revision-orden:mt5',JSON.stringify({estado:'sin_respuesta',mensaje:'Revisa posiciones antes de repetir'}))`);
  brokerActivo = true;
  await evaluate("document.querySelector('button[aria-label=\"Operar\"]').click()");
  await waitFor("document.body.textContent.includes('Ya revisé las posiciones y órdenes')");
  await waitFor("!!document.querySelector('.operar .op-form')");
  await evaluate(`(() => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const volumen=document.querySelector('.op-form .op-fila input'), sl=document.querySelector('.op-form .op-nivel input'); for(const [el,v] of [[volumen,'1'],[sl,'10']]) {set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await waitFor("document.querySelector('.operar .boton-orden.compra')?.disabled === true");
  await evaluate("Array.from(document.querySelectorAll('.operar button')).find(b=>b.textContent==='Ya revisé las posiciones y órdenes').click()");
  await waitFor("document.querySelector('.operar .boton-orden.compra')?.disabled === false");
  assert.equal(await evaluate("sessionStorage.getItem('terminal-cripto:revision-orden:mt5')"), null);
  await evaluate(`(() => { const el=document.querySelector('.op-form .op-nivel input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'abc');el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor("document.querySelector('.operar .boton-orden.compra')?.disabled === true");
  // La pausa de la cuenta real: ponerla frena al tiro y quitarla tarda.
  const boton = (texto) => `Array.from(document.querySelectorAll('.operar button')).find(b=>b.textContent.includes('${texto}'))`;
  await waitFor(`!!${boton("Pausar cuenta real")}`);
  await evaluate(`${boton("Pausar cuenta real")}.click()`);
  await waitFor(`!!${boton("Quitar la pausa (tarda 10 min)")}`);
  await waitFor("document.querySelector('.operar .freno')?.textContent.includes('Cuenta real en pausa')");
  await waitFor("document.querySelector('.operar .boton-orden.compra')?.disabled === true");
  await evaluate(`${boton("Quitar la pausa")}.click()`);
  await waitFor(`!!${boton("Seguir en pausa")} && document.body.textContent.includes('La pausa se quita a las')`);
  await evaluate(`${boton("Seguir en pausa")}.click()`);
  await waitFor(`!!${boton("Quitar la pausa")}`);
  assert.equal(pedidosDeOrden, 0);
  assert.deepEqual(errores, []);
  const resultado = { ok: true, datos: "simulados; 1500 velas por gráfico", navegador: ejecutable, vistas: ["1440x900", "390x844", "844x390"], graficos: 6,
    cuadros: { uno: { paquetesPorSegundo: 2.5, ...uno }, seis: { paquetesPorSegundo: 2.5, ...seis }, estres: { paquetesPorSegundo: 10, ...estres } }, bloqueoDeReenvio: true, pedidosDeOrden, errores };
  writeFileSync(join(output, "ui-resultados.json"), JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado, null, 2));
  await send("Browser.close");
} finally {
  cdp?.close(); browser?.kill();
  for (const ws of sockets) ws.terminate();
  wss.close(); await new Promise((r) => server.close(r));
}
