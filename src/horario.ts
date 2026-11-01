/* Horario de un mercado del broker: si esta abierto, cuando cierra y cuando reabre.
 *
 * MT5 conoce las sesiones de trading de cada simbolo (el puente las exporta). Con
 * el mercado cerrado no se puede abrir, cerrar, cancelar ni modificar nada: una
 * orden pendiente que no se cancelo antes del cierre sigue viva y puede
 * ejecutarse al reabrir. Por eso la terminal avisa antes. */

/** [dia (0 = domingo), desde, hasta]: segundos desde las 00:00 del servidor. */
export type Sesion = [number, number, number];

export interface Horario {
  abierto: boolean;
  cierra: number | null;     // ms UTC: cuando cierra (si esta abierto)
  abre: number | null;       // ms UTC: cuando reabre (despues del proximo cierre, o el proximo, si esta cerrado)
  tramos: { desde: number; hasta: number }[];   // los proximos tramos abiertos (ms UTC), para mostrar
}

/** `offset`: hora del servidor menos UTC, en segundos (gmt_offset del puente). */
export function horario(sesiones: Sesion[] | null | undefined, offset: number, ahoraMs = Date.now()): Horario | null {
  if (!Array.isArray(sesiones) || !sesiones.length) return null;
  const ahora = Math.floor(ahoraMs / 1000);
  const srv = ahora + offset;
  const hoy0 = srv - (((srv % 86_400) + 86_400) % 86_400);           // 00:00 del servidor
  const diaHoy = new Date(hoy0 * 1000).getUTCDay();
  // Los tramos de ayer a dentro de 8 dias, en UTC, ordenados y unidos cuando se tocan
  // (lunes 00:00-24:00 seguido de martes 00:00-... es un solo tramo).
  const crudos: [number, number][] = [];
  for (let k = -1; k <= 8; k++) {
    const dia = (((diaHoy + k) % 7) + 7) % 7, base = hoy0 + k * 86_400 - offset;
    for (const [d, a, b] of sesiones) if (d === dia && b > a) crudos.push([base + a, base + b]);
  }
  crudos.sort((x, y) => x[0] - y[0]);
  const tramos: [number, number][] = [];
  for (const t of crudos) {
    const u = tramos.at(-1);
    if (u && t[0] <= u[1] + 60) u[1] = Math.max(u[1], t[1]);
    else tramos.push([...t]);
  }
  const actual = tramos.find(([a, b]) => a <= ahora && ahora < b);
  const siguiente = tramos.find(([a]) => a > ahora);
  const despues = actual ? tramos.find(([a]) => a >= actual[1]) : siguiente;
  return {
    abierto: Boolean(actual),
    cierra: actual ? actual[1] * 1000 : null,
    abre: despues ? despues[0] * 1000 : null,
    tramos: tramos.filter(([, b]) => b > ahora).slice(0, 4).map(([a, b]) => ({ desde: a * 1000, hasta: b * 1000 })),
  };
}
