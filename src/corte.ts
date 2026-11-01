/* Corte automatico: lo que esta abierto SIN stop loss no puede perder mas de
 * CORTE_AUTO_USD. A cada posicion sin SL se le pone uno en el precio donde la perdida
 * llega a ese tope (un SL de verdad en el broker: corta aunque la terminal se apague).
 * Si ya perdio eso o el precio ya paso ese nivel, no se toca: la terminal nunca cierra
 * sola. Lo que tiene SL tampoco se toca. Sirve para MT5 y para Binance. */

export interface Abierta {
  id: string;                 // ticket de MT5, o simbolo:lado en Binance
  lado: "buy" | "sell";
  entrada: number;
  actual: number;             // precio actual (en MT5, el de cierre: bid en compra, ask en venta; en Binance, el de marca)
  sl: number | null;
  resultado: number;          // lo que da ahora, en USD (negativo: perdida)
  valorPorUnidad: number | null;   // USD que mueve la posicion entera por 1,0 de precio
  tick: number | null;        // paso del precio
}

export type Corte = { id: string; accion: "sl"; precio: number };

/** Que hacer con cada posicion sin SL para que no pierda mas de `tope` USD. */
export function planCorte(abiertas: Abierta[], tope: number): Corte[] {
  if (!(tope > 0)) return [];
  const out: Corte[] = [];
  for (const p of abiertas) {
    if (p.sl || !(p.valorPorUnidad! > 0) || !(p.entrada > 0)) continue;
    const compra = p.lado === "buy";
    if (p.resultado <= -tope) continue;
    // El nivel de la perdida maxima, redondeado al tick hacia la entrada (pierde un poco menos, nunca mas).
    const distancia = tope / p.valorPorUnidad!;
    let precio = compra ? p.entrada - distancia : p.entrada + distancia;
    const tick = p.tick && p.tick > 0 ? p.tick : 0;
    if (tick) {
      const dec = Math.max(0, Math.round(-Math.log10(tick)) + 1);
      precio = Number(((compra ? Math.ceil(precio / tick - 1e-9) : Math.floor(precio / tick + 1e-9)) * tick).toFixed(dec));
    }
    // El precio ya paso ese nivel: no hay donde poner el SL.
    if (p.actual > 0 && (compra ? p.actual <= precio : p.actual >= precio)) continue;
    out.push({ id: p.id, accion: "sl", precio });
  }
  return out;
}
