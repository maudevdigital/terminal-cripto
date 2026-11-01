/* Como se presenta un mercado en las listas (buscador y lista de seguimiento): su
   tipo, el circulo de color con su inicial y los decimales de su precio. */

export const TIPO = { indice: "Índice", cripto: "Cripto", materia: "Materia prima", contexto: "Contexto", divisa: "Divisa" };
// El color del circulo de cada tipo (Tailwind).
export const TONO = { indice: "bg-[#2B5BD7]", cripto: "bg-[#F7931A]", materia: "bg-[#B8860B]", contexto: "bg-[#26A17B]", divisa: "bg-[#6B6B6E]" };

export const tipoDe = (cfg, s) => (s === "USDT.D" ? "contexto" : cfg.mercados[s]?.tipo ?? "cripto");
export const nombreDe = (cfg, s) => (s === "USDT.D" ? "USDT.D" : cfg.mercados[s]?.nombre ?? s);
export const fuenteDe = (cfg, s) => (s === "USDT.D" ? "CoinGecko" : cfg.mercados[s]?.fuente ?? s);
export const decimales = (s, v) => (s === "USDT.D" ? 3 : !(v > 0) ? 2 : v >= 10 ? 2 : v >= 1 ? 3 : 5);

/** El circulo con la inicial del mercado. */
export function Logo({ tipo, nombre, tam = "size-7 text-[11px]" }) {
  return (
    <span className={`grid flex-none place-items-center rounded-full font-bold text-white ${tam} ${TONO[tipo] ?? TONO.divisa}`}>
      {String(nombre).replace(/^Dominancia de /, "").slice(0, 1)}
    </span>
  );
}
