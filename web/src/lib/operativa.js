import { fmtNum } from "./format.js";
/* Lo que comparten el panel Operar y el grafico al mandar ordenes y al mover el
   SL, el TP o el precio de lo que ya esta abierto. */

/** Numero escrito por la persona: acepta coma o punto. */
export const num = (s) => {
  const x = Number(String(s ?? "").trim().replace(/\s/g, "").replace(",", "."));
  return String(s ?? "").trim() !== "" && Number.isFinite(x) ? x : NaN;
};
export const ok = (x) => Number.isFinite(x) && x > 0;

/** Vacío significa sin nivel; un texto inválido nunca significa quitarlo. */
export function problemaNumero(valor, nombre, { cero = true, opcional = true } = {}) {
  if (String(valor ?? "").trim() === "") return opcional ? null : `Revisa ${nombre}: falta un número válido`;
  const n = num(valor);
  return !Number.isFinite(n) || n < 0 || !cero && n === 0
    ? `Revisa ${nombre}: usa un número ${cero ? "mayor o igual a cero" : "mayor a cero"}` : null;
}

function problemaPedido(cuerpo, campos) {
  if (!cuerpo || typeof cuerpo !== "object") return "Pedido inválido";
  const campo = campos.find((k) => cuerpo[k] !== undefined && cuerpo[k] !== null && (!Number.isFinite(cuerpo[k]) || cuerpo[k] < 0));
  return campo ? `Revisa ${campo}: usa un número válido, mayor o igual a cero` : null;
}

const decimalesPaso = (paso) => {
  const [mantisa, exponente = "0"] = String(paso).toLowerCase().split("e");
  return Math.max(0, Math.min(8, (mantisa.split(".")[1]?.length ?? 0) - Number(exponente)));
};

export async function enviar(cuerpo) {
  const problema = problemaPedido(cuerpo, ["volumen", "precio", "sl", "tp", "ticket"]);
  if (problema) return { ok: false, estado: "rechazada", mensaje: problema };
  try {
    const r = await fetch("/api/orden", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-terminal": "operativa" },
      body: JSON.stringify(cuerpo),
    });
    return await r.json();
  } catch {
    return { ok: false, estado: "sin_respuesta", mensaje: "No se recibió la respuesta del servidor. Revisa las posiciones y órdenes antes de repetir el pedido." };
  }
}

/** Una orden para Binance (futuros): abrir, niveles (SL/TP), cerrar o cancelar. */
export async function enviarBinance(cuerpo) {
  const problema = problemaPedido(cuerpo, ["cantidad", "precio", "sl", "tp"]);
  if (problema) return { ok: false, estado: "rechazada", mensaje: problema };
  try {
    const r = await fetch("/api/binance/orden", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-terminal": "operativa" },
      body: JSON.stringify(cuerpo),
    });
    return await r.json();
  } catch {
    return { ok: false, estado: "sin_respuesta", mensaje: "No se recibió la respuesta del servidor. Revisa las posiciones y órdenes antes de repetir el pedido." };
  }
}

/** A donde va lo que se manda. */
export const destino = () => "MT5";
/** Conserva el paso del broker y todos los decimales del volumen real. */
export const decVol = (posicionOValor, info = null) => {
  const p = typeof posicionOValor === "object" && posicionOValor ? posicionOValor : {};
  const valor = Number(p.volumen ?? p.cantidad ?? posicionOValor);
  const paso = Number(p.volume_step ?? info?.volume_step);
  return Math.max(2, Number.isFinite(valor) ? decimalesPaso(valor) : 0, ok(paso) ? decimalesPaso(paso) : 0);
};

/** Por que todavia no se puede mandar nada a la cuenta (null: se puede). */
export function faltaParaOperar(broker) {
  if (!broker?.disponible || !broker?.vivo) return "MT5 no está conectado con el puente";
  if (!broker.trading) return "La operativa está apagada (se enciende con TRADING_ACTIVO=true en el .env)";
  const op = broker.operador ?? {};
  if (!op.vivo) return "Falta poner el EA CriptoTerminalOperador en un gráfico de MT5";
  if (!op.habilitado) return op.motivo || "El Operador no está habilitado para esta cuenta";
  return null;
}

export const esPendiente = (p) => String(p.tipo).includes("_");
export const esCompra = (p) => String(p.tipo).startsWith("buy");

/** "Compra", "Venta límite", "Compra stop"... */
export function nombreOperacion(p) {
  const lado = esCompra(p) ? "Compra" : "Venta";
  if (!esPendiente(p)) return lado;
  return `${lado} ${String(p.tipo).endsWith("limit") ? "límite" : "stop"}`;
}

/** Lo que pasa si el precio llega a `nivel`: pips desde la entrada y resultado en
 *  dinero (negativo si pierde). `info` es la del simbolo si la posicion no la trae. */
export function resultadoEn(p, nivel, info = null) {
  const pip = p.pip ?? info?.pip;
  const porPunto = p.por_punto ?? info?.por_punto;
  if (!ok(nivel) || !ok(p.entrada)) return { pips: NaN, usd: NaN };
  const mov = (nivel - p.entrada) * (esCompra(p) ? 1 : -1);
  return {
    pips: pip ? Math.abs(nivel - p.entrada) / pip : NaN,
    usd: porPunto && ok(p.volumen) ? mov * porPunto * p.volumen : NaN,
  };
}

/** El nuevo SL, TP o precio de una operacion abierta no puede quedar del lado
 *  equivocado. Devuelve el problema en castellano, o null. `cambio`: { sl, tp, precio }. */
export function problemaCambio(p, cambio, info = null) {
  for (const [campo, nombre] of [["sl", "el SL"], ["tp", "el TP"], ["precio", "el precio"]]) {
    if (cambio[campo] === undefined) continue;
    const problema = problemaNumero(cambio[campo], nombre, { cero: campo !== "precio", opcional: campo !== "precio" });
    if (problema) return problema;
  }
  const compra = esCompra(p);
  const pendiente = esPendiente(p);
  const bid = p.bid ?? info?.bid, ask = p.ask ?? info?.ask;
  if (pendiente && ok(cambio.precio) && ok(bid) && ok(ask)) {
    const limite = String(p.tipo).endsWith("limit");
    // Compra limite debajo del ask, compra stop arriba; al reves en las ventas.
    if (compra && limite && cambio.precio >= ask) return "La compra límite va debajo del precio actual";
    if (compra && !limite && cambio.precio <= ask) return "La compra stop va arriba del precio actual";
    if (!compra && limite && cambio.precio <= bid) return "La venta límite va arriba del precio actual";
    if (!compra && !limite && cambio.precio >= bid) return "La venta stop va debajo del precio actual";
  }
  // El SL inicial es el techo: se puede acercar, no alejar ni quitar (el servidor lo revisa igual).
  if (!pendiente && ok(p.sl_inicial) && cambio.sl !== undefined
      && (!ok(cambio.sl) || (compra ? cambio.sl < p.sl_inicial : cambio.sl > p.sl_inicial))) {
    return `No se amplía el riesgo: el SL inicial (${fmtNum(p.sl_inicial, p.digitos ?? 2)}) es el techo. Puedes acercarlo o cerrar.`;
  }
  // En una posicion, contra el precio al que se cerraria; en una pendiente, contra su precio.
  const ref = pendiente ? (ok(cambio.precio) ? cambio.precio : p.entrada) : (compra ? bid : ask) ?? p.actual;
  if (!ok(ref)) return null;
  const quien = pendiente ? "del precio de la orden" : "del precio actual";
  if (ok(cambio.sl) && (compra ? cambio.sl >= ref : cambio.sl <= ref)) {
    return `En una ${compra ? "compra" : "venta"} el SL va ${compra ? "debajo" : "arriba"} ${quien}`;
  }
  if (ok(cambio.tp) && (compra ? cambio.tp <= ref : cambio.tp >= ref)) {
    return `En una ${compra ? "compra" : "venta"} el TP va ${compra ? "arriba" : "debajo"} ${quien}`;
  }
  return null;
}

/** El pedido para mover SL, TP o precio: lo que no cambia se manda como esta. */
export function pedidoModificar(p, cambio) {
  for (const [campo, nombre] of [["sl", "el SL"], ["tp", "el TP"], ["precio", "el precio"]]) {
    if (cambio[campo] === undefined) continue;
    const problema = problemaNumero(cambio[campo], nombre, { cero: campo !== "precio", opcional: campo !== "precio" });
    if (problema) throw new TypeError(problema);
  }
  const nivel = (x) => String(x ?? "").trim() === "" ? 0 : num(x);
  return {
    accion: "modificar",
    ticket: p.ticket,
    sl: cambio.sl !== undefined ? nivel(cambio.sl) : p.sl ?? 0,
    tp: cambio.tp !== undefined ? nivel(cambio.tp) : p.tp ?? 0,
    ...(esPendiente(p) ? { precio: cambio.precio !== undefined ? num(cambio.precio) : p.entrada } : {}),
  };
}

/** Precio de un SL o TP a partir de lo que se escribio (precio o pips). */
export function nivelDe(campo, entrada, pip, compra, esSl) {
  if (campo.modo === "precio") return num(campo.valor);
  const pips = num(campo.valor);
  if (!ok(pips) || !ok(entrada)) return NaN;
  const haciaArriba = compra ? !esSl : esSl;
  return entrada + (haciaArriba ? 1 : -1) * pips * pip;
}

/** Una orden nueva de MT5 con lo que se escribio (como en Operar y en la compra
 *  rapida del grafico): la entrada, el SL y el TP, el volumen (el escrito, o el que
 *  hace que el SL cueste el riesgo en USD), lo que se arriesga y se gana, y los
 *  errores que impiden mandarla (incluido el limite de la cuenta de fondeo). */
export function calcularOrden({ info, broker, tipo, compra, precioLim, sl, tp, vol, riesgo }) {
  if (!info) return null;
  const entrada = tipo === "mercado" ? (compra ? info.ask : info.bid) : num(precioLim);
  const slP = nivelDe(sl, entrada, info.pip, compra, true);
  const tpP = nivelDe(tp, entrada, info.pip, compra, false);
  const dSl = ok(slP) && ok(entrada) ? Math.abs(entrada - slP) : NaN;
  const dTp = ok(tpP) && ok(entrada) ? Math.abs(tpP - entrada) : NaN;
  // Volumen: el escrito, o el que hace que el SL cueste el riesgo en USD.
  let v = num(vol);
  if (ok(num(riesgo)) && ok(dSl) && info.por_punto) {
    const paso = info.volume_step || 0.01;
    v = Math.floor(num(riesgo) / (dSl * info.por_punto) / paso + 1e-9) * paso;
    v = Number(v.toFixed(decimalesPaso(paso)));
  }
  const usd = (d) => (ok(d) && ok(v) && info.por_punto ? d * info.por_punto * v : NaN);
  const errores = [];
  for (const [valor, nombre] of [[sl.valor, "el SL"], [tp.valor, "el TP"], [riesgo, "el riesgo"]]) {
    const problema = problemaNumero(valor, nombre, { cero: nombre !== "el riesgo" });
    if (problema) errores.push(problema);
  }
  if (num(sl.valor) > 0 && !ok(slP)) errores.push("Revisa el SL: el precio resultante debe ser mayor a cero");
  if (num(tp.valor) > 0 && !ok(tpP)) errores.push("Revisa el TP: el precio resultante debe ser mayor a cero");
  // La cuenta de fondeo: si toca el SL, no puede pasar el limite (con todo lo abierto en su SL).
  const cuenta = broker?.riesgo;
  const slUsd = usd(dSl);
  const quedan = cuenta && cuenta.siTocaSl !== null && cuenta.sinSl === 0 && ok(slUsd) ? cuenta.siTocaSl - slUsd : NaN;
  if (!ok(entrada)) errores.push(tipo === "limite" ? "Pon el precio de la orden límite" : "Sin cotización del broker");
  else if (tipo === "limite" && (compra ? entrada >= info.ask : entrada <= info.bid)) errores.push(compra ? "La compra límite va debajo del ask" : "La venta límite va arriba del bid");
  if (!ok(v)) errores.push("Pon el volumen (o el riesgo en USD con el SL)");
  else if (v < (info.volume_min ?? 0) - 1e-9) errores.push(`El volumen mínimo es ${info.volume_min}`);
  if (broker?.operador?.sl_obligatorio && !ok(slP)) errores.push("Falta el stop loss");
  if (ok(slP) && ok(entrada) && (compra ? slP >= entrada : slP <= entrada)) errores.push(compra ? "El SL va debajo de la entrada" : "El SL va arriba de la entrada");
  if (ok(tpP) && ok(entrada) && (compra ? tpP <= entrada : tpP >= entrada)) errores.push(compra ? "El TP va arriba de la entrada" : "El TP va debajo de la entrada");
  if (Number.isFinite(quedan) && quedan < 0) {
    errores.push(`Riesgo excedido: si toca el SL pierdes ${fmtNum(slUsd, 2)} y la cuenta tiene ${fmtNum(cuenta.siTocaSl, 2)} hasta su límite. Baja el volumen o acerca el SL.`);
  }
  return {
    quedan, cuenta,
    entrada, slP, tpP, v,
    sl: { pips: dSl / info.pip, usd: usd(dSl), dist: dSl },
    tp: { pips: dTp / info.pip, usd: usd(dTp), dist: dTp },
    rr: ok(dSl) && ok(dTp) ? dTp / dSl : NaN,
    pipUsd: ok(v) && info.por_punto ? info.pip * info.por_punto * v : NaN,
    margen: ok(v) && info.margin_per_lot ? info.margin_per_lot * v : NaN,
    pctEquity: ok(dSl) && broker?.equity ? usd(dSl) / broker.equity * 100 : NaN,
    errores,
  };
}
