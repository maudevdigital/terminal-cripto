import { CAPAS_INICIALES } from "./constants.js";
import { aceptable } from "./temporalidades.js";

const NATIVAS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"];

// Preferencias de la vista, guardadas en el navegador.
const CLAVE = "terminal-cripto:v4";
const CLAVE_ANTERIOR = "terminal-cripto:v3";
export const PERFIL_VISUAL = "swing-v2";

export const PREFS_INICIALES = {
  symbol: null,
  perfilVisual: PERFIL_VISUAL,
  interval: "1h",
  capas: CAPAS_INICIALES,
  completo: false,         // grafico a pantalla completa del navegador (F)
  estacion: null,          // el panel de la derecha ("operar", "lista" o "demo"); cerrado, el grafico manda
  vp: { vpvr: false, vpsv: false, extPoc: false },
  zonas: { fvg: false, ifvg: true, estrSwing: true, estrInterna: false },   // capa FVG: los huecos vivos y los invertidos (IFVG), cada uno aparte
  presentacion: false,     // oculta la cuenta y las operaciones (para grabar videos)
  diseno: "1",             // varios graficos: 1, 2, 2v, 3, 4 o 6
  fijas: ["1w", "1d", "4h", "1h", "15m"],
  paneles: [],             // los graficos extra de la grilla: [{ symbol, interval }]
  sonidos: true,           // suena al ejecutarse una orden, tocar el SL o el TP, cerrar o mover
};

function iniciales() {
  return { ...PREFS_INICIALES, capas: { ...CAPAS_INICIALES }, vp: { ...PREFS_INICIALES.vp }, zonas: { ...PREFS_INICIALES.zonas }, fijas: [...PREFS_INICIALES.fijas], paneles: [] };
}

function leer(almacen, clave) {
  try {
    const p = JSON.parse(almacen?.getItem(clave) || "null");
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  } catch { return null; }
}

export function cargarPrefs(almacen) {
  try {
    almacen ??= globalThis.localStorage;
    const actual = leer(almacen, CLAVE);
    const p = actual ?? leer(almacen, CLAVE_ANTERIOR) ?? {};
    const migrar = !actual || actual.perfilVisual !== PERFIL_VISUAL;
    const capas = { ...CAPAS_INICIALES };
    if (p.capas && typeof p.capas === "object") {
      for (const k of Object.keys(CAPAS_INICIALES)) if (typeof p.capas[k] === "boolean") capas[k] = p.capas[k];
    }
    const prefs = {
      ...iniciales(),
      capas,
      ...(typeof p.symbol === "string" ? { symbol: p.symbol } : {}),
      ...(typeof p.interval === "string" && p.interval ? { interval: p.interval } : {}),
      ...(typeof p.completo === "boolean" ? { completo: p.completo } : {}),
      ...(["operar", "lista", "demo"].includes(p.estacion) ? { estacion: p.estacion } : p.panelAbierto === true ? { estacion: "operar" } : {}),
      // Antes era uno u otro ("vpvr" | "vpsv"); ahora cada uno se prende aparte.
      ...(typeof p.vp === "string" ? { vp: { vpvr: p.vp !== "vpsv", vpsv: p.vp === "vpsv" } }
        : p.vp && typeof p.vp === "object" ? { vp: { vpvr: Boolean(p.vp.vpvr), vpsv: Boolean(p.vp.vpsv), extPoc: Boolean(p.vp.extPoc) } } : {}),
      ...(p.zonas && typeof p.zonas === "object" ? { zonas: { fvg: p.zonas.fvg !== false, ifvg: p.zonas.ifvg !== false, estrSwing: p.zonas.estrSwing !== false, estrInterna: p.zonas.estrInterna === true } } : {}),
      ...(typeof p.presentacion === "boolean" ? { presentacion: p.presentacion } : {}),
      ...(["1", "2", "2v", "3", "4", "6"].includes(p.diseno) ? { diseno: p.diseno } : {}),
      ...(Array.isArray(p.fijas) ? { fijas: [...new Set(p.fijas.filter((x) => typeof x === "string" && aceptable(x, NATIVAS)))].slice(0, 12) } : {}),
      ...(Array.isArray(p.paneles) ? { paneles: p.paneles.filter((x) => typeof x?.symbol === "string" && typeof x?.interval === "string").slice(0, 5) } : {}),
      ...(typeof p.sonidos === "boolean" ? { sonidos: p.sonidos } : {}),
      ...(Array.isArray(p.apal) && p.apal.length && p.apal.every((x) => Number(x) > 0) ? { apal: p.apal.map(Number) } : {}),
    };
    if (actual?.perfilVisual === "swing-v1") {
      // Desde swing-v1 solo se prende el IFVG: lo demas ya lo eligio quien usa la terminal.
      prefs.capas.fvg = true;
      prefs.zonas = { ...prefs.zonas, fvg: false, ifvg: true };
      prefs.perfilVisual = PERFIL_VISUAL;
      guardarPrefs(prefs, almacen);
    } else if (migrar) {
      // Cambiar de perfil visual una sola vez. Mercado, sonidos, estaciones y
      // grilla se conservan; los dibujos viven en sus propias claves.
      const nuevo = iniciales();
      Object.assign(prefs, { perfilVisual: PERFIL_VISUAL, interval: nuevo.interval, capas: nuevo.capas, vp: nuevo.vp, zonas: nuevo.zonas, fijas: nuevo.fijas });
      guardarPrefs(prefs, almacen);
    }
    return prefs;
  } catch {
    return iniciales();
  }
}

export function guardarPrefs(p, almacen) {
  try {
    almacen ??= globalThis.localStorage;
    almacen?.setItem(CLAVE, JSON.stringify({ ...p, perfilVisual: PERFIL_VISUAL }));
  } catch { /* sin almacenamiento: solo se pierde la preferencia */ }
}
