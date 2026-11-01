/* Puente de solo lectura con MetaTrader 5.
 *
 * Un EA dentro de MT5 (`mt5/CriptoTerminalBridge.mq5`) escribe el estado en un
 * JSON y aca solo se lee ese archivo — no manda ordenes, no modifica posiciones.
 *
 * La app lo usa para la cuenta y las posiciones, la cotizacion del broker (y
 * cuanto se separa del grafico), la especificacion del contrato para pasar el
 * riesgo a lotes y, desde la v2 del puente, las velas del broker: la historia
 * de cada temporalidad en `cripto-terminal/velas` y las dos ultimas en el
 * estado, cada segundo. Sin el puente, se usan `MT5_ACCOUNT_EQUITY` y
 * `MT5_CONTRACT_SIZE` del `.env`. */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Candle, Ticker } from "./binance.ts";
import { config } from "./config.ts";
import { agrupar, medianocheNY } from "./indices.ts";
import { getLogger } from "./log.ts";

const log = getLogger("mt5");

const redondear = (x: number, d: number) => Number(x.toFixed(d));

// Donde suele quedar el MQL5\Files de una instalacion de MT5. El "*" es el hash
// de la carpeta de datos de cada terminal en Windows.
const RUTAS_TIPICAS = [
  // Windows (instalacion normal)
  "~/AppData/Roaming/MetaQuotes/Terminal/*/MQL5/Files",
  // Linux: Wine, con prefijo dedicado o el de por defecto
  "~/.local/share/wineprefixes/mt5/drive_c/Program Files/MetaTrader 5/MQL5/Files",
  "~/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Files",
  "~/.mt5/drive_c/Program Files/MetaTrader 5/MQL5/Files",
];
const ARCHIVO = "cripto-terminal/estado.json";

/** Version del puente de mt5/CriptoTerminalBridge.mq5. MT5 no recarga un EA que
 *  se recompila mientras corre: si el que publica es mas viejo, hay que
 *  reiniciar MT5 (o volver a ponerlo en el grafico). */
export const VERSION_PUENTE = 9;

const expandir = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Expande un patron con segmentos "*" (solo comodin de carpeta completa). */
function glob(patron: string): string[] {
  const partes = resolve(expandir(patron)).split(/[\\/]/);
  let actuales = [partes[0] + (partes[0].endsWith(":") ? "\\" : "/")];
  for (const parte of partes.slice(1)) {
    if (!parte) continue;
    const siguientes: string[] = [];
    for (const base of actuales) {
      if (parte === "*") {
        try {
          for (const e of readdirSync(base, { withFileTypes: true })) {
            if (e.isDirectory()) siguientes.push(join(base, e.name));
          }
        } catch { /* carpeta que no existe */ }
      } else {
        const p = join(base, parte);
        if (existsSync(p)) siguientes.push(p);
      }
    }
    actuales = siguientes;
  }
  return actuales.sort();
}

/** Todos los JSON de puente que existan, sin repetir. Una instalacion de MT5
 *  maneja una sola cuenta, asi que seguir varias implica varios terminales. */
export function localizarTodos(): string[] {
  const vistos = new Set<string>();
  const salida: string[] = [];
  const agregar = (p: string) => {
    let clave = p;
    try { clave = realpathSync(p); } catch { /* todavia no existe */ }
    if (!vistos.has(clave) && existsSync(p)) {
      vistos.add(clave);
      salida.push(p);
    }
  };
  // El .env puede traer varias rutas separadas por coma.
  for (const crudo of config.MT5_STATE_FILE.split(",")) {
    if (crudo.trim()) agregar(expandir(crudo.trim()));
  }
  for (const base of RUTAS_TIPICAS) {
    for (const carpeta of glob(base)) agregar(join(carpeta, ARCHIVO));
  }
  return salida;
}

export function num(x: any, porDefecto: number | null = null): number | null {
  if (x === null || x === undefined || typeof x === "boolean") return x === true ? 1 : (x === false ? 0 : porDefecto);
  const v = typeof x === "number" ? x : Number(String(x).trim());
  if (typeof x === "string" && x.trim() === "") return porDefecto;
  return Number.isNaN(v) && String(x).trim().toLowerCase() !== "nan" ? porDefecto : v;
}

export function brokerSymbol(symbol: string): string | null {
  return config.MT5_SYMBOL_MAP[symbol.toUpperCase()] ?? null;
}

/** Busca una clave sin importar mayusculas: el mapa de simbolos va en
 *  mayusculas y MT5 respeta las del broker (US30.cash). */
export function buscar<T>(obj: Record<string, T> | null | undefined, nombre: string): T | undefined {
  if (!obj) return undefined;
  if (Object.hasOwn(obj, nombre)) return obj[nombre];
  const k = Object.keys(obj).find((x) => x.toLowerCase() === nombre.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

/** Cachea un archivo de puente. Uno por terminal de MT5. */
class Lector {
  path: string;
  private mtime = 0;
  private state: any = {};

  constructor(path: string) {
    this.path = path;
  }

  refrescar(): void {
    try {
      const mtime = statSync(this.path).mtimeMs / 1000;
      if (mtime === this.mtime) return;
      // El EA escribe en ANSI (cp1252): latin1 respeta los acentos.
      this.state = JSON.parse(readFileSync(this.path, "latin1"));
      this.mtime = mtime;
    } catch (exc) {
      // Un JSON a medio escribir se ignora: el EA reescribe en un segundo.
      log.debug(`No se pudo leer ${this.path}: ${exc}`);
    }
  }

  get login(): string {
    return String(this.state?.account?.login || "");
  }

  // El calendario economico de MT5 (puente v9): al lado de estado.json.
  private cal = { mtime: 0, datos: null as any };

  calendario(): any | null {
    const ruta = join(dirname(this.path), "calendario.json");
    try {
      const mtime = statSync(ruta).mtimeMs;
      if (mtime !== this.cal.mtime) this.cal = { mtime, datos: JSON.parse(readFileSync(ruta, "latin1")) };
    } catch (exc) {
      // Sin archivo (puente anterior a v9) o a medio escribir: queda el ultimo leido.
      if ((exc as NodeJS.ErrnoException)?.code === "ENOENT") this.cal = { mtime: 0, datos: null };
    }
    return this.cal.datos;
  }

  // El historial de la cuenta (puente v5): al lado de estado.json.
  private hist = { mtime: 0, datos: null as any };

  historial(): any | null {
    const ruta = join(dirname(this.path), "historial.json");
    try {
      const mtime = statSync(ruta).mtimeMs;
      if (mtime !== this.hist.mtime) {
        this.hist = { mtime, datos: JSON.parse(readFileSync(ruta, "latin1")) };
      }
    } catch (exc) {
      // Sin archivo (puente anterior a v5) o a medio escribir: queda el ultimo leido.
      if ((exc as NodeJS.ErrnoException)?.code === "ENOENT") this.hist = { mtime: 0, datos: null };
    }
    return this.hist.datos;
  }

  leer(): any {
    if (!this.state || !Object.keys(this.state).length) return { available: false, reason: "sin_puente" };
    const edad = Date.now() / 1000 - this.mtime;
    const symbols: Record<string, any> = {};
    for (const s of this.state.symbols ?? []) symbols[s.symbol] = s;
    return {
      available: true,
      live: edad <= config.MT5_MAX_AGE,
      age_s: redondear(edad, 1),
      source: this.state.source ?? "mt5",
      path: this.path,
      account: this.state.account ?? {},
      connected: Boolean(this.state.connected ?? 0),
      positions: this.state.positions ?? [],
      orders: this.state.orders ?? [],
      symbols,
      version: Number(this.state.bridge_version ?? 1),
      gmt_offset: num(this.state.gmt_offset),
      velas: this.state.velas ?? null,
      mtime: this.mtime,
    };
  }
}

/** Sigue todas las cuentas que esten publicando, indexadas por login. */
export class BrokerBridge {
  private lectores = new Map<string, Lector>();
  private checked = 0;

  private refrescar(): void {
    const ahora = Date.now() / 1000;
    // Rescanea cada 5 s: un terminal puede arrancar despues que el servidor.
    if (ahora - this.checked >= 5.0) {
      this.checked = ahora;
      for (const path of localizarTodos()) {
        if (!this.lectores.has(path)) {
          log.info(`Puente MT5 detectado en ${path}`);
          this.lectores.set(path, new Lector(path));
        }
      }
      for (const [clave, lector] of [...this.lectores]) {
        if (!existsSync(lector.path)) {
          log.info(`Puente MT5 desaparecido: ${clave}`);
          this.lectores.delete(clave);
        }
      }
    }
    for (const lector of this.lectores.values()) lector.refrescar();
  }

  /** Resumen de cada cuenta que este publicando, para elegir cual mirar. */
  cuentas(): any[] {
    this.refrescar();
    const salida: any[] = [];
    for (const lector of this.lectores.values()) {
      const est = lector.leer();
      if (!est.available) continue;
      const cta = est.account;
      salida.push({
        login: String(cta.login || ""),
        server: cta.server ?? "",
        company: cta.company ?? "",
        currency: cta.currency ?? "USD",
        balance: cta.balance ?? null,
        equity: cta.equity ?? null,
        live: est.live,
        age_s: est.age_s,
        positions: est.positions.length,
        path: est.path,
      });
    }
    // Las vivas primero, despues por login, para que el orden no baile.
    salida.sort((a, b) => (Number(!a.live) - Number(!b.live)) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
    return salida;
  }

  /** Con una cuenta fijada en el .env solo se puede usar esa. Sin cuenta fijada,
   *  se elige la primera viva o, si no hay ninguna viva, cualquiera. */
  private elegir(): Lector | null {
    const candidatos: [boolean, string, Lector][] = [];
    for (const lector of this.lectores.values()) {
      const est = lector.leer();
      if (!est.available) continue;
      if (config.MT5_ACCOUNT && lector.login === config.MT5_ACCOUNT) return lector;
      candidatos.push([!est.live, lector.login, lector]);
    }
    if (config.MT5_ACCOUNT || !candidatos.length) return null;
    candidatos.sort((a, b) => (Number(a[0]) - Number(b[0])) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return candidatos[0][2];
  }

  /** Estado de una cuenta. Sin `login`, la elegida por defecto. */
  estado(login?: string | null): any {
    this.refrescar();
    if (login) {
      for (const lector of this.lectores.values()) {
        if (lector.login === String(login)) return lector.leer();
      }
      return { available: false, reason: "cuenta_no_encontrada" };
    }
    const lector = this.elegir();
    return lector ? lector.leer() : { available: false, reason: "sin_puente" };
  }

  /** Historial de la cuenta (los deals que exporta el puente v5). Sin `login`, el
   *  de la cuenta elegida por defecto. */
  /** El calendario economico que exporta el puente v9 (el de cualquier cuenta: es el mismo). */
  calendario(): any | null {
    this.refrescar();
    return this.elegir()?.calendario() ?? null;
  }

  historial(login?: string | null): any | null {
    this.refrescar();
    for (const lector of this.lectores.values()) {
      if (login && lector.login === String(login)) return lector.historial();
    }
    return login ? null : this.elegir()?.historial() ?? null;
  }

  brokerSymbol(symbol: string): string | null {
    return brokerSymbol(symbol);
  }
}

// Tolerancia relativa antes de redondear hacia abajo. Sin esto, una resta como
// 0,1904 - 0,1404 (= 0,05000000000000002 en binario) hace que un lotaje que vale
// exactamente 0,02 caiga a 0,01. Es mucho mas chico que cualquier paso real.
export const EPS = 1e-9;

/** Redondeo hacia abajo al paso, a prueba de basura de coma flotante. */
export function piso(valor: number, paso: number): number {
  return Math.floor(valor / paso + EPS) * paso;
}

/** Dinero que mueve un lote por cada unidad de precio. El valor del tick es con
 *  lo que liquida el broker, asi que manda ese; el contrato es el respaldo. */
export function porPunto(info: any): number | null {
  const tickSize = num(info.tick_size) || 0.0;
  const tickValue = num(info.tick_value) || 0.0;
  if (tickSize > 0 && tickValue > 0) return tickValue / tickSize;
  const contrato = num(info.contract_size) || 0.0;
  return contrato > 0 ? contrato : null;
}

/** Convierte una distancia de precio a dinero con los datos del simbolo. */
export function riesgo(deltaPrecio: number, info: any, volumen: number): number | null {
  const pp = porPunto(info);
  return pp ? Math.abs(deltaPrecio) * pp * volumen : null;
}

export function pasoMin(info: any): [number, number] {
  const paso = num(info.volume_step) || config.MT5_VOLUME_STEP || 0.01;
  const minimo = num(info.volume_min) || config.MT5_VOLUME_MIN || paso;
  return [paso, minimo];
}

/** Lotes para que la distancia entrada->stop cueste exactamente `riesgoUsd`.
 *  Redondea **hacia abajo** al paso de volumen: el riesgo nunca se pasa. */
export function volumenPorRiesgo(entrada: number, stop: number, info: any, riesgoUsd: number): number | null {
  const pp = porPunto(info);
  const distancia = Math.abs((num(entrada) || 0.0) - (num(stop) || 0.0));
  if (!pp || distancia <= 0 || riesgoUsd <= 0) return null;
  const [paso, minimo] = pasoMin(info);
  const vol = piso(riesgoUsd / (distancia * pp), paso);
  return vol >= minimo - EPS ? redondear(vol, 4) : 0.0;
}

/** Margen que el broker inmoviliza por ese volumen. Si el EA publica
 *  `margin_per_lot` (OrderCalcMargin) se usa ese; si no, nocional por la
 *  fraccion configurada — en cripto FTMO es el nocional completo. */
export function margenRequerido(volumen: number, price: number, info: any): number | null {
  if (volumen <= 0) return 0.0;
  const porLote = num(info.margin_per_lot) || 0.0;
  if (porLote > 0) return porLote * volumen;
  const contrato = num(info.contract_size) || 0.0;
  if (contrato <= 0 || price <= 0) return null;
  const tasa = config.MT5_MARGIN_RATE[String(info.symbol ?? "").toUpperCase()] ?? config.MT5_MARGIN_RATE_DEFAULT;
  return contrato * price * volumen * tasa;
}

// ------------------------------------------------------------ velas del broker

/** Temporalidades de la terminal -> las del puente. */
export const TF_MT5: Record<string, string> = {
  "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D1", "1w": "W1", "1M": "MN1",
};
const SEG: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400 };
const DIA = 86400;

const fmtNY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const memoNY = new Map<number, number>();

/** Diferencia de Nueva York con UTC en ese instante, en segundos (-4 o -5 horas). */
export function desfaseNY(s: number): number {
  const hora = Math.floor(s / 3600);
  let d = memoNY.get(hora);
  if (d === undefined) {
    const p: Record<string, string> = {};
    for (const x of fmtNY.formatToParts(new Date(hora * 3600 * 1000))) p[x.type] = x.value;
    d = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 - hora * 3600) / 900) * 900;
    if (memoNY.size > 100_000) memoNY.clear();
    memoNY.set(hora, d);
  }
  return d;
}

/** El desfase del servidor para cada vela. Casi todos los brokers (FTMO
 *  incluido) cierran el dia a las 17:00 de Nueva York: GMT+2 en el invierno de
 *  EE.UU. y GMT+3 en su verano. Si el desfase de hoy cuadra con eso, cada vela usa
 *  el de su fecha; si no, todas el de hoy. */
export function desfases(offset: number, ahora = Date.now() / 1000): (tServidor: number) => number {
  const cierreNY = Math.abs(offset - (desfaseNY(ahora) + 7 * 3600)) < 60;
  return cierreNY ? (ts) => desfaseNY(ts - offset) + 7 * 3600 : () => offset;
}

/** Velas del puente ([hora del servidor, o, h, l, c, ticks]) en el formato de la
 *  terminal. Las intradia pasan a UTC. Las diarias, semanales y mensuales se
 *  anclan a la medianoche de Nueva York de su fecha, como las de Yahoo: la rueda
 *  del CFD va de 17:00 a 17:00 de Nueva York, y cierran a esa hora. El volumen es
 *  de ticks (el broker no tiene otro) y el comprador se estima con el cierre. */
export function convertirVelas(bars: number[][], interval: string, offset: number, ahoraMs = Date.now()): Candle[] {
  const off = desfases(offset, ahoraMs / 1000);
  const out: Candle[] = [];
  for (const b of bars) {
    const [ts, o, h, l, c] = b;
    if (![ts, o, h, l, c].every(Number.isFinite)) continue;
    let t: number, fin: number;
    if (SEG[interval]) {
      t = ts - off(ts);
      fin = t + SEG[interval];
    } else {
      const f = new Date(ts * 1000);   // la fecha del servidor
      let dia = f.getUTCDate();
      let finSrv = ts + DIA;
      if (interval === "1w") {
        // MT5 abre la semana el domingo; la terminal, el lunes.
        const wd = f.getUTCDay();
        dia += wd === 0 ? 1 : 1 - wd;
        finSrv = ts + 7 * DIA;
      } else if (interval === "1M") {
        finSrv = Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1) / 1000;
      }
      const ancla = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), dia));
      t = medianocheNY(ancla.getUTCFullYear(), ancla.getUTCMonth() + 1, ancla.getUTCDate());
      fin = finSrv - off(finSrv);
    }
    const v = Number(b[5]) || 0;
    const close_time = fin * 1000 - 1;
    out.push({
      t, t_ms: t * 1000, close_time, o, h, l, c, v,
      vb: h > l ? v * (c - l) / (h - l) : v / 2, trades: 0, closed: close_time < ahoraMs,
    });
  }
  return out;
}

interface Historia { mtime: number; offset: number; velas: Candle[] }

/** Velas de 30 minutos con las de 15 (de a dos, en :00 y :30). Se recuerda la ultima
 *  armada: la serie de 15 cambia de objeto solo cuando cambia. */
const armadas30 = new WeakMap<Candle[], Candle[]>();
function armar30(m15: Candle[] | null): Candle[] | null {
  if (!m15?.length) return null;
  let v = armadas30.get(m15);
  if (!v) {
    v = agrupar(m15, "30m");
    const limite = config.HISTORY["30m"] ?? v.length;
    if (v.length > limite) v = v.slice(-limite);
    armadas30.set(m15, v);
  }
  return v;
}

/** Velas del broker que exporta el puente: la historia de cada temporalidad (un
 *  archivo por simbolo y temporalidad) mas las dos ultimas, que llegan cada
 *  segundo en el estado. Solo con el puente vivo: si no, null y la terminal
 *  sigue con su otra fuente. */
export class VelasBroker {
  private bridge: BrokerBridge;
  private historias = new Map<string, Historia>();
  private listado = { at: 0, carpeta: "", nombres: [] as string[] };
  private armadas = new Map<string, { clave: string; velas: Candle[] | null }>();

  constructor(bridge: BrokerBridge) {
    this.bridge = bridge;
  }

  /** El archivo de velas, sin importar mayusculas (US30.CASH -> US30.cash_D1.json). */
  private archivo(carpeta: string, nombre: string): string | null {
    const ahora = Date.now();
    if (this.listado.carpeta !== carpeta || ahora - this.listado.at > 5000) {
      let nombres: string[] = [];
      try { nombres = readdirSync(carpeta); } catch { /* el puente todavia no exporta velas */ }
      this.listado = { at: ahora, carpeta, nombres };
    }
    const n = this.listado.nombres.find((x) => x.toLowerCase() === nombre.toLowerCase());
    return n ? join(carpeta, n) : null;
  }

  private historia(ruta: string, interval: string): Historia | null {
    let mtime: number;
    try { mtime = statSync(ruta).mtimeMs; } catch { return null; }
    const previa = this.historias.get(ruta);
    if (previa && previa.mtime === mtime) return previa;
    try {
      const j = JSON.parse(readFileSync(ruta, "utf8"));
      const offset = Number(j.gmt_offset) || 0;
      const h = { mtime, offset, velas: convertirVelas(j.bars ?? [], interval, offset) };
      this.historias.set(ruta, h);
      return h;
    } catch {
      return previa ?? null;   // a medio escribir: la anterior
    }
  }

  /** La cotizacion del broker de un mercado de la terminal, si el puente la publica. */
  cotizacion(symbol: string): any | null {
    const sym = brokerSymbol(symbol);
    const est = this.bridge.estado();
    if (!sym || !est.available || !est.live) return null;
    return buscar(est.symbols as Record<string, any>, sym) ?? null;
  }

  /** Las velas que exporto el puente para una temporalidad, aunque MT5 este
   *  cerrado (el replay y el backtest trabajan con lo que quedo en el disco). */
  archivoSerie(symbol: string, interval: string): Candle[] | null {
    const tf = TF_MT5[interval];
    const sym = brokerSymbol(symbol);
    const est = this.bridge.estado();
    if (!tf || !sym || !est.path) return null;
    const ruta = this.archivo(join(dirname(est.path), "velas"), `${sym}_${tf}.json`);
    if (!ruta && interval === "30m") return armar30(this.archivoSerie(symbol, "15m"));
    return ruta ? this.historia(ruta, interval)?.velas ?? null : null;
  }

  /** El desfase horario (s) con que exporto el puente las velas de 1 minuto de siempre. */
  desfaseArchivo(symbol: string): number | null {
    const sym = brokerSymbol(symbol);
    const est = this.bridge.estado();
    if (!sym || !est.path) return null;
    const ruta = this.archivo(join(dirname(est.path), "velas"), `${sym}_M1.json`);
    return ruta ? this.historia(ruta, "1m")?.offset ?? null : null;
  }

  /** La serie de `symbol` en `interval` con las velas del broker. */
  serie(symbol: string, interval: string): Candle[] | null {
    const tf = TF_MT5[interval];
    const sym = brokerSymbol(symbol);
    if (!tf || !sym) return null;
    const est = this.bridge.estado();
    if (!est.available || !est.live || !est.velas) return null;
    const ruta = this.archivo(join(dirname(est.path), "velas"), `${sym}_${tf}.json`);
    // El puente sin M30 (InpVelasTF de antes): las de 30 minutos, con las de 15.
    if (!ruta && interval === "30m") return armar30(this.serie(symbol, "15m"));
    const h = ruta ? this.historia(ruta, interval) : null;
    if (!h?.velas.length) return null;

    const k = `${symbol}|${interval}`;
    const clave = `${h.mtime}|${est.mtime}`;
    const previa = this.armadas.get(k);
    if (previa && previa.clave === clave) return previa.velas;

    const ahora = Date.now();
    const serie = h.velas.map((x) => ({ ...x }));
    const vivas = convertirVelas(buscar(est.velas as Record<string, any>, sym)?.[tf] ?? [], interval,
      est.gmt_offset ?? h.offset, ahora);
    // Si a la historia le faltan velas antes de las vivas (el puente estuvo
    // parado), queda un hueco: hasta que la reescriba, mejor la otra fuente.
    const hueco = vivas.length > 0 && vivas[0].t > serie[serie.length - 1].t && ahora - h.mtime > 90_000;
    let velas: Candle[] | null = null;
    if (!hueco) {
      for (const n of vivas) {
        const u = serie[serie.length - 1];
        if (n.t > u.t) serie.push(n);
        else {
          const i = serie.findIndex((x) => x.t === n.t);
          if (i >= 0) serie[i] = n;
        }
      }
      for (const x of serie) x.closed = x.close_time < ahora;
      const limite = config.HISTORY[interval] ?? serie.length;
      velas = serie.length > limite ? serie.slice(-limite) : serie;
    }
    this.armadas.set(k, { clave, velas });
    return velas;
  }

  /** Hora (ms, UTC) de la ultima cotizacion del broker: con el mercado cerrado no
   *  cambia. Los puentes anteriores a la v3 no la mandan: se usa la ultima vela de
   *  1 minuto (solo existe si hubo cotizaciones en ese minuto). */
  ultimaCotizacion(symbol: string): number | null {
    const sym = brokerSymbol(symbol);
    const est = this.bridge.estado();
    if (!sym || !est.available || !est.live) return null;
    const offset = Number(est.gmt_offset) || 0;
    const t = num(this.cotizacion(symbol)?.time);
    if (t) return (t - offset) * 1000;
    const m1 = buscar(est.velas as Record<string, any>, sym)?.M1 as number[][] | undefined;
    const ult = m1?.length ? Number(m1[m1.length - 1][0]) : NaN;
    return Number.isFinite(ult) ? (ult - offset + 59) * 1000 : null;
  }

  /** Precio (el bid, como el grafico de MT5) y variacion contra el cierre de la rueda anterior. */
  ticker(symbol: string): Ticker | null {
    const d = this.serie(symbol, "1d");
    const q = this.cotizacion(symbol);
    if (!d?.length || !q) return null;
    const bid = num(q.bid) || 0;
    const last = bid > 0 ? bid : d[d.length - 1].c;
    const previa = d.length > 1 ? d[d.length - 2] : null;
    return { last, change_pct: previa ? (last - previa.c) / previa.c * 100 : undefined };
  }
}
