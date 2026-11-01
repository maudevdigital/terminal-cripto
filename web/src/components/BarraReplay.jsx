import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";

const CHILE = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const NY = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });
const VELOCIDADES = [0.5, 1, 2, 5, 10];

/** Un instante (s) como valor de <input type="datetime-local"> en la hora local. */
function aLocal(t) {
  const d = new Date(t * 1000);
  const dos = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

/** Controles del replay: elegir desde donde (un click en el grafico o fecha y
 *  hora), reproducir, avanzar una vela, la velocidad y salir. */
export default function BarraReplay({ rp, rango, onElegir, onIr, onPlay, onPaso, onVelocidad, onSalir }) {
  const [fecha, setFecha] = useState("");
  // Al entrar, la fecha propuesta es el instante del replay (o el final de la historia).
  useEffect(() => {
    const t = rp.cursor ?? rango?.hasta;
    if (t && !fecha) setFecha(aLocal(t));
  }, [rp.cursor, rango, fecha]);

  if (rp.estado === "cargando") return <div className="barra-replay"><span className="tenue">Cargando la historia de FTMO para el replay…</span></div>;
  if (rp.estado === "error") {
    return (
      <div className="barra-replay">
        <span className="neg">{rp.error}</span>
        <button onClick={onSalir}><Icon name="x" size={13} /> Cerrar</button>
      </div>
    );
  }
  const ir = () => {
    const t = new Date(fecha).getTime() / 1000;
    if (Number.isFinite(t)) onIr(t);
  };
  const min = rango ? aLocal(rango.desde) : undefined, max = rango ? aLocal(rango.hasta) : undefined;
  return (
    <div className={`barra-replay ${rp.estado}`}>
      <b className="replay-marca"><Icon name="replay" size={14} /> Replay</b>
      {rp.estado === "elegir" ? (
        <span className="tenue">{rp.eligiendo ? "Haz click en la vela desde donde quieres empezar" : "Elige desde dónde empezar"}</span>
      ) : (
        <>
          <button className="replay-play" onClick={onPlay} disabled={rp.alFinal} title={rp.play ? "Pausa (espacio)" : "Reproducir (espacio)"}>
            <Icon name={rp.play ? "pausa" : "play"} size={14} />
          </button>
          <button onClick={onPaso} disabled={rp.alFinal || rp.play} title="Avanzar una vela (→)">
            <Icon name="avanzar" size={14} />
          </button>
          <select value={rp.velocidad} onChange={(e) => onVelocidad(Number(e.target.value))} title="Velas por segundo">
            {VELOCIDADES.map((v) => <option key={v} value={v}>{String(v).replace(".", ",")}×</option>)}
          </select>
          <span className="replay-hora" title="Hora de Chile · Nueva York">
            {CHILE.format(rp.cursor * 1000)} <span className="tenue">· NY {NY.format(rp.cursor * 1000)}</span>
          </span>
          {rp.alFinal && <span className="tenue">Fin de la historia</span>}
        </>
      )}
      <span className="replay-ir">
        <input type="datetime-local" value={fecha} min={min} max={max} onChange={(e) => setFecha(e.target.value)} />
        <button onClick={ir} title="Empezar el replay en esa fecha y hora (de Chile)">Ir</button>
        <button className={rp.eligiendo ? "activo" : ""} onClick={onElegir} title="Elegir la vela con un click en el gráfico">
          Elegir en el gráfico
        </button>
      </span>
      <button className="replay-salir" onClick={onSalir} title="Volver al precio en vivo"><Icon name="x" size={13} /> Salir</button>
    </div>
  );
}
