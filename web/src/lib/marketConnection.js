/** Transporte del mercado. Una foto completa siempre precede a los incrementos,
 * también después de cambiar la vista o recuperar la conexión. */
export function crearConexionMercado({ view, onPayload, onAviso, onConexion }, env = globalThis) {
  let vista = null, version = 0, lista = false, revision = 0;
  let ws = null, cerrada = false, intento = 0, reintento = null, reintentoFoto = null, peticion = null;
  let ultimoMensaje = Date.now();

  const recibir = (p) => {
    if (cerrada || !p || p.symbol !== vista.symbol || p.interval !== vista.interval) return;
    if (!p.ok) { onAviso(p.error || "Cargando…"); return; }
    if (!Array.isArray(p.grafico?.velas)) return;
    if (p.type !== "snapshot" && !lista) return;
    if (p.type === "snapshot") { env.clearTimeout(reintentoFoto); reintentoFoto = null; }
    lista = true;
    revision++;
    onAviso(null);
    onPayload(p);
  };

  const suscribir = () => {
    if (ws?.readyState === env.WebSocket.OPEN) ws.send(JSON.stringify(vista));
  };

  const foto = () => {
    env.clearTimeout(reintentoFoto);
    peticion?.abort();
    const controlador = new AbortController();
    peticion = controlador;
    const actual = version, recibidas = revision, pedida = { ...vista };
    const reintentar = () => {
      if (!cerrada && !controlador.signal.aborted && actual === version && !lista) {
        reintentoFoto = env.setTimeout(() => { if (!cerrada && !lista && actual === version) foto(); }, 1000);
      }
    };
    env.fetch(`/api/snapshot?symbol=${encodeURIComponent(pedida.symbol)}&interval=${encodeURIComponent(pedida.interval)}`, { signal: controlador.signal })
      .then((r) => r.json())
      .then((p) => {
        // Una respuesta REST tardía no puede hacer retroceder lo recibido en vivo.
        if (!controlador.signal.aborted && actual === version && recibidas === revision) {
          recibir({ ...p, symbol: p.symbol ?? pedida.symbol, interval: p.interval ?? pedida.interval, type: "snapshot" });
          reintentar();
        }
      })
      .catch(() => {
        if (!cerrada && !controlador.signal.aborted && actual === version && !lista) onAviso("Esperando datos del servidor…");
        reintentar();
      });
  };

  const cambiarVista = (v) => {
    if (vista?.symbol === v.symbol && vista?.interval === v.interval) return;
    vista = { symbol: v.symbol, interval: v.interval };
    version++;
    lista = false;
    onAviso("Cargando…");
    foto();
    suscribir();
  };

  const conectar = () => {
    if (cerrada) return;
    const proto = env.location.protocol === "https:" ? "wss" : "ws";
    const socket = new env.WebSocket(`${proto}://${env.location.host}/ws`);
    ws = socket;
    ultimoMensaje = Date.now();
    socket.onopen = () => {
      if (cerrada || socket !== ws) return;
      lista = false;
      ultimoMensaje = Date.now();
      onConexion(true);
      suscribir();
    };
    socket.onmessage = (ev) => {
      if (cerrada || socket !== ws) return;
      let p;
      try { p = JSON.parse(ev.data); } catch { return; }
      ultimoMensaje = Date.now();
      // El backoff solo se reinicia cuando el servidor entrega datos.
      intento = 0;
      recibir(p);
    };
    socket.onclose = () => {
      if (cerrada || socket !== ws) return;
      lista = false;
      onConexion(false);
      onAviso("Sin conexión · reconectando…");
      intento = Math.min(intento + 1, 6);
      reintento = env.setTimeout(conectar, 500 * 2 ** intento);
    };
    socket.onerror = () => socket.close();
  };

  cambiarVista(view);
  conectar();
  // Detecta también una conexión que quedó abierta sin entregar mensajes.
  const vigilancia = env.setInterval(() => {
    if (ws && Date.now() - ultimoMensaje > 15_000) ws.close();
  }, 5000);

  return {
    cambiarVista,
    refrescar() { lista = false; foto(); },
    cerrar() {
      cerrada = true;
      peticion?.abort();
      env.clearTimeout(reintento);
      env.clearTimeout(reintentoFoto);
      env.clearInterval(vigilancia);
      ws?.close();
    },
  };
}
