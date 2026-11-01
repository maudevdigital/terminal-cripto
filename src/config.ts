/* Configuracion del terminal. Todo se puede sobrescribir desde el .env.
 *
 * Es un objeto mutable a proposito: los modulos leen `config.X` en el momento
 * de usarlo, y los tests pueden cambiar un valor sin recargar nada. */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Las variables que ya estan en el entorno mandan sobre el .env.
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = (name: string): string | undefined => process.env[name];

function int(name: string, def: number): number {
  const v = env(name);
  if (v === undefined) return def;
  return /^\s*[+-]?\d+\s*$/.test(v) ? parseInt(v, 10) : def;
}

function float(name: string, def: number): number {
  const v = env(name);
  if (v === undefined || v.trim() === "") return def;
  const x = Number(v.trim());
  return Number.isNaN(x) ? def : x;
}

const str = (name: string, def: string): string => env(name) ?? def;
const bool = (name: string, def: boolean): boolean => {
  const v = env(name);
  return v === undefined ? def : v.trim().toLowerCase() !== "false";
};

function mapa(name: string, def: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const par of str(name, def).split(",")) {
    const i = par.indexOf(":");
    if (i >= 0) out[par.slice(0, i).trim().toUpperCase()] = par.slice(i + 1).trim().toUpperCase();
  }
  return out;
}

function mapaNum(name: string, def: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const par of str(name, def).split(",")) {
    const i = par.indexOf(":");
    if (i < 0) continue;
    const v = Number(par.slice(i + 1).trim());
    if (par.slice(i + 1).trim() !== "" && !Number.isNaN(v)) out[par.slice(0, i).trim().toUpperCase()] = v;
  }
  return out;
}

export const config = {
  // La data de mercado es publica: la app funciona sin claves.
  BINANCE_API_KEY: str("BINANCE_API_KEY", ""),
  // Con la clave secreta, la terminal muestra y opera tu cuenta de futuros USDⓈ-M
  // (src/binanceCuenta.ts). La clave: con futuros, SIN retiros y con IP restringida.
  BINANCE_API_SECRET: str("BINANCE_API_SECRET", ""),
  BINANCE_TRADING: bool("BINANCE_TRADING", false),            // apagado: solo mirar
  BINANCE_SL_OBLIGATORIO: bool("BINANCE_SL_OBLIGATORIO", true),
  REST_BASE: str("BINANCE_REST_BASE", "https://api.binance.com"),
  WS_BASE: str("BINANCE_WS_BASE", "wss://stream.binance.com:9443"),

  FUTURES_REST: str("BINANCE_FUTURES_REST", "https://fapi.binance.com"),
  // Los streams de mercado del perpetuo viven en /market: la URL de siempre
  // conecta pero ya no manda nada.
  FUTURES_WS: str("BINANCE_FUTURES_WS", "wss://fstream.binance.com/market"),

  // Cripto de Binance. Cada una necesita su perpetuo en Binance Futures para el
  // mapa de liquidacion y el open interest.
  SYMBOLS: str("SYMBOLS", "BTCUSDT")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),

  // Indices: nombre en la terminal -> simbolo de Yahoo Finance. Por defecto los
  // futuros de CME, que cotizan casi 24 horas como los CFD del broker.
  // Lo que sale de Yahoo Finance: los indices (futuros de CME) y USD/CLP (divisa).
  INDICES: mapa("INDICES", "US30:YM=F,US100:NQ=F,US500:ES=F,USOIL:CL=F,USDCLP:CLP=X"),
  INDICES_CADA: float("INDICES_CADA", 15),      // segundos entre lecturas en vivo
  // Perpetuos de Binance sin mercado spot (TradFi): el oro. Sus velas salen del perpetuo.
  PERPETUOS: str("PERPETUOS", "XAUUSDT")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),

  // Temporalidades, de la mayor a la menor: el orden del flujo.
  // "1M" es mensual (asi lo llama Binance) y "1m" un minuto.
  INTERVALS: ["1M", "1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"],
  INTERVAL_LABELS: {
    "1M": "Mensual", "1w": "Semanal", "1d": "Diario", "4h": "4H", "1h": "1H", "30m": "30m", "15m": "15m", "5m": "5m", "1m": "1m",
  } as Record<string, string>,
  // Velas por temporalidad. Para que las medias den lo mismo que TradingView hace
  // falta historia: la EMA 200 arrastra su arranque durante unas 1.400 velas. Con
  // 1.500 ya no se nota; semanal y mensual cubren toda la historia de Binance
  // (la misma desde la que calcula TradingView).
  HISTORY: {
    "1M": int("HISTORY_MES", 200),
    "1w": int("HISTORY_1W", 500),
    "1d": int("HISTORY_1D", 1500),
    "4h": int("HISTORY_4H", 1500),
    "1h": int("HISTORY_1H", 1500),
    "30m": int("HISTORY_30M", 1500),
    "15m": int("HISTORY_15M", 1500),
    "5m": int("HISTORY_5M", 1500),
    "1m": int("HISTORY_1M", 1500),
  } as Record<string, number>,

  // --- indicadores (los mismos valores que en TradingView)
  EMA_FAST: int("EMA_FAST", 10),
  EMA_SLOW: int("EMA_SLOW", 50),
  EMA_LARGA: int("EMA_LARGA", 200),
  ADX_DI_LENGTH: int("ADX_DI_LENGTH", 14),
  ADX_SMOOTHING: int("ADX_SMOOTHING", 14),
  ADX_CLAVE: float("ADX_CLAVE", 23),          // nivel desde el que hay tendencia
  SQZ_BB_LENGTH: int("SQZ_BB_LENGTH", 20),
  SQZ_BB_MULT: float("SQZ_BB_MULT", 2.0),
  SQZ_KC_LENGTH: int("SQZ_KC_LENGTH", 20),
  SQZ_KC_MULT: float("SQZ_KC_MULT", 1.5),
  SQZ_USE_TRUE_RANGE: bool("SQZ_USE_TRUE_RANGE", true),

  VP_FILAS: int("VP_FILAS", 24),               // filas de los perfiles de volumen (24: lo de TradingView)

  // El mercado del replay: el que tiene la historia larga del puente.
  REPLAY_SIMBOLO: str("REPLAY_SIMBOLO", "US100").trim().toUpperCase(),
  // Riesgo por operacion que propone Operar: lo que queda hasta el limite de la cuenta
  // de fondeo repartido en RIESGO_AGUANTAR SL seguidos (sube con las ganancias, baja
  // con las perdidas), como mucho RIESGO_PCT del balance. RIESGO_AGUANTAR=0: solo el %.
  RIESGO_PCT: float("RIESGO_PCT", 0.5),
  RIESGO_AGUANTAR: int("RIESGO_AGUANTAR", 0),
  // Freno de disciplina (src/freno.ts): al perder FRENO_PERDIDA_DIA_USD en el dia de
  // la firma (o FRENO_PERDIDA_DIA_PCT del balance, si no hay tope en USD), tras
  // FRENO_PERDIDAS perdidas seguidas o al llegar a FRENO_OPERACIONES, no se abre mas
  // hasta el dia siguiente (FRENO_MODO=bloquear) o solo se avisa (avisar). 0 apaga la
  // regla: por defecto, solo el tope de 30 USD.
  FRENO_PERDIDA_DIA_USD: float("FRENO_PERDIDA_DIA_USD", 30),
  // Corte automatico (src/corte.ts): lo que este abierto sin SL (en MT5 o en Binance)
  // recibe un SL en la perdida de CORTE_AUTO_USD (si ya la paso, no se toca). 0 lo apaga.
  CORTE_AUTO_USD: float("CORTE_AUTO_USD", 30),
  // Donde estan los .wav de NinjaTrader (vacio: sonidos/ del proyecto o la instalacion de NinjaTrader 8).
  SONIDOS_CARPETA: str("SONIDOS_CARPETA", ""),
  // La voz de NinjaTrader: vacio en ingles; es-ES en castellano (o de-DE, fr-FR, it-IT, pt-PT...).
  SONIDOS_IDIOMA: str("SONIDOS_IDIOMA", ""),
  FRENO_PERDIDAS: int("FRENO_PERDIDAS", 0),
  FRENO_OPERACIONES: int("FRENO_OPERACIONES", 2),
  // Minutos sin abrir despues de cada salida. 0 lo apaga.
  FRENO_PAUSA_MIN: int("FRENO_PAUSA_MIN", 0),
  // El SL inicial es el techo: no se puede ampliar, y lo ampliado en MT5 vuelve a su lugar.
  FRENO_SL_INICIAL: bool("FRENO_SL_INICIAL", false),
  // Minutos que tarda en quitarse la pausa de la cuenta real despues de pedirlo.
  FRENO_PAUSA_SALIR_MIN: int("FRENO_PAUSA_SALIR_MIN", 10),
  FRENO_PERDIDA_DIA_PCT: float("FRENO_PERDIDA_DIA_PCT", 0),
  FRENO_MODO: (str("FRENO_MODO", "bloquear").trim().toLowerCase() === "avisar" ? "avisar" : "bloquear") as "avisar" | "bloquear",
  // Con el freno bloqueando, lo que se abre directo en MT5 (o en el celular): cancelar
  // (cancela las limite), avisar (solo en el registro) o no (nada). Las posiciones
  // nunca se cierran.
  FRENO_MT5: ((v) => (["cancelar", "avisar"].includes(v) ? v : "no"))(str("FRENO_MT5", "no").trim().toLowerCase()) as "cancelar" | "avisar" | "no",  // velas a cada lado de un giro, en la capa de estructura

  // Temporalidad con la que arranca la vista, hasta que el navegador pide la suya.
  GATILLO_TF: str("GATILLO_TF", "1h"),

  // --- puente MT5 (solo lectura: cuenta, posiciones, cotizaciones y velas del broker)
  // Abrir MT5 con el puente al arrancar (Windows). MT5_TERMINAL: el terminal64.exe
  // a usar si hay mas de una instalacion.
  MT5_LANZAR: bool("MT5_LANZAR", true),
  MT5_TERMINAL: str("MT5_TERMINAL", "").trim(),
  // Velas de los indices desde MT5 (las del CFD del broker, en vivo) en vez de Yahoo.
  MT5_VELAS: bool("MT5_VELAS", true),
  // Panel Operar: mandar ordenes a MT5 por el EA CriptoTerminalOperador (cada una
  // con confirmacion; el EA solo opera la cuenta de su InpCuenta). Apagado por defecto.
  TRADING_ACTIVO: bool("TRADING_ACTIVO", false),
  MT5_STATE_FILE: str("MT5_STATE_FILE", ""),
  OPERADOR_MAGIC: int("OPERADOR_MAGIC", 770100),   // InpMagic del EA operador: marca lo abierto desde la terminal
  MT5_ACCOUNT: str("MT5_ACCOUNT", "").trim(),
  MT5_MAX_AGE: float("MT5_MAX_AGE", 15.0),
  MT5_ACCOUNT_EQUITY: float("MT5_ACCOUNT_EQUITY", 10000.0),
  MT5_MARGIN_RATE_DEFAULT: float("MT5_MARGIN_RATE_DEFAULT", 1.0),
  MT5_VOLUME_STEP: float("MT5_VOLUME_STEP", 0.01),
  MT5_VOLUME_MIN: float("MT5_VOLUME_MIN", 0.01),
  // Los indices van siempre (en FTMO son US30.cash y compania); el .env los pisa.
  MT5_SYMBOL_MAP: {
    US30: "US30.CASH", US100: "US100.CASH", US500: "US500.CASH", USOIL: "USOIL.CASH", XAUUSDT: "XAUUSD",
    ...mapa("MT5_SYMBOL_MAP", "BTCUSDT:BTCUSD,ETHUSDT:ETHUSD,ADAUSDT:ADAUSD,XLMUSDT:XLMUSD,XRPUSDT:XRPUSD"),
  } as Record<string, string>,
  MT5_CONTRACT_SIZE: mapaNum("MT5_CONTRACT_SIZE",
    "ADAUSD:100000,XLMUSD:100000,XRPUSD:10000,BTCUSD:1,ETHUSD:10"),
  MT5_MARGIN_RATE: mapaNum("MT5_MARGIN_RATE", ""),

  // --- USDT.D reconstruida con CoinGecko (gratis, sin clave)
  USDTD_ACTIVA: bool("USDTD_ACTIVA", true),
  // Clave "demo" gratuita de CoinGecko (coingecko.com/en/api): sube bastante el
  // limite de llamadas. Sin clave tambien funciona, solo que carga mas lento.
  COINGECKO_API_KEY: str("COINGECKO_API_KEY", "").trim(),
  USDTD_CADA: float("USDTD_CADA", 180),       // segundos entre lecturas en vivo
  USDTD_MONEDAS: str("USDTD_MONEDAS",
    "bitcoin,ethereum,tether,ripple,binancecoin,solana,usd-coin,dogecoin,cardano,tron")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // --- cuenta de fondeo: limites de perdida para la cabina de riesgo (FTMO por defecto)
  // Balance con que se dio la cuenta. 0: el primer deposito del historial de MT5.
  PROP_BALANCE_INICIAL: float("PROP_BALANCE_INICIAL", 0),
  PROP_DIARIA_PCT: float("PROP_DIARIA_PCT", 5),    // perdida maxima del dia, % del balance inicial (0 = sin limite)
  PROP_MAXIMA_PCT: float("PROP_MAXIMA_PCT", 10),   // perdida maxima total, % del balance inicial (0 = sin limite)
  PROP_ZONA: str("PROP_ZONA", "Europe/Prague").trim(),   // el dia de la firma corta a medianoche de esta zona

  // --- historial en Google Sheets, con una cuenta de servicio (ver README)
  GOOGLE_CREDENCIALES: str("GOOGLE_CREDENCIALES", "").trim(),   // ruta al JSON de la cuenta de servicio
  SHEETS_ID: str("SHEETS_ID", "").trim(),                       // id de la planilla (esta en su URL)
  SHEETS_CADA: float("SHEETS_CADA", 60),                         // segundos minimos entre sincronizaciones


  // Carpeta de datos persistentes (la historia de USDT.D, entre otros).
  DATOS: str("DATOS_DIR", join(ROOT, "datos")),

  PUSH_INTERVAL: float("PUSH_INTERVAL", 0.4),      // segundos entre envios al navegador
  RESYNC_SECONDS: int("RESYNC_SECONDS", 180),

  HOST: str("HOST", "127.0.0.1"),
  // Nombres desde los que tambien se puede usar la terminal entera (Historial, Operar):
  // la direccion de Tailscale Serve, p. ej. "mi-pc.tailnet.ts.net". Separados por coma.
  ACCESO_REMOTO: str("ACCESO_REMOTO", "").split(",").map((s) => s.trim()).filter(Boolean),
  PORT: int("PORT", 8787),
  ABRIR_NAVEGADOR: bool("ABRIR_NAVEGADOR", true),
};

export type Tipo = "cripto" | "indice" | "materia" | "divisa";
/** De donde sale cada mercado. */
export interface Mercado { nombre: string; tipo: Tipo; fuente: string }

// Como se muestran los perpetuos de materias primas.
const NOMBRES: Record<string, string> = { XAUUSDT: "ORO", XAGUSDT: "PLATA", COPPERUSDT: "COBRE", USOIL: "PETRÓLEO" };
// Las divisas de Yahoo (su codigo termina en =X): USDCLP -> USD/CLP.
export const esDivisa = (symbol: string) => /=X$/i.test(config.INDICES[symbol] ?? "");
const nombreDivisa = (s: string) => (/^[A-Z]{6}$/.test(s) ? `${s.slice(0, 3)}/${s.slice(3)}` : s);

/** Que es cada simbolo de la terminal y de donde sale su data. */
export function mercados(): Record<string, Mercado> {
  const out: Record<string, Mercado> = {};
  for (const s of config.SYMBOLS) {
    out[s] = { nombre: s.replace(/USDT$/, ""), tipo: "cripto", fuente: "Binance" };
  }
  for (const [s, y] of Object.entries(config.INDICES)) {
    out[s] = esDivisa(s) ? { nombre: nombreDivisa(s), tipo: "divisa", fuente: y } : { nombre: NOMBRES[s] ?? s, tipo: "indice", fuente: y };
  }
  for (const s of config.PERPETUOS) {
    out[s] = { nombre: NOMBRES[s] ?? s.replace(/USDT$/, ""), tipo: "materia", fuente: `${s} perpetuo` };
  }
  return out;
}

/** Los mercados que salen de Yahoo Finance: simbolo -> Yahoo. */
export const yahoo = (): Record<string, string> => ({ ...config.INDICES });
export const esYahoo = (symbol: string) => Object.hasOwn(yahoo(), symbol);
export const esPerpetuo = (symbol: string) => config.PERPETUOS.includes(symbol);

/** Lo que necesita la interfaz (nunca incluye credenciales). */
export function publicConfig() {
  return {
    // Cripto, indices, materias primas y al final las divisas.
    symbols: [...config.SYMBOLS, ...Object.keys(yahoo()).filter((s) => !esDivisa(s)), ...config.PERPETUOS,
      ...Object.keys(yahoo()).filter(esDivisa)],
    mercados: mercados(),
    intervals: config.INTERVALS,
    interval_labels: config.INTERVAL_LABELS,
    replay_simbolo: config.REPLAY_SIMBOLO,
    riesgo_pct: config.RIESGO_PCT,
    // Lo que el replay necesita para correr los indicadores en el navegador.
    indicadores: {
      adx: [config.ADX_DI_LENGTH, config.ADX_SMOOTHING],
      sqz: [config.SQZ_BB_LENGTH, config.SQZ_BB_MULT, config.SQZ_KC_LENGTH, config.SQZ_KC_MULT, config.SQZ_USE_TRUE_RANGE],
    },
    ema: [config.EMA_FAST, config.EMA_SLOW, config.EMA_LARGA],
    adx_clave: config.ADX_CLAVE,
    vp_filas: config.VP_FILAS,
    trading: config.TRADING_ACTIVO,
    mt5_simbolos: config.MT5_SYMBOL_MAP,   // simbolo de la terminal -> del broker
    usdtd: config.USDTD_ACTIVA ? { symbol: "USDT.D", intervals: ["1d", "4h", "1h"] } : null,
  };
}
