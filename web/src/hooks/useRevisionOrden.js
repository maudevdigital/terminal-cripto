import { useEffect, useRef, useState } from "react";

const EVENTO = "terminal-cripto:revision-orden";
const clave = (destino) => `terminal-cripto:revision-orden:${destino}`;
const leer = (destino) => {
  try {
    const r = JSON.parse(sessionStorage.getItem(clave(destino)) || "null");
    return typeof r?.mensaje === "string" ? r : null;
  } catch { return null; }
};

/** Un resultado incierto no se reenvía al cambiar de panel o recargar la pestaña. */
export default function useRevisionOrden(destino) {
  const [revision, setRevision] = useState(() => leer(destino));
  const actual = useRef(revision);
  useEffect(() => {
    const alCambiar = (e) => {
      if (e.detail?.destino !== destino) return;
      actual.current = e.detail.revision;
      setRevision(e.detail.revision);
    };
    window.addEventListener(EVENTO, alCambiar);
    return () => window.removeEventListener(EVENTO, alCambiar);
  }, [destino]);
  const guardar = (r) => {
    actual.current = r;
    setRevision(r);
    try {
      if (r) sessionStorage.setItem(clave(destino), JSON.stringify(r));
      else sessionStorage.removeItem(clave(destino));
    } catch { /* se mantiene el bloqueo en memoria */ }
    window.dispatchEvent(new CustomEvent(EVENTO, { detail: { destino, revision: r } }));
  };
  return {
    revision,
    requiereRevision: () => Boolean(actual.current),
    marcarRevision: (r) => {
      if (r?.estado === "sin_respuesta" || r?.estado === "proteccion_incompleta" || r?.ejecutada && !r.ok) guardar(r);
    },
    confirmarRevision: () => guardar(null),
  };
}
