import { fmtNum } from "../lib/format.js";
import { cuando } from "../lib/horario.js";

/** El freno de disciplina: cuantas operaciones van hoy, la racha y si bloquea. */
export function FrenoEstado({ freno }) {
  if (!freno) return null;
  const { reglas } = freno;
  if (freno.activo) {
    return (
      <div className={`dato freno ${freno.bloquea ? "bloquea" : "avisa"}`}>
        <b>{freno.pausa?.activa ? "Cuenta real en pausa: se practica en demo"
          : !freno.bloquea ? "Freno: conviene parar por ahora"
            : freno.porDia ? "Freno puesto: hoy no se abre nada más" : "Freno puesto: todavía no se abre nada"}</b>
        <span>{freno.motivos.join(" · ")}.</span>
        <span className="tenue">
          {freno.hasta ? `Se levanta ${cuando(freno.hasta)}${freno.porDia ? " (cuando corta el día de la firma)" : ""}.` : ""}
          {freno.bloquea ? " Cerrar, acercar el SL, mover el TP y cancelar siguen permitidos." : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="freno-fila tenue" title="Freno de disciplina: al perder el máximo del día no se abre nada más hasta el corte (FRENO_PERDIDA_DIA_USD y FRENO_MODO en el .env)">
      <span>Hoy <b>{freno.hoy}</b>{reglas.operacionesDia ? ` de ${reglas.operacionesDia}` : ""} operaciones</span>
      {reglas.perdidaDia > 0 && <span>· pérdida máxima del día <b>{fmtNum(reglas.perdidaDia, 0)} USD</b></span>}
    </div>
  );
}
