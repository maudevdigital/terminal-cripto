/* Servidor: sirve la interfaz y empuja la data viva por WebSocket. */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { config, esPerpetuo, esYahoo, publicConfig, ROOT, yahoo } from "./config.ts";
import { abrirMT5 } from "./lanzador.ts";
import { getLogger } from "./log.ts";
import { MarketHub } from "./market.ts";
import { valida as temporalidadValida } from "./temporalidades.ts";
import { leerSonido, NOMBRES as SONIDOS, sonidosDisponibles } from "./sonidos.ts";
import { SIMBOLO as USDTD } from "./usdtd.ts";

/** Pares validos: los de Binance, los indices y USDT.D, cada uno en sus temporalidades. */
function vistaValida(symbol: string, interval: string): boolean {
  if (symbol === USDTD) return config.USDTD_ACTIVA && ["1h", "4h", "1d"].includes(interval);
  // Las de siempre o una a medida (10m, 2H...), que se arma con una de siempre.
  if (esYahoo(symbol) || esPerpetuo(symbol)) return temporalidadValida(interval, config.INTERVALS);
  return config.SYMBOLS.includes(symbol) && temporalidadValida(interval, config.INTERVALS);
}

const log = getLogger("server");

// El build de React (npm run build). Vite lo arma con base "/static/".
const WEB = join(ROOT, "web", "dist");

/** Evita convertir un precio inválido en cero (quitar un SL/TP) o en un cierre total. */
function numerosValidos(body: any, campos: string[]): boolean {
  return campos.every((campo) => {
    const valor = body?.[campo];
    if (valor === undefined) return true;
    if (valor === null) return campo === "sl" || campo === "tp";
    return (typeof valor === "number" || typeof valor === "string" && valor.trim() !== "")
      && Number.isFinite(Number(valor)) && Number(valor) >= 0;
  });
}

/** El snapshot y el WebSocket también incluyen datos de cuenta: se comprueban
 *  el Host y el origen antes de construir o enviar esos datos. */
function desdeAca(req: any): boolean {
  const remotos = config.ACCESO_REMOTO.map((h) => h.toLowerCase());
  const h = String(req.headers.host ?? "").toLowerCase();
  const host = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h) || remotos.includes(h.replace(/:\d+$/, ""));
  const origen = String(req.headers.origin ?? "").toLowerCase();
  const origenOk = !origen || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origen)
    || remotos.some((r) => origen === `https://${r}`);
  return host && origenOk;
}

export async function crearServidor(hub: MarketHub) {
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });
  await app.register(fastifyStatic, {
    root: WEB,
    prefix: "/static/",
    // Fuerza revalidacion (ETag) en cada carga: sin esto el navegador puede
    // quedarse con archivos viejos un rato.
    setHeaders: (res) => { res.header("Cache-Control", "no-cache"); },
  });

  app.get("/api/config", async () => publicConfig());

  // La lista de seguimiento (los mercados de la terminal, con su minigrafica).
  app.get("/api/lista", async () => {
    await hub.waitReady();
    const pc = publicConfig() as any;
    return hub.lista([...(pc.usdtd ? [USDTD] : []), ...pc.symbols]);
  });

  // Los sonidos de NinjaTrader que haya en esta PC (solo los nombres; la ruta no sale).
  app.get("/api/sonidos", async () => {
    const { carpeta, archivos } = sonidosDisponibles();
    return { ninjatrader: Boolean(carpeta), disponibles: Object.keys(archivos) };
  });
  app.get<{ Params: { nombre: string } }>("/api/sonidos/:nombre", async (req, reply) => {
    const nombre = String(req.params.nombre).replace(/\.wav$/i, "");
    const datos = SONIDOS.includes(nombre) ? leerSonido(nombre) : null;
    if (!datos) return reply.code(404).send({ detail: "Sin ese sonido" });
    return reply.type("audio/wav").header("Cache-Control", "no-cache").send(datos);
  });

  app.get<{ Querystring: { symbol?: string; interval?: string } }>(
    "/api/snapshot",
    async (req, reply) => {
      if (!desdeAca(req)) return reply.code(403).send({ ok: false, error: "Origen no permitido" });
      const symbol = String(req.query.symbol ?? "").toUpperCase();
      const interval = String(req.query.interval ?? "");
      if (!vistaValida(symbol, interval)) {
        return reply.code(400).send({ detail: "Par o temporalidad no soportados" });
      }
      await hub.waitReady();
      const payload = hub.build(symbol, interval, null);
      if (!payload.ok) return reply.code(503).send(payload);
      return payload;
    },
  );

  /** Un socket por pestana. El cliente manda {symbol, interval} al cambiar de
   *  vista; el servidor responde con un snapshot y despues manda solo las ultimas
   *  barras, que es lo unico que cambia con la vela abierta. */
  app.get("/ws", {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!desdeAca(req)) return reply.code(403).send({ ok: false, error: "Origen no permitido" });
    },
  }, async (socket) => {
    const state = {
      symbol: config.SYMBOLS[0] ?? Object.keys(yahoo())[0], interval: config.GATILLO_TF,
      reset: true,
    };
    let abierto = true;
    let suscripto = false;
    let congestionDesde = 0;
    let ultimaRevision: number | undefined;
    let ultimaVistaEnviada: string | undefined;

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw));
        const symbol = String(msg.symbol ?? "").toUpperCase();
        const interval = String(msg.interval ?? "");
        if (vistaValida(symbol, interval)) {
          const otraVista = symbol !== state.symbol || interval !== state.interval || !suscripto;
          Object.assign(state, { symbol, interval });
          if (otraVista) state.reset = true;
          suscripto = true;
        }
      } catch { /* mensaje ilegible: se ignora */ }
    });
    socket.on("close", () => { abierto = false; });
    socket.on("error", (exc: Error) => {
      abierto = false;
      log.warn(`WebSocket del cliente cerrado: ${exc.message}`);
    });

    await hub.waitReady();
    // Espera la suscripcion del cliente para no mandar una vista que no pidio.
    for (let i = 0; i < 30 && !suscripto && abierto; i++) await new Promise((r) => setTimeout(r, 100));

    while (abierto) {
      if (socket.readyState !== socket.OPEN) break;
      // Un cliente lento no debe acumular snapshots sin límite. Al recuperarse
      // recibe el estado completo, incluidas las velas que no pudo recibir.
      if (socket.bufferedAmount > 1024 * 1024) {
        congestionDesde ||= Date.now();
        state.reset = true;
        if (Date.now() - congestionDesde > 15_000) { socket.terminate(); break; }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      congestionDesde = 0;
      const revision = hub.revisionVista?.(state.symbol, state.interval);
      if (revision !== ultimaRevision) state.reset = true;
      let payload: any;
      if (state.reset) {
        payload = hub.build(state.symbol, state.interval, null);
        const vista = `${state.symbol}|${state.interval}`;
        payload.conservarVista = vista === ultimaVistaEnviada;
        // Sin datos todavia (un indice que esta cargando): se reintenta el snapshot.
        if (payload.ok) { state.reset = false; ultimaRevision = revision; ultimaVistaEnviada = vista; }
        payload.type = "snapshot";
      } else {
        payload = hub.build(state.symbol, state.interval, 2);
        payload.type = "update";
      }
      payload.symbol ??= state.symbol;
      payload.interval ??= state.interval;
      if (socket.readyState !== socket.OPEN) break;
      socket.send(JSON.stringify(payload));
      await new Promise((r) => setTimeout(r, config.PUSH_INTERVAL * 1000));
    }
  });

  /** Calendario economico de FTMO entre dos fechas (AAAA-MM-DD) de la zona del navegador. */
  app.get<{ Querystring: { desde?: string; hasta?: string; zona?: string } }>("/api/calendario", async (req, reply) => {
    const zona = /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(String(req.query.zona ?? "")) ? String(req.query.zona) : "UTC";
    try {
      return { eventos: await hub.calendario.eventos(String(req.query.desde ?? ""), String(req.query.hasta ?? ""), zona) };
    } catch (exc) {
      return reply.code(502).send({ eventos: [], error: (exc as Error).message });
    }
  });

  /** Velas anteriores a `antes` (s), para completar el grafico hacia atras. */
  app.get<{ Querystring: { symbol?: string; interval?: string; antes?: string; n?: string } }>("/api/velas", async (req, reply) => {
    const symbol = String(req.query.symbol ?? "").toUpperCase();
    const interval = String(req.query.interval ?? "");
    const antes = Number(req.query.antes);
    if (!vistaValida(symbol, interval) || !(antes > 0)) return reply.code(400).send({ ok: false, error: "Pedido inválido" });
    const n = Math.min(20_000, Math.max(100, Number(req.query.n) || 3000));
    return hub.velasAntes(symbol, interval, antes, n);
  });

  /** Velas para el replay del grafico (el mercado de REPLAY_SIMBOLO). */
  app.get<{ Querystring: { symbol?: string } }>("/api/replay", async (req, reply) => {
    const r = hub.replay(String(req.query.symbol ?? ""));
    if (!r) return reply.code(404).send({ ok: false, error: "El replay es solo del mercado de REPLAY_SIMBOLO." });
    return r;
  });

  /** Las operaciones simuladas del backtest manual (en datos/backtest.json). */
  const rutaBacktest = join(config.DATOS, "backtest.json");
  app.get("/api/backtest/operaciones", async () => {
    try { return JSON.parse(readFileSync(rutaBacktest, "utf8")); } catch { return { operaciones: [] }; }
  });
  app.put<{ Body: any }>("/api/backtest/operaciones", async (req, reply) => {
    if (!desdeAca(req)) return reply.code(403).send({ ok: false, error: "Origen no permitido" });
    const ops = (req.body as any)?.operaciones;
    if (!Array.isArray(ops) || ops.length > 5000) return reply.code(400).send({ ok: false, error: "Lista inválida" });
    mkdirSync(config.DATOS, { recursive: true });
    writeFileSync(rutaBacktest, JSON.stringify({ operaciones: ops }, null, 1));
    return { ok: true, n: ops.length };
  });

  /** Historial de la cuenta: operaciones cerradas, metricas, dias y riesgo. */
  app.get<{ Querystring: { dias?: string } }>("/api/historial", async (req, reply) => {
    if (!desdeAca(req)) return reply.code(403).send({ disponible: false, motivo: "Origen no permitido" });
    return hub.diario.resumen(Math.max(0, Math.min(3650, Number(req.query.dias) || 0)));
  });

  /** "Sincronizar ahora" con Google Sheets. */
  app.post("/api/historial/sheets", async (req, reply) => {
    if (req.headers["x-terminal"] !== "operativa" || !desdeAca(req)) return reply.code(403).send({ error: "Origen no permitido" });
    return hub.diario.sincronizarYa();
  });

  /** Ordenes del panel Operar. Solo desde la propia interfaz: el header propio
   *  obliga a un navegador a pedir permiso (CORS) antes de mandarlo desde otro
   *  sitio, y ese permiso no se da; ademas se mira el origen y el Host. */
  /** Binance (futuros): abrir, mover el SL y el TP, cerrar y cancelar. Las mismas
   *  defensas que la de MT5: solo desde la terminal y con el freno de disciplina. */
  app.post<{ Body: any }>("/api/binance/orden", async (req, reply) => {
    if (req.headers["x-terminal"] !== "operativa" || !desdeAca(req)) {
      return reply.code(403).send({ ok: false, mensaje: "Origen no permitido" });
    }
    const b: any = req.body ?? {};
    if (!numerosValidos(b, ["cantidad", "precio", "sl", "tp"])) {
      return reply.code(400).send({ ok: false, mensaje: "Cantidad o precios inválidos: usa números mayores o iguales a cero" });
    }
    const freno = hub.freno();
    if (b.accion === "abrir" && freno?.bloquea) {
      return { ok: false, mensaje: `Freno de disciplina: ${freno.motivos.join(" y ")}. No se abre nada nuevo.` };
    }
    const nivel = (x: unknown) => (x === undefined ? undefined : Number(x) || 0);
    return hub.binance.enviar({
      accion: b.accion, symbol: String(b.symbol ?? ""), lado: b.lado, tipo: b.tipo ?? "mercado",
      cantidad: Number(b.cantidad) || 0, precio: Number(b.precio) || 0, sl: nivel(b.sl), tp: nivel(b.tp), id: b.id === undefined ? undefined : String(b.id),
    });
  });

  /** La pausa de la cuenta real: mientras dure no se abre nada nuevo. */
  app.post<{ Body: any }>("/api/pausa", async (req, reply) => {
    if (req.headers["x-terminal"] !== "operativa" || !desdeAca(req)) {
      return reply.code(403).send({ ok: false, mensaje: "Origen no permitido" });
    }
    return hub.accionPausa((req.body as any)?.accion);
  });

  /** Creditos demo (src/demo.ts): una cuenta virtual; no pasan por el Operador. */
  app.post<{ Body: any }>("/api/demo", async (req, reply) => {
    if (req.headers["x-terminal"] !== "demo" || !desdeAca(req)) {
      return reply.code(403).send({ ok: false, mensaje: "Origen no permitido" });
    }
    const b: any = req.body ?? {};
    if (!numerosValidos(b, ["riesgo", "precio", "sl", "tp"])) {
      return reply.code(400).send({ ok: false, mensaje: "Riesgo o precios inválidos: usa números mayores o iguales a cero" });
    }
    return hub.accionDemo(b);
  });

  app.post<{ Body: any }>("/api/orden", async (req, reply) => {
    if (req.headers["x-terminal"] !== "operativa" || !desdeAca(req)) {
      return reply.code(403).send({ ok: false, estado: "rechazada", mensaje: "Origen no permitido" });
    }
    const b: any = req.body ?? {};
    if (!numerosValidos(b, ["volumen", "precio", "sl", "tp", "ticket"])) {
      return reply.code(400).send({ ok: false, estado: "rechazada", mensaje: "Volumen, precios o ticket inválidos: usa números mayores o iguales a cero" });
    }
    // El freno de disciplina: con el modo bloquear no se abre nada nuevo (cerrar,
    // mover SL/TP y cancelar siguen permitidos).
    const freno = hub.freno();
    if (b.accion === "abrir" && freno?.bloquea) {
      const hora = freno.hasta ? ` Se levanta a las ${new Date(freno.hasta).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}.` : "";
      return { ok: false, estado: "rechazada", mensaje: `Freno de disciplina: ${freno.motivos.join(" y ")}.${hora}` };
    }
    // El riesgo inicial es el techo: acercar el SL si, ampliarlo no.
    const problemaSl = b.accion === "modificar" ? hub.problemaSl?.(b.ticket, b.sl) : null;
    if (problemaSl) return { ok: false, estado: "rechazada", mensaje: problemaSl };
    // A MT5, por el EA operador.
    const r = await hub.operativa.enviar({
      accion: b.accion, symbol: b.symbol, lado: b.lado, tipo: b.tipo, volumen: Number(b.volumen ?? 0),
      precio: Number(b.precio) || 0, sl: Number(b.sl) || 0, tp: Number(b.tp) || 0, ticket: Number(b.ticket) || 0,
    });
    return r;
  });

  app.get("/", async (_req, reply) => {
    if (!existsSync(join(WEB, "index.html"))) {
      return reply.code(503).type("text/plain; charset=utf-8")
        .send("Falta el build de la interfaz: corre `npm run build`.");
    }
    // index.html apunta a los assets con hash del build: si el navegador se
    // queda con uno viejo, pide archivos que ya no existen.
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html");
  });

  return app;
}

/** Abre el navegador del sistema (npm start lo deja listo para usar). */
function abrir(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch { /* sin navegador: queda la URL en el log */ }
}

/** Con `node --watch` el servidor se reinicia con cada cambio, pero el proceso
 *  que vigila es siempre el mismo: el navegador se abre una sola vez por
 *  `npm run dev` (la pestana que ya estaba abierta se reconecta sola). */
function primeraVez(): boolean {
  const marca = join(config.DATOS, ".navegador");
  const id = String(process.ppid);
  try { if (readFileSync(marca, "utf8").trim() === id) return false; } catch { /* sin marca */ }
  try {
    mkdirSync(config.DATOS, { recursive: true });
    writeFileSync(marca, id);
  } catch { /* sin disco: a lo sumo se abre otra pestana */ }
  return true;
}

export async function main() {
  const hub = new MarketHub();
  log.info(`Cargando historico de ${config.SYMBOLS.join(", ")} ...`);
  const app = await crearServidor(hub);
  await app.listen({ host: config.HOST, port: config.PORT });
  const url = `http://${config.HOST}:${config.PORT}`;
  // MT5 y el navegador se abren ya: la historia se carga mientras tanto.
  void abrirMT5();
  if (config.ABRIR_NAVEGADOR && !process.argv.includes("--sin-navegador") && primeraVez()) abrir(url);
  await hub.start();
  log.info(`Terminal listo en ${url}`);

  const cerrar = async () => {
    hub.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
}
