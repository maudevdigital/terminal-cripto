/* Horario del mercado en el broker (sesiones de MT5): abierto, cuando cierra y
   cuando reabre. Con el mercado cerrado no se puede cancelar ni modificar nada. */

export const AVISO_MIN = 30;   // minutos antes del cierre en que se avisa

const hora = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dia = new Intl.DateTimeFormat("es-CL", { weekday: "short" });

/** "18:00", o "vie 18:00" si no es hoy. */
export function cuando(ms, ahora = Date.now()) {
  const d = new Date(ms);
  const hoy = new Date(ahora).toDateString() === d.toDateString();
  return hoy ? hora.format(d) : `${dia.format(d).replace(".", "")} ${hora.format(d)}`;
}

/** "en 12 min", "en 2 h 05 min", "en 1 d 4 h". */
export function enCuanto(ms, ahora = Date.now()) {
  const min = Math.max(0, Math.round((ms - ahora) / 60_000));
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `en ${h} h ${String(m).padStart(2, "0")} min`;
  return `en ${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Estado para mostrar: "abierto", "cierra" (dentro de AVISO_MIN) o "cerrado". */
export function estadoHorario(h, ahora = Date.now()) {
  if (!h) return null;
  if (!h.abierto) {
    return { estado: "cerrado", texto: h.abre ? `Cerrado · abre ${cuando(h.abre, ahora)} (${enCuanto(h.abre, ahora)})` : "Cerrado" };
  }
  const pronto = h.cierra && h.cierra - ahora <= AVISO_MIN * 60_000;
  const reabre = h.abre ? ` · reabre ${cuando(h.abre, ahora)}` : "";
  return {
    estado: pronto ? "cierra" : "abierto",
    texto: h.cierra ? `${pronto ? "Cierra" : "Abierto hasta"} ${cuando(h.cierra, ahora)} (${enCuanto(h.cierra, ahora)})${reabre}` : "Abierto",
  };
}

/** Por que no se puede operar ese mercado ahora (null: esta abierto o no se sabe). */
export function mercadoCerrado(h, ahora = Date.now()) {
  if (!h || h.abierto) return null;
  return `Mercado cerrado en el broker${h.abre ? `: reabre ${cuando(h.abre, ahora)}` : ""}. Hasta entonces no se puede abrir, cerrar, cancelar ni modificar`;
}

/** Al poner una pendiente: si el mercado cierra pronto, que se sepa que despues no se cancela. */
export function avisoPendiente(h, ahora = Date.now()) {
  if (!h?.abierto || !h.cierra) return null;
  const falta = h.cierra - ahora;
  if (falta > 2 * 3600_000) return null;
  return `El mercado cierra ${cuando(h.cierra, ahora)} (${enCuanto(h.cierra, ahora)})${h.abre ? ` y reabre ${cuando(h.abre, ahora)}` : ""}. `
    + "Si la orden no se ejecuta antes, no vas a poder cancelarla ni moverla con el mercado cerrado, y puede ejecutarse al reabrir.";
}
