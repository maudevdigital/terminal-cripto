import { useState } from "react";

const HORA = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const BOTON = "cursor-pointer rounded-md border border-borde bg-panel-2 px-2.5 py-1.5 text-[12px] text-texto hover:bg-panel-3 disabled:cursor-default disabled:opacity-50";

/** La pausa de la cuenta real: ponerla es inmediato y quitarla tarda (src/freno.ts). */
export default function PausaReal({ pausa }) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  if (!pausa) return null;
  const pedir = async (accion) => {
    setEnviando(true);
    setError(null);
    try {
      const r = await fetch("/api/pausa", { method: "POST", headers: { "content-type": "application/json", "x-terminal": "operativa" }, body: JSON.stringify({ accion }) });
      if (!r.ok) setError("No se pudo cambiar la pausa.");
    } catch {
      setError("No se pudo hablar con el servidor.");
    }
    setEnviando(false);
  };
  return (
    <div className="flex flex-col gap-1.5 text-[11.5px] text-tenue">
      {!pausa.activa ? (
        <button className={BOTON} disabled={enviando} onClick={() => pedir("poner")}
                title="No se abre nada real, tampoco directo en MT5: lo que abras ahí se cancela o se cierra. Lo que ya está abierto no se toca.">
          Pausar cuenta real
        </button>
      ) : pausa.quitarEn ? (
        <>
          <span>La pausa se quita a las <b className="text-texto">{HORA.format(new Date(pausa.quitarEn))}</b>.</span>
          <button className={BOTON} disabled={enviando} onClick={() => pedir("seguir")}>Seguir en pausa</button>
        </>
      ) : (
        <button className={BOTON} disabled={enviando} onClick={() => pedir("quitar")}>
          {pausa.esperaMin > 0 ? `Quitar la pausa (tarda ${pausa.esperaMin} min)` : "Quitar la pausa"}
        </button>
      )}
      {error && <span className="text-baja">{error}</span>}
    </div>
  );
}
