import Icon from "./Icon.jsx";

/** El encabezado de una estacion del panel de la derecha: el titulo,
 *  lo que sume cada una y la ✕. Va como hermano del contenido (no lo envuelve). */
export default function Estacion({ titulo, onCerrar, children }) {
  return (
    <div className="flex h-11 flex-none items-center gap-2 border-b border-borde px-3.5">
      <h2 className="m-0 flex-1 text-[13px] font-semibold tracking-tight text-texto">{titulo}</h2>
      {children}
      {onCerrar && (
        <button onClick={onCerrar} title="Cerrar" aria-label="Cerrar"
                className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-tenue hover:bg-hover hover:text-texto">
          <Icon name="x" size={15} />
        </button>
      )}
    </div>
  );
}
