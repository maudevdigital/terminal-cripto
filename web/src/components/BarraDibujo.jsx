import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";

// Los grupos de la barra: cada uno con sus secciones y, en cada una,
// [herramienta, nombre, atajo].
export const GRUPOS = [
  { id: "cursor", nombre: "Cursor", secciones: [["Cursor", [["cursor", "Cursor", "Esc"]]]] },
  {
    id: "lineas", nombre: "Líneas", secciones: [["Líneas", [
      ["linea", "Línea de tendencia", "Alt+T"], ["hline", "Línea horizontal", "Alt+H"], ["rayo", "Rayo"], ["extendida", "Línea extendida"],
      ["vline", "Línea vertical", "Alt+V"], ["rayoH", "Rayo horizontal"], ["cruz", "Línea cruzada", "Alt+C"], ["info", "Línea de información"],
    ]]],
  },
  { id: "fib", nombre: "Fibonacci", secciones: [["Fibonacci", [["fib", "Retroceso de Fibonacci"]]]] },
  { id: "formas", nombre: "Formas", secciones: [["Formas", [["rect", "Rectángulo", "Alt+R"]]]] },
  { id: "texto", nombre: "Texto", secciones: [["Texto", [["texto", "Texto"]]]] },
];
// [herramienta, nombre, atajo (o undefined), grupo]
const TODAS = GRUPOS.flatMap((g) => g.secciones.flatMap(([, xs]) => xs.map(([id, nombre, atajo]) => [id, nombre, atajo, g.id])));
export const NOMBRE_HERRAMIENTA = Object.fromEntries([...TODAS.map(([id, n]) => [id, n]), ["medir", "Rango de precio y fecha"]]);
const CLAVE = "terminal-cripto:herramientas";

const BOTON = "relative grid size-9 flex-none cursor-pointer place-items-center rounded-md border-0 p-0 transition-colors";
const normal = "bg-transparent text-tenue hover:bg-hover hover:text-texto";
const activo = "bg-panel-3 text-texto";
const Sep = () => <span className="my-1.5 h-px w-7 flex-none bg-borde" />;

/** Las teclas de un atajo: [Alt] [H]. */
function Teclas({ atajo }) {
  if (!atajo) return null;
  return (
    <span className="flex gap-1">
      {atajo.split("+").map((k) => (
        <kbd key={k} className="min-w-5 rounded border border-borde bg-panel-2 px-1 text-center font-mono text-[10px] leading-[18px] font-semibold text-tenue">{k}</kbd>
      ))}
    </span>
  );
}

/** La barra de dibujo de la izquierda: los grupos de herramientas (el
 *  boton usa la ultima elegida de su grupo; el triangulito abre el panel con todas,
 *  un buscador y sus atajos) y, abajo, medir, el borrador, el iman, seguir dibujando,
 *  bloquear, ocultar y borrar todo. Se pliega con «. */
export default function BarraDibujo({
  herramienta, onHerramienta, iman, onIman, seguir, onSeguir, bloqueo, onBloqueo, ocultos, onOcultos, onBorrarTodo, plegada, onPlegar,
}) {
  // La ultima herramienta de cada grupo (la que muestra su boton).
  const [ultima, setUltima] = useState(() => {
    try { return { lineas: "linea", fib: "fib", formas: "rect", texto: "texto", ...JSON.parse(localStorage.getItem(CLAVE) || "{}") }; }
    catch { return { lineas: "linea", fib: "fib", formas: "rect", texto: "texto" }; }
  });
  const [panel, setPanel] = useState(null);   // { grupo, top }
  const caja = useRef(null);

  useEffect(() => {
    const g = TODAS.find(([id]) => id === herramienta)?.[3];
    if (g && g !== "cursor" && ultima[g] !== herramienta) {
      const n = { ...ultima, [g]: herramienta };
      setUltima(n);
      try { localStorage.setItem(CLAVE, JSON.stringify(n)); } catch { /* sin almacenamiento */ }
    }
  }, [herramienta, ultima]);

  useEffect(() => {
    if (!panel) return;
    const fuera = (e) => { if (!caja.current?.contains(e.target)) setPanel(null); };
    const esc = (e) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("pointerdown", fuera);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", fuera); window.removeEventListener("keydown", esc); };
  }, [panel]);

  if (plegada) {
    return (
      <div className="flex w-3.5 flex-none flex-col justify-end border-r border-borde bg-fondo">
        <button onClick={onPlegar} data-tip="Mostrar las herramientas" data-lado="derecha" aria-label="Mostrar las herramientas"
                className="grid h-9 w-3.5 cursor-pointer place-items-center border-0 bg-transparent p-0 text-tenue hover:text-texto">
          <Icon name="desplegar" size={11} />
        </button>
      </div>
    );
  }

  const abrir = (grupo, el) => {
    const top = el.getBoundingClientRect().top - caja.current.getBoundingClientRect().top;
    setPanel((p) => (p?.grupo === grupo ? null : { grupo, top }));
  };
  const elegir = (id) => { onHerramienta(id); setPanel(null); };

  return (
    <div ref={caja} role="toolbar" aria-label="Herramientas de dibujo" aria-orientation="vertical"
         className="relative z-20 flex w-12 flex-none flex-col items-center gap-0.5 border-r border-borde bg-fondo py-1.5">
      {GRUPOS.map((g) => {
        const id = g.id === "cursor" ? "cursor" : ultima[g.id];
        const nombre = NOMBRE_HERRAMIENTA[id];
        const atajo = TODAS.find(([x]) => x === id)?.[2];
        const varias = g.secciones.reduce((n, [, xs]) => n + xs.length, 0) > 1;
        const enGrupo = g.id === "cursor" ? herramienta === "cursor" : TODAS.some(([x, , , gr]) => x === herramienta && gr === g.id);
        return (
          <div key={g.id} className="group relative">
            <button onClick={() => onHerramienta(id)} onContextMenu={(e) => { if (varias) { e.preventDefault(); abrir(g.id, e.currentTarget); } }}
                    data-tip={nombre} data-atajo={atajo} data-lado="derecha" aria-label={nombre} aria-pressed={enGrupo}
                    className={`${BOTON} ${enGrupo ? activo : normal}`}>
              <Icon name={id} size={18} />
            </button>
            {varias && (
              <button onClick={(e) => abrir(g.id, e.currentTarget.parentElement)} aria-label={`${g.nombre} — más`} aria-expanded={panel?.grupo === g.id}
                      className="absolute -right-0.5 bottom-0 grid size-3.5 cursor-pointer place-items-end border-0 bg-transparent p-0.5 text-apagado hover:text-texto">
                <svg width="5" height="5" viewBox="0 0 5 5" aria-hidden="true"><path d="M5 0v5H0z" fill="currentColor" /></svg>
              </button>
            )}
          </div>
        );
      })}
      <Sep />
      <button onClick={() => onHerramienta(herramienta === "medir" ? "cursor" : "medir")} data-tip="Medir" data-lado="derecha" aria-label="Medir"
              aria-pressed={herramienta === "medir"} className={`${BOTON} ${herramienta === "medir" ? activo : normal}`}>
        <Icon name="regla" size={18} />
      </button>
      <button onClick={() => onHerramienta(herramienta === "borrador" ? "cursor" : "borrador")} data-tip="Borrador (click sobre un dibujo para borrarlo)" data-lado="derecha"
              aria-label="Borrador" aria-pressed={herramienta === "borrador"} className={`${BOTON} ${herramienta === "borrador" ? activo : normal}`}>
        <Icon name="borrador" size={18} />
      </button>
      <button onClick={onIman} data-tip={iman ? "Ajuste magnético: cada punto se pega al OHLC de la vela" : "Ajuste magnético apagado"} data-lado="derecha"
              aria-label="Ajuste magnético" aria-pressed={iman} className={`${BOTON} ${iman ? activo : normal}`}>
        <Icon name="iman" size={18} />
      </button>
      <button onClick={onSeguir} data-tip="Permanecer en modo dibujo" data-lado="derecha" aria-label="Permanecer en modo dibujo"
              aria-pressed={seguir} className={`${BOTON} ${seguir ? activo : normal}`}>
        <Icon name="seguir" size={18} />
      </button>
      <button onClick={onBloqueo} data-tip={bloqueo ? "Dibujos bloqueados: no se mueven ni se borran" : "Bloquear todos los dibujos"} data-lado="derecha"
              aria-label="Bloquear los dibujos" aria-pressed={bloqueo} className={`${BOTON} ${bloqueo ? activo : normal}`}>
        <Icon name={bloqueo ? "candado" : "candadoAbierto"} size={18} />
      </button>
      <button onClick={onOcultos} data-tip={ocultos ? "Mostrar los dibujos" : "Ocultar los dibujos"} data-lado="derecha"
              aria-label="Ocultar los dibujos" aria-pressed={ocultos} className={`${BOTON} ${ocultos ? activo : normal}`}>
        <Icon name={ocultos ? "oculto" : "visible"} size={18} />
      </button>
      <button onClick={onBorrarTodo} disabled={bloqueo} data-tip={bloqueo ? "Con los dibujos bloqueados no se borra ninguno" : "Borrar los dibujos de este mercado"}
              data-lado="derecha" aria-label="Borrar los dibujos" className={`${BOTON} ${normal} disabled:cursor-default disabled:opacity-35`}>
        <Icon name="papelera" size={18} />
      </button>
      <span className="flex-1" />
      <button onClick={onPlegar} data-tip="Ocultar las herramientas" data-lado="derecha" aria-label="Ocultar las herramientas" className={`${BOTON} ${normal}`}>
        <Icon name="plegar" size={14} />
      </button>
      {panel && <Panel grupo={GRUPOS.find((g) => g.id === panel.grupo)} top={panel.top} herramienta={herramienta} onElegir={elegir} />}
    </div>
  );
}

/** El panel de un grupo: un buscador (busca en todas las
 *  herramientas), las secciones con su cantidad y cada herramienta con su atajo. */
function Panel({ grupo, top, herramienta, onElegir }) {
  const [q, setQ] = useState("");
  const entrada = useRef(null);
  useEffect(() => { entrada.current?.focus(); }, []);
  const secciones = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return grupo.secciones;
    const xs = TODAS.filter(([, n]) => n.toLowerCase().includes(t));
    return [["Resultados", xs]];
  }, [q, grupo]);
  const total = secciones.reduce((n, [, xs]) => n + xs.length, 0);
  return (
    <div className="absolute left-[calc(100%+6px)] z-40 flex max-h-[min(560px,80vh)] w-[280px] animate-entra flex-col overflow-hidden rounded-[10px] border border-borde bg-vidrio shadow-desk"
         style={{ top: Math.max(0, top - 6) }}>
      <label className="flex flex-none items-center gap-2 border-b border-borde px-3 py-2.5">
        <Icon name="buscar" size={13} className="text-apagado" />
        <input ref={entrada} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar herramientas…" spellCheck={false}
               onKeyDown={(e) => { if (e.key === "Enter" && secciones[0]?.[1]?.[0]) onElegir(secciones[0][1][0][0]); }}
               className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[12.5px] text-texto outline-none placeholder:text-apagado" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {secciones.map(([titulo, xs]) => (
          <section key={titulo} className="py-1">
            <h4 className="m-0 flex items-center gap-2 px-2 pt-1.5 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] text-apagado uppercase">
              {titulo}
              <span className="h-px flex-1 bg-linea" />
              <span className="rounded border border-borde px-1.5 font-mono text-[10px] font-normal">{xs.length}</span>
            </h4>
            {xs.map(([id, nombre, atajo]) => (
              <button key={id} onClick={() => onElegir(id)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-md border-0 px-2 py-1.5 text-left text-[12.5px]
                                  ${id === herramienta ? "bg-panel-3 text-texto" : "bg-transparent text-texto hover:bg-hover"}`}>
                <span className="grid size-7 flex-none place-items-center rounded-md border border-borde text-tenue"><Icon name={id} size={15} /></span>
                <span className="flex-1">{nombre}</span>
                <Teclas atajo={atajo} />
              </button>
            ))}
          </section>
        ))}
        {!total && <p className="px-2 py-4 text-center text-tenue">Sin herramientas con ese nombre.</p>}
      </div>
      <div className="flex-none border-t border-borde px-3 py-1.5 text-[11px] text-apagado">
        {total} {total === 1 ? "herramienta" : "herramientas"}
      </div>
    </div>
  );
}
