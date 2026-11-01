/* Logger con el mismo formato que tenia el servidor en Python:
   "HH:MM:SS  NIVEL   modulo  mensaje". */

type Nivel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const DEBUG = process.env.LOG_DEBUG === "true";

function hora(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function getLogger(nombre: string): Logger {
  const out = (nivel: Nivel, msg: string) => {
    const linea = `${hora()}  ${nivel.padEnd(7)} ${nombre}  ${msg}`;
    if (nivel === "ERROR" || nivel === "WARNING") console.error(linea);
    else console.log(linea);
  };
  return {
    debug: (m) => { if (DEBUG) out("DEBUG", m); },
    info: (m) => out("INFO", m),
    warn: (m) => out("WARNING", m),
    error: (m) => out("ERROR", m),
  };
}
