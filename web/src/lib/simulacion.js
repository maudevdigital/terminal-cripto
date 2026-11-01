/* Operaciones simuladas del backtest manual. Se llenan y se cierran con las velas
   de 1 minuto que va revelando el replay (de 5 minutos antes de esa historia; `d`
   es la duracion de cada una). En una vela que
   toca el SL y el TP, cuenta el SL (lo peor). Sin spread ni comisiones. */

const nuevoId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Lotes para arriesgar `riesgoUsd` con el SL a `puntos` (pasos de 0,01). */
export function lotesPara(riesgoUsd, puntos, valorPunto) {
  if (!(riesgoUsd > 0) || !(puntos > 0) || !(valorPunto > 0)) return 0;
  return Math.floor((riesgoUsd / (puntos * valorPunto)) * 100 + 1e-9) / 100;
}

/** Una operacion nueva. A mercado entra al cierre de la ultima vela del replay. */
export function nuevaOperacion({ lado, tipo, entrada, sl, tp, riesgoUsd, valorPunto, cursor, simbolo, sesion, variable = null }) {
  const puntos = Math.abs(entrada - sl);
  const lotes = lotesPara(riesgoUsd, puntos, valorPunto);
  const mercado = tipo === "mercado";
  return {
    id: nuevoId(), simbolo, sesion, lado, tipo, variable,
    entrada, sl, slInicial: sl, tp, lotes, valorPunto,
    riesgoUsd: lotes * puntos * valorPunto,
    creada: cursor, estado: mercado ? "abierta" : "pendiente", entro: mercado ? cursor : null,
    salida: null, cerrada: null, final: null, r: null, usd: null,
  };
}

/** Si una orden tiene sentido: el SL del lado del riesgo y el TP del otro. */
export function validar({ lado, entrada, sl, tp }) {
  if (![entrada, sl].every((x) => Number.isFinite(x) && x > 0)) return "Falta la entrada o el SL.";
  if (lado === 1 ? sl >= entrada : sl <= entrada) return `El SL tiene que ir ${lado === 1 ? "bajo" : "sobre"} la entrada.`;
  if (Number.isFinite(tp) && tp > 0 && (lado === 1 ? tp <= entrada : tp >= entrada)) return `El TP tiene que ir ${lado === 1 ? "sobre" : "bajo"} la entrada.`;
  return null;
}

function cerrar(op, precio, t, motivo) {
  const riesgoPts = Math.abs(op.entrada - op.slInicial);
  const mov = (precio - op.entrada) * op.lado;
  const final = motivo === "sl" && Math.abs(precio - op.entrada) < 1e-9 ? "be" : motivo;
  return {
    ...op, estado: "cerrada", salida: precio, cerrada: t, final,
    r: riesgoPts > 0 ? mov / riesgoPts : 0, usd: op.lotes * op.valorPunto * mov,
  };
}

/** Pasa las velas nuevas de 1 minuto por las operaciones vivas. Devuelve la misma
 *  lista si nada cambio. */
export function avanzarOperaciones(ops, velas) {
  if (!velas.length || !ops.some((o) => o.estado !== "cerrada" && o.estado !== "cancelada")) return ops;
  let cambio = false;
  const out = ops.map((op0) => {
    let op = op0;
    if (op.estado === "cerrada" || op.estado === "cancelada") return op;
    for (const v of velas) {
      if (v.t < op.creada) continue;
      if (op.estado === "pendiente") {
        const toca = op.lado === 1 ? v.l <= op.entrada : v.h >= op.entrada;
        if (!toca) continue;
        op = { ...op, estado: "abierta", entro: v.t };
      }
      // Primero el SL (con un salto, al precio de apertura de la vela), despues el TP.
      const tocaSl = op.lado === 1 ? v.l <= op.sl : v.h >= op.sl;
      if (tocaSl) {
        const gap = op.lado === 1 ? v.o < op.sl : v.o > op.sl;
        op = cerrar(op, gap && op.entro !== v.t ? v.o : op.sl, v.t + (v.d ?? 60), "sl");
        break;
      }
      if (Number.isFinite(op.tp) && op.tp > 0 && (op.lado === 1 ? v.h >= op.tp : v.l <= op.tp)) {
        op = cerrar(op, op.tp, v.t + (v.d ?? 60), "tp");
        break;
      }
    }
    if (op !== op0) cambio = true;
    return op;
  });
  return cambio ? out : ops;
}

/** Cerrar a mano al precio del replay. */
export function cerrarAMano(op, precio, cursor) {
  return op.estado === "abierta" ? cerrar(op, precio, cursor, "manual") : { ...op, estado: "cancelada", cerrada: cursor };
}

/** Lo que va ganando o perdiendo una abierta al precio del replay. */
export function flotante(op, precio) {
  if (op.estado !== "abierta" || !Number.isFinite(precio)) return null;
  const riesgoPts = Math.abs(op.entrada - op.slInicial);
  const mov = (precio - op.entrada) * op.lado;
  return { r: riesgoPts > 0 ? mov / riesgoPts : 0, usd: op.lotes * op.valorPunto * mov };
}

/** Lo que suman las cerradas: aciertos, R, dinero, factor de ganancia y caida maxima. */
export function resumen(ops) {
  const c = ops.filter((o) => o.estado === "cerrada").sort((a, b) => a.cerrada - b.cerrada);
  let acum = 0, pico = 0, caida = 0;
  for (const o of c) { acum += o.r; pico = Math.max(pico, acum); caida = Math.min(caida, acum - pico); }
  const ganan = c.filter((o) => o.r > 0.01), pierden = c.filter((o) => o.r < -0.01);
  const sumG = ganan.reduce((a, o) => a + o.usd, 0), sumP = pierden.reduce((a, o) => a + o.usd, 0);
  return {
    n: c.length, ganadas: ganan.length, perdidas: pierden.length, be: c.length - ganan.length - pierden.length,
    acierto: c.length ? ganan.length / c.length : 0,
    totalR: acum, totalUsd: c.reduce((a, o) => a + o.usd, 0), promedioR: c.length ? acum / c.length : 0,
    factor: sumP < 0 ? sumG / -sumP : null, caida,
    mejor: c.length ? Math.max(...c.map((o) => o.r)) : 0, peor: c.length ? Math.min(...c.map((o) => o.r)) : 0,
  };
}
