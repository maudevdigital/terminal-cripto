import { fmt, fmtNum } from "../lib/format.js";
import Icon from "./Icon.jsx";

/** Cuanto del limite se uso: hasta la mitad tranquilo, despues cuidado, y desde
 *  el 80 % al borde. El numero siempre se ve: el color solo acompana. */
export const nivelRiesgo = (pct) => (pct >= 80 ? "limite" : pct >= 50 ? "cuidado" : "ok");

export const hora = (ms) => new Date(ms).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Cabina de riesgo de la cuenta de fondeo: perdida del dia y maxima contra sus
 *  limites, lo que queda disponible y lo que quedaria si todo toca su SL. */
export function CabinaRiesgo({ riesgo: r, moneda = "USD" }) {
  if (!r) return null;
  const aprox = r.exacto ? "" : " (aproximado: reiniciá MT5 para que el puente exporte el historial)";
  const medidor = (titulo, l, ayuda) => l && (
    <span className={`riesgo-limite ${nivelRiesgo(l.pct)}`} title={ayuda}>
      <span className="tenue">{titulo}</span>
      <b>{l.usado > 0 ? "−" : ""}{fmtNum(l.usado, 0)} / {fmtNum(l.limite, 0)}</b>
      <span className="medidor" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, l.pct))}%` }} /></span>
    </span>
  );
  return (
    <div className="cabina-riesgo">
      {medidor("Hoy", r.diaria,
        `Pérdida del día: ${fmtNum(r.diaria?.usado, 2)} de ${fmtNum(r.diaria?.limite, 2)} ${moneda} (${fmtNum(r.diaria?.pct, 1)} %).\n`
        + `La equity no puede bajar de ${fmt(r.diaria?.piso, 2)} hoy. El día de la firma corta a las ${hora(r.proximoCorte)}.${aprox}`)}
      {medidor("Máxima", r.maxima,
        `Pérdida máxima: ${fmtNum(r.maxima?.usado, 2)} de ${fmtNum(r.maxima?.limite, 2)} ${moneda} desde el balance inicial `
        + `(${fmtNum(r.inicial, 2)}). La equity no puede bajar de ${fmt(r.maxima?.piso, 2)}.`)}
      {r.disponible !== null && (
        <span className="riesgo-disp" title="Lo que podés perder antes de tocar el primer límite (diario o máximo)">
          <span className="tenue">Disponible</span> <b>{fmtNum(r.disponible, 0)} {moneda}</b>
        </span>
      )}
      {r.sinSl > 0 ? (
        <span className="riesgo-aviso" title="Una posición sin stop loss no tiene pérdida máxima: el límite de la cuenta queda expuesto">
          <Icon name="alert" size={12} /> {r.sinSl === 1 ? "1 posición sin SL" : `${r.sinSl} posiciones sin SL`}
        </span>
      ) : r.abierto > 0 && (
        <span className="tenue" title="Lo que quedaría disponible si todas las posiciones abiertas tocan su stop loss">
          si todo toca SL: <b className="texto">{fmtNum(r.siTocaSl, 0)}</b>
        </span>
      )}
    </div>
  );
}
