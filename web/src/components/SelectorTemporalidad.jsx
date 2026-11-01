import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { aceptable, etiqueta, leer, segundos } from "../lib/temporalidades.js";

// Las temporalidades de siempre, agrupadas.
const GRUPOS = [["Minutos", ["1m", "5m", "15m", "30m"]], ["Horas", ["1h", "4h"]], ["Días y más", ["1d", "1w", "1M"]]];

/** La temporalidad en un menu: agrupada, por teclado y a medida.
 *  Escribir un numero sobre el grafico lo abre con ese numero. Se puede escribir
 *  cualquiera (3m, 10m, 2h, 12h, 2d...): Enter la grafica y Shift+Enter ademas la
 *  fija en la barra. La estrella de cada una la fija o la saca; las fijas a medida
 *  quedan en "Personalizadas". */
export default function SelectorTemporalidad({ intervals, interval, onInterval, habilitado = () => true, atajos = true, fijas = [], onFijas }) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [sel, setSel] = useState(0);
  const caja = useRef(null), entrada = useRef(null);
  const propias = fijas.filter((i) => !intervals.includes(i)).sort((a, b) => segundos(a) - segundos(b));
  const grupos = useMemo(() => [
    ...GRUPOS.map(([g, xs]) => [g, xs.filter((i) => intervals.includes(i))]),
    ["Personalizadas", propias],
  ].filter(([, xs]) => xs.length), [intervals, propias.join()]);   // eslint-disable-line react-hooks/exhaustive-deps
  const plana = grupos.flatMap(([, xs]) => xs);
  const escrito = leer(texto);
  const valido = escrito && aceptable(escrito, intervals) && habilitado(escrito) ? escrito : null;

  const abrir = (inicial = "") => {
    setTexto(inicial);
    setSel(Math.max(0, plana.indexOf(interval)));
    setAbierto(true);
  };
  const fijar = (i, si) => onFijas?.(si ? [...new Set([...fijas, i])] : fijas.filter((x) => x !== i));
  const elegir = (i, conFijar = false) => {
    if (i && habilitado(i)) {
      onInterval(i);
      if (conFijar) fijar(i, true);
    }
    setAbierto(false);
  };

  // Un numero sobre el grafico abre el menu con ese numero (como en TradingView).
  useEffect(() => {
    const tecla = (e) => {
      if (!atajos || abierto || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); abrir(e.key); }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  });
  useEffect(() => {
    if (!abierto) return;
    entrada.current?.focus();
    const fuera = (e) => { if (!caja.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener("pointerdown", fuera);
    return () => window.removeEventListener("pointerdown", fuera);
  }, [abierto]);

  const teclaMenu = (e) => {
    if (e.key === "Escape") { e.preventDefault(); setAbierto(false); }
    else if (e.key === "Enter") { e.preventDefault(); elegir(texto ? valido : plana[sel], e.shiftKey); }
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setTexto(""); setSel((s) => Math.min(plana.length - 1, s + 1)); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setTexto(""); setSel((s) => Math.max(0, s - 1)); }
  };

  return (
    <div className="relative" ref={caja}>
      <button onClick={() => (abierto ? setAbierto(false) : abrir())} aria-expanded={abierto}
              data-tip="Temporalidad" data-atajo="0-9"
              className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-[13px] font-semibold text-texto hover:bg-hover">
        {etiqueta(interval)}
        <Icon name="chevron" size={11} className={`transition-transform ${abierto ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {abierto && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-40 w-[320px] animate-entra rounded-[10px] border border-borde bg-vidrio shadow-desk"
             onKeyDown={teclaMenu}>
          <div className="flex items-center gap-2 border-b border-borde px-3 py-2.5">
            <Icon name="historial" size={14} className="text-apagado" />
            <input ref={entrada} value={texto} onChange={(e) => setTexto(e.target.value)} spellCheck={false}
                   placeholder="Cualquier temporalidad: 3m, 10m, 2h, 2d…"
                   className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[13px] text-texto outline-none placeholder:text-apagado" />
            {texto && (
              <span className={`text-[11px] ${valido ? "text-tenue" : "text-baja"}`}>{valido ? `↵ ${etiqueta(valido)}` : "no disponible"}</span>
            )}
          </div>
          <div className="px-3 pt-1 pb-2">
            {grupos.map(([g, xs]) => (
              <div key={g}>
                <h4 className="m-0 pt-2.5 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] text-apagado uppercase">{g}</h4>
                <div className="grid grid-cols-4 gap-1.5">
                  {xs.map((i) => {
                    const k = plana.indexOf(i);
                    const marcado = texto ? i === valido : k === sel;
                    const fija = fijas.includes(i);
                    return (
                      <div key={i} className="group relative">
                        <button disabled={!habilitado(i)} onClick={() => elegir(i)} onMouseEnter={() => { if (!texto) setSel(k); }}
                                className={`h-8 w-full cursor-pointer rounded-md border text-[12.5px] font-semibold disabled:cursor-default disabled:opacity-35
                                            ${i === interval ? "border-borde bg-panel-3 text-texto" : "border-linea bg-panel-2 text-tenue"}
                                            ${marcado ? "ring-1 ring-tenue" : ""} hover:text-texto`}>
                          {etiqueta(i)}
                        </button>
                        {onFijas && (
                          <button onClick={() => fijar(i, !fija)} aria-label={fija ? `Sacar ${etiqueta(i)} de la barra` : `Fijar ${etiqueta(i)} en la barra`}
                                  title={fija ? "Sacar de la barra" : "Fijar en la barra"}
                                  className={`absolute -top-1 -right-1 grid size-4 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0
                                              ${fija ? "text-aviso" : "text-apagado opacity-0 group-hover:opacity-100 hover:text-texto"}`}>
                            <Icon name={fija ? "estrellaLlena" : "estrella"} size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-borde px-3 py-2 text-[11px] text-apagado">
            <span><kbd className="font-mono">↵</kbd> graficar</span>
            {onFijas && <span><kbd className="font-mono">⇧↵</kbd> graficar y fijar</span>}
            <span><kbd className="font-mono">↑↓</kbd> mover</span>
            <span><kbd className="font-mono">Esc</kbd> cerrar</span>
          </div>
        </div>
      )}
    </div>
  );
}
