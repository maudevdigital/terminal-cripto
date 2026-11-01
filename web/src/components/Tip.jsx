import { useEffect, useState } from "react";

/** Los tooltips de la terminal: una pildora oscura con el nombre y el
 *  atajo en teclas, al pasar el mouse por un elemento con `data-tip` (y, si tiene,
 *  `data-atajo`, p. ej. "Alt+H", y `data-lado`: derecha, izquierda o abajo). Uno solo
 *  para toda la pagina; aparece a los 350 ms y, ya abierto, pasa de boton en boton
 *  sin esperar. */
export default function Tip() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    let timer = null, abierto = false, actual = null;
    const mostrar = (el) => {
      const r = el.getBoundingClientRect();
      const lado = el.dataset.lado || "abajo";
      setTip({ texto: el.dataset.tip, atajo: el.dataset.atajo, lado, r });
      abierto = true;
    };
    const sobre = (e) => {
      const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
      if (el === actual) return;
      actual = el;
      clearTimeout(timer);
      if (!el) { timer = setTimeout(() => { abierto = false; setTip(null); }, 80); return; }
      if (abierto) mostrar(el);
      else timer = setTimeout(() => mostrar(el), 350);
    };
    const cerrar = () => { clearTimeout(timer); abierto = false; actual = null; setTip(null); };
    document.addEventListener("pointerover", sobre);
    document.addEventListener("pointerdown", cerrar, true);
    window.addEventListener("blur", cerrar);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", sobre);
      document.removeEventListener("pointerdown", cerrar, true);
      window.removeEventListener("blur", cerrar);
    };
  }, []);
  if (!tip) return null;
  const { r, lado } = tip;
  const pos = lado === "derecha" ? { left: r.right + 8, top: r.top + r.height / 2, transform: "translateY(-50%)" }
    : lado === "izquierda" ? { left: r.left - 8, top: r.top + r.height / 2, transform: "translate(-100%, -50%)" }
    : { left: r.left + r.width / 2, top: r.bottom + 8, transform: "translateX(-50%)" };
  return (
    <div role="tooltip" style={pos}
         className="pointer-events-none fixed z-[100] flex animate-entra items-center gap-2 rounded-md border border-borde bg-panel-3 px-2 py-1 text-[11.5px] whitespace-nowrap text-texto shadow-desk">
      <span>{tip.texto}</span>
      {tip.atajo && (
        <span className="flex gap-0.5">
          {tip.atajo.split("+").map((k) => (
            <kbd key={k} className="min-w-[18px] rounded border border-borde bg-panel-2 px-1 text-center font-mono text-[10px] leading-4 text-tenue">{k}</kbd>
          ))}
        </span>
      )}
    </div>
  );
}
