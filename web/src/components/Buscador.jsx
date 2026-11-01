import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { fmtNum } from "../lib/format.js";
import { TIPO, TONO, decimales } from "../lib/mercados.jsx";

// Las pestanas: todos o un tipo de mercado.
const PESTANAS = [["todos", "Todos"], ["indice", "Índices"], ["cripto", "Cripto"], ["materia", "Materias primas"], ["contexto", "Contexto"]];

const sinTildes = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** El buscador de mercados: se abre con la lupa o escribiendo una letra
 *  sobre el grafico. Pestanas por tipo, la lista con ↑↓, Enter abre el grafico y Tab
 *  cambia de pestana; a la derecha, la ficha del marcado. */
export default function Buscador({ cfg, symbol, inicial, onSymbol, onCerrar }) {
  const [texto, setTexto] = useState(inicial ?? "");
  const [pestana, setPestana] = useState("todos");
  const [sel, setSel] = useState(0);
  const [datos, setDatos] = useState(null);
  const entrada = useRef(null), lista = useRef(null);

  useEffect(() => {
    entrada.current?.focus();
    const controlador = new AbortController();
    fetch("/api/lista", { signal: controlador.signal }).then((r) => r.json())
      .then((d) => { if (!controlador.signal.aborted) setDatos(Array.isArray(d) ? d : []); })
      .catch(() => { if (!controlador.signal.aborted) setDatos([]); });
    return () => controlador.abort();
  }, []);

  const mercados = useMemo(() => {
    const todos = [...(cfg.usdtd ? ["USDT.D"] : []), ...cfg.symbols];
    return todos.map((s) => {
      const m = cfg.mercados[s];
      const tipo = s === "USDT.D" ? "contexto" : m?.tipo ?? "cripto";
      const d = datos?.find((x) => x.symbol === s);
      return { s, nombre: s === "USDT.D" ? "Dominancia de USDT" : m?.nombre ?? s, fuente: s === "USDT.D" ? "CoinGecko" : m?.fuente ?? s, tipo, d };
    }).filter((x) => !datos || x.d?.last !== null);
  }, [cfg, datos]);

  const resultados = useMemo(() => {
    const q = sinTildes(texto.trim());
    const en = mercados.filter((x) => pestana === "todos" || x.tipo === pestana);
    if (!q) return en;
    const puntos = (x) => {
      const campos = [x.s, x.nombre, x.fuente].map(sinTildes);
      if (campos.some((c) => c.startsWith(q))) return 2;
      if (campos.some((c) => c.includes(q))) return 1;
      return 0;
    };
    return en.map((x) => [puntos(x), x]).filter(([p]) => p).sort((a, b) => b[0] - a[0]).map(([, x]) => x);
  }, [mercados, texto, pestana]);
  const pestanas = PESTANAS.filter(([id]) => id === "todos" || mercados.some((x) => x.tipo === id));
  const marcado = resultados[Math.min(sel, resultados.length - 1)] ?? null;

  useEffect(() => { setSel(0); }, [texto, pestana]);
  useEffect(() => { lista.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const abrir = (x) => { if (x) onSymbol(x.s); onCerrar(); };
  const tecla = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCerrar(); }
    else if (e.key === "Enter") { e.preventDefault(); abrir(marcado); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.max(0, Math.min(resultados.length - 1, s + 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const i = pestanas.findIndex(([id]) => id === pestana);
      setPestana(pestanas[(i + (e.shiftKey ? pestanas.length - 1 : 1)) % pestanas.length][0]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[8vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div role="dialog" aria-modal="true" aria-label="Buscar mercado" onKeyDown={tecla}
           className="flex max-h-[78vh] w-full max-w-[860px] animate-entra flex-col overflow-hidden rounded-xl border border-borde bg-panel shadow-desk">
        <div className="p-3 pb-0">
          <label className="flex h-11 items-center gap-2.5 rounded-lg border border-borde bg-fondo px-3 focus-within:border-tenue">
            <Icon name="buscar" size={15} className="text-tenue" />
            <input ref={entrada} value={texto} onChange={(e) => setTexto(e.target.value)} spellCheck={false} placeholder="Buscar mercado…"
                   className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[14px] text-texto uppercase outline-none placeholder:text-apagado placeholder:normal-case" />
            {texto && (
              <button onClick={() => { setTexto(""); entrada.current?.focus(); }} aria-label="Borrar"
                      className="grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent text-tenue hover:bg-hover hover:text-texto">
                <Icon name="x" size={13} />
              </button>
            )}
          </label>
          <div className="mt-2 flex gap-1 border-b border-borde">
            {pestanas.map(([id, nombre]) => (
              <button key={id} onClick={() => { setPestana(id); entrada.current?.focus(); }}
                      className={`-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-3 py-2 text-[12.5px] font-medium
                                  ${pestana === id ? "border-texto text-texto" : "border-transparent text-tenue hover:text-texto"}`}>
                {nombre}
              </button>
            ))}
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] movil:grid-cols-1">
          <div ref={lista} className="min-h-0 overflow-y-auto p-1.5">
            {!resultados.length && <p className="px-3 py-6 text-center text-tenue">{datos ? "Sin resultados" : "Cargando…"}</p>}
            {resultados.map((x, i) => {
              const actual = x.s === symbol;
              return (
                <button key={x.s} data-i={i} onClick={() => abrir(x)} onMouseMove={() => { if (i !== sel) setSel(i); }}
                        className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 px-3 py-2 text-left ${i === sel ? "bg-panel-3" : "bg-transparent"}`}>
                  <span className={`grid size-8 flex-none place-items-center rounded-full text-[12px] font-bold text-white ${TONO[x.tipo] ?? TONO.divisa}`}>
                    {x.nombre.replace(/^Dominancia de /, "").slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[13px] font-semibold text-texto">{x.s === "USDT.D" ? "USDT.D" : x.nombre}</b>
                    <small className="block truncate text-[11.5px] text-tenue">{x.s === "USDT.D" ? x.nombre : x.s}</small>
                  </span>
                  <span className="text-right">
                    <span className="block text-[12px] text-texto">{x.fuente}</span>
                    <span className="block text-[11px] text-apagado">{TIPO[x.tipo] ?? ""}</span>
                  </span>
                  <span className="w-4 flex-none text-sube">{actual ? <Icon name="check" size={14} /> : null}</span>
                </button>
              );
            })}
          </div>
          <Ficha x={marcado} />
        </div>
        <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-borde px-4 py-2 text-[11.5px] text-tenue">
          {[["↑", "↓", "Navegar"], ["↵", "Abrir gráfico"], ["Tab", "Cambiar de mercado"], ["Esc", "Cerrar"]].map((x) => (
            <span key={x.at(-1)} className="flex items-center gap-1.5">
              {x.slice(0, -1).map((k) => (
                <kbd key={k} className="min-w-[18px] rounded border border-borde bg-panel-2 px-1 text-center font-mono text-[10.5px] leading-[18px] text-texto">{k}</kbd>
              ))}
              {x.at(-1)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** La ficha del mercado marcado: precio, cambio de hoy, la minigrafica de 24 h y la rueda de hoy. */
function Ficha({ x }) {
  if (!x) return <div className="border-l border-borde movil:hidden" />;
  const d = x.d;
  const dec = decimales(x.s, d?.last);
  const sube = (d?.change_pct ?? 0) >= 0;
  const puntos = d?.puntos ?? [];
  const min = Math.min(...puntos), max = Math.max(...puntos), r = max - min || 1;
  const camino = puntos.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, puntos.length - 1)) * 248},${58 - ((v - min) / r) * 52}`).join("");
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-borde p-4 movil:hidden">
      <div className="flex items-center gap-3">
        <span className={`grid size-10 flex-none place-items-center rounded-full text-[15px] font-bold text-white ${TONO[x.tipo] ?? TONO.divisa}`}>
          {x.nombre.replace(/^Dominancia de /, "").slice(0, 1)}
        </span>
        <span className="min-w-0">
          <b className="block truncate text-[15px] font-semibold">{x.s === "USDT.D" ? "USDT.D" : x.nombre}</b>
          <small className="block truncate text-[12px] text-tenue">{x.fuente} · {TIPO[x.tipo]}</small>
        </span>
      </div>
      {d ? (
        <>
          <div>
            <div className="font-mono text-[24px] leading-tight font-medium tracking-tight tabular-nums">{fmtNum(d.last, dec)}</div>
            <div className={`font-mono text-[12.5px] tabular-nums ${sube ? "text-sube" : "text-baja"}`}>
              {d.cambio !== null ? `${d.cambio >= 0 ? "+" : ""}${fmtNum(d.cambio, dec)} ` : ""}
              ({Number.isFinite(d.change_pct) ? `${sube ? "+" : ""}${fmtNum(d.change_pct, 2)} %` : "—"})
            </div>
            {x.tipo === "cripto" && <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-tenue"><i className="size-1.5 rounded-full bg-sube" />Abierto 24/7</div>}
          </div>
          {puntos.length > 1 && (
            <svg viewBox="0 0 248 60" className={`h-[60px] w-full ${sube ? "text-sube" : "text-baja"}`} preserveAspectRatio="none" aria-label="Últimas 24 horas">
              <path d={camino} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {d.dia && (
            <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-borde pt-3 text-[12px]">
              {[["Apertura", d.dia.o], ["Máximo", d.dia.h], ["Mínimo", d.dia.l]].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-tenue">{k}</dt>
                  <dd className="m-0 text-right font-mono tabular-nums">{fmtNum(v, dec)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : <span className="text-tenue">Sin datos todavía.</span>}
    </div>
  );
}
