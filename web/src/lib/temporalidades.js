/* Las temporalidades en el front: las de siempre y las a medida (3m,
   10m, 2H, 12H, 2D...; el servidor las arma con las de siempre, ver
   src/temporalidades.ts). Su nombre corto y cuanto dura cada vela. */

const CORTO = { "1h": "1H", "4h": "4H", "1d": "D", "1w": "S", "1M": "M" };
const UNIDAD = { m: 60, h: 3600, d: 86_400, w: 604_800 };

/** "10m" -> { n: 10, unidad: "m" }; null si no tiene esa forma. */
export function medida(i) {
  const m = /^(\d{1,4})([mhdw])$/.exec(String(i));
  return m ? { n: Number(m[1]), unidad: m[2] } : null;
}

/** Como se muestra: 5m, 1H, 2H, D, 2D, S, M. */
export function etiqueta(i) {
  if (CORTO[i]) return CORTO[i];
  const m = medida(i);
  if (!m) return i;
  return m.unidad === "m" ? `${m.n}m` : m.unidad === "h" ? `${m.n}H` : m.unidad === "d" ? `${m.n}D` : `${m.n}S`;
}

/** Cuanto dura una vela (s); el mes, null (va por calendario). */
export function segundos(i) {
  const m = medida(i);
  return m ? m.n * UNIDAD[m.unidad] : null;
}

/** Lo que se puede escribir (5, 15m, 4h, h, 240, d, s o w, mes, 2d...) -> la temporalidad. */
const ALIAS = { "60": "1h", h: "1h", "240": "4h", d: "1d", s: "1w", w: "1w", "1s": "1w", mes: "1M", "1mes": "1M", mn: "1M", "1mn": "1M" };
export function leer(texto) {
  const t = String(texto).trim().toLowerCase().replace(/\s+/g, "").replace(/min$/, "m").replace(/(\d)s$/, "$1w");
  if (!t) return null;
  if (ALIAS[t]) return ALIAS[t];
  if (/^\d+$/.test(t)) return `${Number(t)}m`;
  const m = /^(\d+)([mhdw])$/.exec(t);
  return m ? `${Number(m[1])}${m[2]}` : null;
}

/** Si una temporalidad se puede pedir (las de siempre o una a medida con forma valida). */
export function aceptable(i, intervals) {
  if (intervals.includes(i)) return true;
  const m = medida(i);
  if (!m || m.n < 1) return false;
  const tope = { m: 1440, h: 24, d: 30, w: 12 }[m.unidad];
  if (m.n > tope) return false;
  // Minutos y horas tienen que entrar justo en una de siempre (3m con 1m, 10m con 5m...).
  return m.unidad === "d" || m.unidad === "w" || intervals.some((x) => segundos(x) && segundos(x) < m.n * UNIDAD[m.unidad] && (m.n * UNIDAD[m.unidad]) % segundos(x) === 0 && segundos(x) <= 14_400);
}
