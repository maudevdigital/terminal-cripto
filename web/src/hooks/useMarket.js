import { useCallback, useEffect, useRef, useState } from "react";
import { crearConexionMercado } from "../lib/marketConnection.js";

/** Conexion con el backend: snapshot inicial por REST y despues el WebSocket.
 *  `onPayload` se llama antes de actualizar el estado de React, para que el
 *  motor del grafico aplique la data (y los decimales) antes del render. */
export function useMarket({ view, onPayload }) {
  const [payload, setPayload] = useState(null);
  const [aviso, setAviso] = useState("Cargando…"); // por que todavia no hay datos de esta vista
  const [conectado, setConectado] = useState(null);  // null = conectando
  const viewRef = useRef(view);
  viewRef.current = view;
  const conexionRef = useRef(null);
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  useEffect(() => {
    const conexion = crearConexionMercado({
      view: viewRef.current,
      onPayload: (p) => {
        const v = viewRef.current;
        if (p.symbol !== v.symbol || p.interval !== v.interval) return;
        onPayloadRef.current?.(p);
        setPayload(p);
      },
      onAviso: setAviso,
      onConexion: setConectado,
    });
    conexionRef.current = conexion;
    return () => { conexion.cerrar(); conexionRef.current = null; };
  }, []);

  useEffect(() => { conexionRef.current?.cambiarVista(view); }, [view.symbol, view.interval]);
  const recargar = useCallback(() => conexionRef.current?.refrescar(), []);

  const actual = payload?.symbol === view.symbol && payload?.interval === view.interval ? payload : null;
  return { payload: actual, conectado, aviso: actual ? aviso : aviso || "Cargando…", recargar };
}
