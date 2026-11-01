import Icon from "./Icon.jsx";

/** El rail de la derecha: una estacion por icono. Cada una con su
 *  atajo, una cuenta (las posiciones abiertas) o un punto de alerta (el freno, una
 *  noticia restringida). `abajo` va pegado al borde inferior. */
export default function Rail({ items, abajo = [] }) {
  const boton = (it) => (
    <button key={it.id} onClick={it.onClick} aria-label={it.nombre} aria-pressed={Boolean(it.activo)}
            data-tip={`${it.nombre}${it.alerta ? ` · ${it.alerta}` : ""}`} data-atajo={it.atajo} data-lado="izquierda"
            className={`relative grid size-[34px] cursor-pointer place-items-center rounded-lg border-0 p-0 transition-colors
                        ${it.activo ? "bg-panel-3 text-texto" : "bg-transparent text-tenue hover:bg-hover hover:text-texto"}`}>
      {it.activo && <i className="absolute inset-y-2 -left-[5px] w-0.5 rounded-full bg-texto" />}
      <Icon name={it.icono} size={17} />
      {it.cuenta > 0 && (
        <em className="absolute right-px bottom-px h-[15px] min-w-[15px] rounded-full bg-texto px-[3px] text-center font-mono text-[9.5px] leading-[15px] font-semibold text-sobre-oscuro not-italic">
          {it.cuenta}
        </em>
      )}
      {it.alerta && <i className={`absolute top-1 right-1 size-[7px] rounded-full ring-2 ring-fondo ${it.tonoAlerta === "neutro" ? "bg-tenue" : it.tonoAlerta === "aviso" ? "bg-aviso-fuerte" : "bg-baja-fuerte"}`} />}
    </button>
  );
  return (
    <nav aria-label="Secciones" className="flex w-11 flex-none flex-col items-center gap-1 border-l border-borde bg-fondo py-2">
      {items.map(boton)}
      <span className="flex-1" />
      {abajo.map(boton)}
    </nav>
  );
}
