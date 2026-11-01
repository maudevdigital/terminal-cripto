/* Las sesiones del mercado para el grafico (las mismas del indicador de MT5):
   cada una en la hora de su ciudad, con su horario de verano. */

import { deLocal } from "../../../src/sesiones.ts";

// Tonos oscuros, para que se lean sobre el fondo arena del grafico.
export const SESIONES = [
  { nombre: "Sídney", zona: "Australia/Sydney", desde: "07:00", hasta: "16:00", rgb: "150,118,22" },
  { nombre: "Tokio", zona: "Asia/Tokyo", desde: "09:00", hasta: "18:00", rgb: "160,58,96" },
  { nombre: "Londres", zona: "Europe/London", desde: "08:00", hasta: "17:00", rgb: "46,82,156" },
  { nombre: "Nueva York", zona: "America/New_York", desde: "09:30", hasta: "16:00", rgb: "181,101,29" },
];

const minutos = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const formatos = new Map();
function fechaEn(zona, t) {
  let f = formatos.get(zona);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }); formatos.set(zona, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, finde: p.weekday === "Sat" || p.weekday === "Sun" };
}

/** Las sesiones (inicio y fin en s, UTC) que tocan el rango [a, b]. */
export function sesionesEntre(a, b) {
  const out = [];
  for (const s of SESIONES) {
    const vistas = new Set();
    for (let t = a - 2 * 86_400; t <= b + 86_400; t += 43_200) {
      const f = fechaEn(s.zona, t);
      const clave = `${f.y}-${f.m}-${f.d}`;
      if (vistas.has(clave) || f.finde) continue;
      vistas.add(clave);
      const inicio = deLocal(f.y, f.m, f.d, minutos(s.desde), s.zona) / 1000;
      let fin = deLocal(f.y, f.m, f.d, minutos(s.hasta), s.zona) / 1000;
      if (fin <= inicio) fin += 86_400;
      if (fin > a && inicio < b) out.push({ ...s, inicio, fin });
    }
  }
  return out;
}
