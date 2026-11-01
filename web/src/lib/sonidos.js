/* Los sonidos de la operativa: los de NinjaTrader (sus .wav, si estan en esta PC; ver
   sonidos/LEEME.md) y, para lo que falte, tonos propios hechos con Web Audio. Uno para
   cada cosa que les pasa a las operaciones; si en la misma vuelta pasan varias, suena
   la mas importante. El navegador no deja sonar hasta que se toca la pagina: el
   contexto se abre con el primer clic o tecla. */

let ctx = null;

// Cada cosa, con su sonido de NinjaTrader (el primero que haya). NinjaTrader 8 no trae
// PositionClosed: al cerrar a mano suena OrderFilled, como en NinjaTrader.
const NINJA = {
  abierta: ["OrderFilled"], parcial: ["OrderFilled"], sl: ["StopFilled"], tp: ["TargetFilled"],
  cerrada: ["PositionClosed", "OrderFilled"], pendiente: ["OrderPending"], modificada: ["OrderPending"], cancelada: ["OrderCanceled"],
};
const archivos = {};   // nombre de NinjaTrader -> AudioBuffer ya decodificado

function contexto() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function prepararSonidos() {
  const abrir = () => { contexto(); };
  window.addEventListener("pointerdown", abrir, { once: true });
  window.addEventListener("keydown", abrir, { once: true });
  void cargarNinja();
}

/** Baja y decodifica los .wav de NinjaTrader que tenga el servidor. */
async function cargarNinja() {
  try {
    const { disponibles = [] } = await fetch("/api/sonidos").then((r) => r.json());
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !disponibles.length) return;
    ctx ??= new AC();   // decodificar no necesita el clic; sonar si
    await Promise.all(disponibles.map(async (n) => {
      try {
        const datos = await fetch(`/api/sonidos/${n}`).then((r) => (r.ok ? r.arrayBuffer() : null));
        if (datos) archivos[n] = await ctx.decodeAudioData(datos);
      } catch { /* ese queda con el tono propio */ }
    }));
  } catch { /* sin el servidor: los tonos propios */ }
}

function nota(c, t0, frec, dur, { tipo = "sine", vol = 0.18, hasta = null } = {}) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = tipo;
  o.frequency.setValueAtTime(frec, t0);
  if (hasta) o.frequency.exponentialRampToValueAtTime(hasta, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

// [inicio s, frecuencia Hz, duracion s, opciones]
const SONIDOS = {
  abierta: [[0, 880, 0.12], [0.09, 1318.5, 0.24]],                                   // ejecutada: dos notas que suben
  tp: [[0, 1046.5, 0.14], [0.1, 1318.5, 0.14], [0.2, 1568, 0.36]],                   // TP: arpegio brillante
  sl: [[0, 440, 0.2, { tipo: "triangle", vol: 0.24 }], [0.17, 311.1, 0.38, { tipo: "triangle", vol: 0.24 }]],   // SL: dos notas que bajan
  cerrada: [[0, 659.3, 0.1], [0.08, 523.3, 0.22]],                                   // cerrada a mano
  parcial: [[0, 659.3, 0.16]],
  modificada: [[0, 1567, 0.05, { vol: 0.12 }]],                                      // SL o TP movido: un clic
  pendiente: [[0, 784, 0.08, { vol: 0.12 }], [0.07, 988, 0.1, { vol: 0.12 }]],
  cancelada: [[0, 392, 0.14, { vol: 0.12, hasta: 330 }]],
};

const PRIORIDAD = ["sl", "tp", "cerrada", "abierta", "parcial", "modificada", "pendiente", "cancelada"];

export function sonar(tipo) {
  const notas = SONIDOS[tipo];
  const c = notas && contexto();
  if (!c || c.state !== "running") return;
  const wav = NINJA[tipo].map((n) => archivos[n]).find(Boolean);
  if (wav) {
    const fuente = c.createBufferSource();
    fuente.buffer = wav;
    fuente.connect(c.destination);
    fuente.start();
    return;
  }
  const t = c.currentTime + 0.01;
  for (const [ini, frec, dur, op] of notas) nota(c, t + ini, frec, dur, op);
}

/** De varias ejecuciones juntas, la que mas importa. */
export function sonarLote(ejecuciones) {
  const tipos = new Set(ejecuciones.map((e) => e.tipo));
  const tipo = PRIORIDAD.find((t) => tipos.has(t));
  if (tipo) sonar(tipo);
}
