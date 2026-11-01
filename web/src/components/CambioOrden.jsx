import { useEffect, useState } from "react";
import { fmt, fmtNum } from "../lib/format.js";
import { mercadoCerrado } from "../lib/horario.js";
import {
  decVol, destino, enviar, enviarBinance, esPendiente, faltaParaOperar, nombreOperacion, ok, pedidoModificar, problemaCambio, resultadoEn,
} from "../lib/operativa.js";

const signo = (x) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), 2)}`;
const NOMBRE = { sl: "el SL", tp: "el TP", precio: "el precio" };

/** Escape cierra sin mandar; hecho, se ve el resultado un momento y se cierra. */
function useCierre(onCerrar, resultado) {
  useEffect(() => {
    const tecla = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCerrar(false);
    };
    window.addEventListener("keydown", tecla, true);
    return () => window.removeEventListener("keydown", tecla, true);
  }, [onCerrar]);
  useEffect(() => {
    if (!resultado?.ok) return undefined;
    const t = setTimeout(() => onCerrar(true), 1600);
    return () => clearTimeout(t);
  }, [resultado, onCerrar]);
}

/** Confirmacion de un SL o TP de Binance movido en el grafico. Nada sale sin el
 *  click en Confirmar. */
export function CambioBinance({ cambio, binance, alto, onCerrar }) {
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  useCierre(onCerrar, resultado);
  const it = cambio.item;
  // La posicion como esta ahora: pudo cerrarse mientras se arrastraba.
  const p = binance?.posiciones?.find((x) => x.simbolo === it.simbolo && x.lado === it.lado);
  const { campo } = cambio;
  const dec = Math.min(8, String(it.entrada).split(".")[1]?.length ?? 2);
  const hasta = Number.isFinite(cambio.hasta) ? Number(cambio.hasta.toFixed(Math.max(1, dec))) : NaN;
  const compra = it.lado === "buy";
  const usdt = (nivel) => (compra ? 1 : -1) * (nivel - it.entrada) * it.cantidad;
  const problema = !p ? "Esa posición ya no está abierta"
    : !ok(hasta) ? "Revisa el precio: debe ser un número mayor a cero"
    : campo === "sl" && (compra ? hasta >= p.marca : hasta <= p.marca) ? `El SL de una ${compra ? "compra va debajo" : "venta va arriba"} del precio de marca`
    : campo === "tp" && (compra ? hasta <= p.marca : hasta >= p.marca) ? `El TP de una ${compra ? "compra va arriba" : "venta va debajo"} del precio de marca`
    : null;
  const falta = !binance?.disponible ? binance?.motivo ?? "La cuenta de Binance no responde"
    : !binance.trading ? "La operativa de Binance está apagada (BINANCE_TRADING=false)" : null;
  const mandar = async () => {
    if (problema || falta || enviando) return;
    setEnviando(true);
    const r = await enviarBinance({ accion: "niveles", symbol: it.simbolo, lado: it.lado, [campo]: hasta });
    setEnviando(false);
    setResultado(r);
  };
  const top = Math.max(8, Math.min((alto ?? 400) - 170, cambio.y > 175 ? cambio.y - 165 : cambio.y + 18));
  return (
    <div className={`cambio-orden ${campo}`} style={{ top }} role="dialog" aria-label="Confirmar cambio en Binance">
      <b>Mover {NOMBRE[campo]} · Binance · {compra ? "compra" : "venta"} {fmtNum(it.cantidad, decVol(it.cantidad))} {it.simbolo}</b>
      <span className="cambio-precios">
        {ok(cambio.desde) ? fmt(cambio.desde, dec) : `sin ${campo.toUpperCase()}`} → <b>{fmt(hasta, dec)}</b>
      </span>
      <span>
        Si toca <b className={usdt(hasta) >= 0 ? "pos" : "neg"}>{signo(usdt(hasta))} USDT</b>
        {ok(cambio.desde) && <span className="tenue"> (antes {signo(usdt(cambio.desde))})</span>}
      </span>
      {campo === "sl" && usdt(hasta) >= 0 && <span className="pos">El stop queda en ganancia: asegura ese resultado.</span>}
      {problema && <span className="op-error">{problema}</span>}
      {!problema && falta && <span className="op-error">Para mandarlo: {falta}</span>}
      {resultado && (
        <span className={`op-resultado ${resultado.ok ? "pos" : "neg"}`}>
          {resultado.ok ? "✓ " : "✗ "}{resultado.mensaje}{resultado.aviso ? ` · ${resultado.aviso}` : ""}
        </span>
      )}
      <span className="op-acciones">
        {!resultado?.ok && (
          <button className="boton-orden confirmar" disabled={Boolean(problema || falta) || enviando} onClick={mandar}>
            {enviando ? "Enviando a Binance…" : "Confirmar"}
          </button>
        )}
        <button className="tenue" onClick={() => onCerrar(Boolean(resultado?.ok))}>{resultado?.ok ? "Listo" : "Cancelar"}</button>
      </span>
    </div>
  );
}

/** Confirmacion de un SL, TP o precio movido en el grafico. Nada sale para MT5
 *  sin el click en Confirmar; Escape o Cancelar lo dejan como estaba. */
export default function CambioOrden({ cambio, broker, alto, onCerrar }) {
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  useCierre(onCerrar, resultado);

  // La operacion como esta ahora: pudo cerrarse o cambiar mientras se arrastraba.
  const p = [...(broker?.posiciones ?? []), ...(broker?.ordenes ?? [])].find((x) => x.ticket === cambio.ticket);
  const moneda = broker?.cuenta?.moneda ?? "USD";
  const dig = p?.digitos ?? broker?.info?.digits ?? 2;
  const hasta = Number.isFinite(cambio.hasta) ? Number(cambio.hasta.toFixed(dig)) : NaN;
  const { campo } = cambio;
  const pedido = p && ok(hasta) ? pedidoModificar(p, { [campo]: hasta }) : null;
  const falta = faltaParaOperar(broker) ?? mercadoCerrado(p?.horario);
  const problema = !p ? "Esa operación ya no está abierta"
    : !ok(hasta) ? "Revisa el precio: debe ser un número mayor a cero"
    : campo === "sl" || campo === "tp" || campo === "precio" ? problemaCambio(p, { sl: pedido.sl, tp: pedido.tp, precio: pedido.precio }, broker?.info) : null;
  // Lo que da si toca, antes y despues. En una pendiente se mide desde su precio (el nuevo, si se movio).
  const base = p && esPendiente(p) && campo === "precio" ? { ...p, entrada: hasta } : p;
  const despues = p && campo !== "precio" ? resultadoEn(base, hasta, broker?.info) : null;
  const antes = p && campo !== "precio" && ok(cambio.desde) ? resultadoEn(base, cambio.desde, broker?.info) : null;

  const mandar = async () => {
    if (!pedido || problema || falta || enviando) return;
    setEnviando(true);
    const r = await enviar(pedido);
    setEnviando(false);
    setResultado(r);
  };

  // Arriba de la linea movida (o abajo, si no entra): que se siga viendo donde quedo.
  const top = Math.max(8, Math.min((alto ?? 400) - 170, cambio.y > 175 ? cambio.y - 165 : cambio.y + 18));
  return (
    <div className={`cambio-orden ${campo}`} style={{ top }} role="dialog" aria-label="Confirmar cambio">
      <b>Mover {NOMBRE[campo]} · {p ? `${nombreOperacion(p)} ${fmtNum(p.volumen, decVol(p, broker?.info))} ${p.simbolo}` : `ticket ${cambio.ticket}`}</b>
      <span className="cambio-precios">
        {ok(cambio.desde) ? fmt(cambio.desde, dig) : `sin ${campo.toUpperCase()}`} → <b>{fmt(hasta, dig)}</b>
      </span>
      {despues && Number.isFinite(despues.usd) && (
        <span>
          Si toca <b className={despues.usd >= 0 ? "pos" : "neg"}>{signo(despues.usd)} {moneda}</b>
          {Number.isFinite(despues.pips) && <> · {fmtNum(despues.pips, 1)} pips de la entrada</>}
          {antes && Number.isFinite(antes.usd) && <span className="tenue"> (antes {signo(antes.usd)})</span>}
        </span>
      )}
      {campo === "sl" && despues?.usd >= 0 && <span className="pos">El stop queda en ganancia: asegura ese resultado.</span>}
      {problema && <span className="op-error">{problema}</span>}
      {!problema && falta && <span className="op-error">Para mandarlo: {falta}</span>}
      {resultado ? (
        <span className={`op-resultado ${resultado.ok ? "pos" : "neg"}`}>{resultado.ok ? "✓ " : "✗ "}{resultado.mensaje}</span>
      ) : null}
      <span className="op-acciones">
        {!resultado?.ok && (
          <button className="boton-orden confirmar" disabled={Boolean(problema || falta) || enviando} onClick={mandar}>
            {enviando ? `Enviando a ${destino(broker)}…` : "Confirmar"}
          </button>
        )}
        <button className="tenue" onClick={() => onCerrar(Boolean(resultado?.ok))}>{resultado?.ok ? "Listo" : "Cancelar"}</button>
      </span>
    </div>
  );
}
