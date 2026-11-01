/* Los sonidos de NinjaTrader para la operativa: sus .wav (OrderFilled, StopFilled,
 * TargetFilled...) se buscan en SONIDOS_CARPETA, en la carpeta sonidos/ del proyecto
 * o donde los instala NinjaTrader 8 (en SONIDOS_IDIOMA, como es-ES, si se eligio; si
 * no, en ingles). Cada archivo se busca aparte, en ese orden. Los archivos son de
 * NinjaTrader: no van al repo. Lo que no esta suena con los tonos propios de la terminal. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config.ts";

/** Los de NinjaTrader que usa la terminal. */
export const NOMBRES = ["OrderFilled", "StopFilled", "TargetFilled", "PositionClosed", "OrderPending", "OrderCanceled"];

const NINJA = ["C:\\Program Files\\NinjaTrader 8\\sounds", "C:\\Program Files (x86)\\NinjaTrader 8\\sounds"];

function carpetas(): string[] {
  const idioma = config.SONIDOS_IDIOMA.replace(/[^A-Za-z-]/g, "");
  return [
    config.SONIDOS_CARPETA,
    join(ROOT, "sonidos"),
    ...(idioma ? NINJA.map((c) => join(c, idioma)) : []),
    ...NINJA,
  ].filter(Boolean);
}

/** De cada nombre, el archivo que hay: en la primera carpeta que lo tenga, sin mirar mayusculas. */
export function sonidosDisponibles(): { carpeta: string | null; archivos: Record<string, string> } {
  const archivos: Record<string, string> = {};
  let carpeta: string | null = null;
  for (const c of carpetas()) {
    let lista: string[];
    try { lista = readdirSync(c); } catch { continue; }
    for (const n of NOMBRES) {
      const f = !archivos[n] && lista.find((x) => x.toLowerCase() === `${n.toLowerCase()}.wav`);
      if (f) { archivos[n] = join(c, f); carpeta ??= c; }
    }
  }
  return { carpeta, archivos };
}

export function leerSonido(nombre: string): Buffer | null {
  const ruta = sonidosDisponibles().archivos[nombre];
  try { return ruta ? readFileSync(ruta) : null; } catch { return null; }
}
