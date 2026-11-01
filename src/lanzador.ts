/* Abre MetaTrader 5 con el puente al arrancar el terminal (Windows).
 *
 * - Si MT5 ya esta abierto no lo toca; si el puente no publica, lo avisa.
 * - Instala o actualiza el puente (mt5/CriptoTerminalBridge.mq5) en la carpeta
 *   de datos de MT5 y lo compila con MetaEditor cuando cambio.
 * - Si el perfil con el que abre MT5 no tiene el puente en ningun grafico, lo
 *   arranca con /config: un grafico de XAUUSD H1 con el EA puesto. MT5 lo guarda
 *   en el perfil al cerrar, asi que eso pasa una sola vez.
 *
 * El puente es de solo lectura: no manda ni modifica ordenes. MT5_LANZAR=false
 * (o --sin-mt5) lo apaga. */

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config, ROOT } from "./config.ts";
import { getLogger } from "./log.ts";

const log = getLogger("mt5");

const PUENTE = "CriptoTerminalBridge";
// El que opera (panel Operar): se instala y compila, pero nunca se pone en un
// grafico solo. Eso lo hace la persona, con su login en InpCuenta.
const OPERADOR = "CriptoTerminalOperador";

/** Lo que muestra la interfaz mientras MT5 arranca. */
export const lanzador = { estado: "apagado", detalle: "" };

const fijar = (estado: string, detalle = "") => {
  lanzador.estado = estado;
  lanzador.detalle = detalle;
};

/** Los .ini y .chr de MT5 vienen en UTF-16 con BOM; los nuestros, en UTF-8. */
export function texto(path: string): string {
  const b = readFileSync(path);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  return b.toString("utf8");
}

const ejecutar = (cmd: string, args: string[], ms = 60_000) => new Promise<string>((ok) => {
  execFile(cmd, args, { timeout: ms, windowsHide: true }, (_err, stdout) => ok(String(stdout ?? "")));
});

export interface Instalacion { datos: string; terminal: string; metaeditor: string }

/** Las instalaciones de MT5 del usuario: cada carpeta de datos dice en origin.txt
 *  de que programa es. */
export function instalaciones(): Instalacion[] {
  const raiz = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "MetaQuotes", "Terminal");
  const out: Instalacion[] = [];
  let carpetas: string[] = [];
  try { carpetas = readdirSync(raiz); } catch { return out; }
  for (const c of carpetas) {
    const datos = join(raiz, c);
    try {
      const prog = texto(join(datos, "origin.txt")).trim();
      const terminal = join(prog, "terminal64.exe");
      if (existsSync(terminal)) out.push({ datos, terminal, metaeditor: join(prog, "MetaEditor64.exe") });
    } catch { /* carpeta sin origin.txt (la comun, la de los agentes) */ }
  }
  return out;
}

/** La instalacion a usar: la de MT5_TERMINAL, o la que ya tenga el puente
 *  (la que publico mas recientemente), o la unica que haya. */
export function elegirInstalacion(lista = instalaciones()): Instalacion | null {
  if (config.MT5_TERMINAL) {
    const t = config.MT5_TERMINAL.toLowerCase();
    return lista.find((i) => i.terminal.toLowerCase() === t || dirname(i.terminal).toLowerCase() === t.replace(/[\\/]$/, "")) ?? null;
  }
  const edad = (i: Instalacion) => {
    try { return statSync(join(i.datos, "MQL5", "Files", "cripto-terminal", "estado.json")).mtimeMs; } catch { return 0; }
  };
  const conPuente = lista.filter((i) => existsSync(join(i.datos, "MQL5", "Experts", "CriptoTerminal")));
  if (conPuente.length) return conPuente.sort((a, b) => edad(b) - edad(a))[0];
  return lista.length === 1 ? lista[0] : null;
}

/** Copia el puente a MT5 y lo compila si la copia instalada es otra o quedo sin
 *  compilar. Devuelve false si MetaEditor dio errores. */
export async function instalarPuente(inst: Instalacion, nombre = PUENTE): Promise<boolean> {
  const FUENTE = join(ROOT, "mt5", `${nombre}.mq5`);
  if (!existsSync(FUENTE)) return true;
  const carpeta = join(inst.datos, "MQL5", "Experts", "CriptoTerminal");
  const mq5 = join(carpeta, `${nombre}.mq5`), ex5 = join(carpeta, `${nombre}.ex5`);
  const normal = (s: string) => s.replace(/\r\n/g, "\n");
  const nuevo = normal(readFileSync(FUENTE, "utf8"));
  const igual = existsSync(mq5) && normal(readFileSync(mq5, "utf8")) === nuevo;
  const compilado = existsSync(ex5) && existsSync(mq5) && statSync(ex5).mtimeMs >= statSync(mq5).mtimeMs;
  if (igual && compilado) return true;

  mkdirSync(carpeta, { recursive: true });
  if (!igual) {
    if (existsSync(mq5)) {
      const respaldo = `${mq5}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
      if (!existsSync(respaldo)) copyFileSync(mq5, respaldo);
    }
    copyFileSync(FUENTE, mq5);
  }
  if (!existsSync(inst.metaeditor)) {
    log.warn(`No esta MetaEditor en ${inst.metaeditor}: compila ${nombre}.mq5 a mano`);
    return existsSync(ex5);
  }
  const registro = join(config.DATOS, `mt5-compilacion-${nombre}.log`);
  mkdirSync(config.DATOS, { recursive: true });
  log.info(`Compilando ${nombre} en ${carpeta} ...`);
  await ejecutar(inst.metaeditor, [`/compile:${mq5}`, `/log:${registro}`], 120_000);
  let resultado = "";
  try { resultado = texto(registro); } catch { /* sin registro */ }
  const linea = resultado.split(/\r?\n/).find((l) => /^Result:/.test(l.trim())) ?? "";
  const ok = /\b0 errors?\b/.test(linea);
  if (ok) log.info(`${nombre} compilado (${linea.trim()})`);
  else log.error(`MetaEditor no pudo compilar ${nombre}: ${linea.trim() || "sin resultado"} — ver ${registro}`);
  return ok;
}

/** Si alguno de los graficos del perfil que abre MT5 ya tiene el puente. */
export function perfilTienePuente(inst: Instalacion): boolean {
  let perfil = "Default";
  try {
    const m = texto(join(inst.datos, "config", "common.ini")).match(/^\s*ProfileLast\s*=\s*(.+?)\s*$/m);
    if (m) perfil = m[1];
  } catch { /* sin common.ini: el perfil por defecto */ }
  const carpeta = join(inst.datos, "MQL5", "Profiles", "Charts", perfil);
  try {
    return readdirSync(carpeta).filter((f) => f.toLowerCase().endsWith(".chr"))
      .some((f) => texto(join(carpeta, f)).includes(`name=${PUENTE}`));
  } catch {
    return false;
  }
}

/** Rutas de los terminal64.exe que estan corriendo. */
async function abiertos(): Promise<string[]> {
  const salida = await ejecutar("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-Process terminal64 -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"], 20_000);
  return salida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Espera que el puente escriba (hasta `seg` segundos). */
async function esperarPuente(inst: Instalacion, seg: number): Promise<boolean> {
  const archivo = join(inst.datos, "MQL5", "Files", "cripto-terminal", "estado.json");
  for (let i = 0; i < seg; i++) {
    try { if (Date.now() - statSync(archivo).mtimeMs < 5000) return true; } catch { /* todavia no existe */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function abrirMT5(): Promise<void> {
  if (!config.MT5_LANZAR || process.argv.includes("--sin-mt5")) return;
  if (process.platform !== "win32") return;   // en Linux/Mac (Wine) se abre a mano
  fijar("buscando");
  const inst = elegirInstalacion();
  if (!inst) {
    fijar("no_encontrado", "No encontré MetaTrader 5: indicá MT5_TERMINAL en el .env");
    log.warn(lanzador.detalle);
    return;
  }
  try {
    const compilado = await instalarPuente(inst);
    await instalarPuente(inst, OPERADOR);
    const corriendo = (await abiertos()).some((p) => p.toLowerCase() === inst.terminal.toLowerCase());
    if (corriendo) {
      if (await esperarPuente(inst, 6)) { fijar("conectado"); return; }
      fijar("sin_puente", `MT5 está abierto pero el puente no publica: arrastrá ${PUENTE} (Asesores › CriptoTerminal) a un gráfico`);
      log.warn(lanzador.detalle);
      return;
    }
    const args: string[] = [];
    if (compilado && !perfilTienePuente(inst)) {
      // Arranque con un grafico de oro en 1H y el puente puesto. En UTF-16, como
      // los .ini del propio MT5.
      const ini = join(config.DATOS, "mt5-inicio.ini");
      mkdirSync(config.DATOS, { recursive: true });
      const cuerpo = `[StartUp]\r\nExpert=CriptoTerminal\\${PUENTE}\r\nSymbol=XAUUSD\r\nPeriod=H1\r\n`;
      writeFileSync(ini, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cuerpo, "utf16le")]));
      args.push(`/config:${ini}`);
    }
    log.info(`Abriendo MetaTrader 5 (${inst.terminal})${args.length ? " con el puente en un gráfico de XAUUSD" : ""}`);
    fijar("abriendo");
    spawn(inst.terminal, args, { detached: true, stdio: "ignore" }).unref();
    if (await esperarPuente(inst, 90)) {
      fijar("conectado");
      log.info("Puente MT5 publicando");
    } else {
      fijar("sin_puente", `MT5 abrió pero el puente no publica: revisá que esté en un gráfico y que la cuenta esté conectada`);
      log.warn(lanzador.detalle);
    }
  } catch (exc) {
    fijar("error", String(exc instanceof Error ? exc.message : exc));
    log.error(`No se pudo abrir MT5: ${lanzador.detalle}`);
  }
}
