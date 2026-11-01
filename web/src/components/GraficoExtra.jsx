import { useCallback, useMemo, useRef } from "react";
import Grafico from "./Grafico.jsx";
import { useMarket } from "../hooks/useMarket.js";
import { armarGrafico } from "../lib/graficoVelas.js";

const nada = () => {};

/** Un grafico extra de la grilla (varios graficos): su mercado y su
 *  temporalidad, con su propia conexion en vivo y su historia hacia atras. Comparte
 *  las capas, los perfiles y los FVG con el principal; va compacto (sin barra de
 *  dibujo ni rangos) y recibe los atajos solo cuando es el activo. */
export default function GraficoExtra({ cfg, panel, onPanel, activo, capas, vp, zonas, presentacion, onBuscar, engineRef, ajustes, onHerramientaActiva }) {
  const view = useMemo(() => ({ symbol: panel.symbol, interval: panel.interval }), [panel.symbol, panel.interval]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const onPayload = useCallback((p) => engineRef.current?.handlePayload(p), []);
  const { payload, aviso } = useMarket({ view, onPayload });

  // Las velas anteriores al llegar al borde izquierdo (como en el principal).
  const masHistoria = useCallback(async (antes) => {
    const engine = engineRef.current;
    if (!engine) return;
    const { symbol: s, interval: i } = viewRef.current;
    const n = ["1m", "5m", "15m"].includes(i) ? 6000 : 2000;
    const r = await fetch(`/api/velas?symbol=${encodeURIComponent(s)}&interval=${i}&antes=${antes}&n=${n}`).then((x) => x.json()).catch(() => null);
    if (!r?.ok || engine.symbol !== s || engine.interval !== i || engine.velas[0]?.time !== antes) return;
    engine.anteponer(r.velas, r.hayMas, (serie) => armarGrafico(serie, cfg));
  }, [cfg]);

  return (
    <Grafico cfg={cfg} interval={panel.interval} onInterval={(i) => onPanel({ interval: i })} capas={capas} onCapa={nada}
             vp={vp} onVp={nada} zonas={zonas} onZonas={nada} completo={false} onCompleto={nada}
             engineRef={engineRef} payload={payload} symbol={panel.symbol} aviso={aviso} onSymbol={(s) => onPanel({ symbol: s })}
             onMasHistoria={masHistoria} presentacion={presentacion} onPresentacion={nada} onHistorial={nada} onCalendario={nada}
             replay={null} onReplay={null} barraReplay={null} conRail compacto activo={activo} onBuscar={onBuscar}
             ajustes={ajustes} onHerramientaActiva={onHerramientaActiva} />
  );
}
