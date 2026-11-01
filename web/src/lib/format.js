// Formatos numericos y de fecha. Los decimales del activo en pantalla se
// detectan al llegar cada snapshot del principal; cada gráfico guarda los suyos.

let decimals = 2;

export function setDecimals(d) {
  if (Number.isInteger(d) && d >= 0 && d <= 20) decimals = d;
}

export function getDecimals() {
  return decimals;
}

const vacio = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v));

// Un formateador por cantidad de decimales: el grafico formatea muchos precios en
// cada cuadro y crear uno nuevo cada vez (toLocaleString) lo hace mas lento.
const formatos = new Map();
function formato(d) {
  let f = formatos.get(d);
  if (!f) {
    f = new Intl.NumberFormat("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });
    formatos.set(d, f);
  }
  return f;
}

export const fmt = (v, d = decimals) => (vacio(v) ? "—" : formato(d).format(Number(v)));

export const fmtNum = (v, d = 2) => (vacio(v) ? "—" : formato(d).format(Number(v)));

export const money = (v, d = 2) => (v === null || v === undefined ? "—" : fmtNum(v, d));

export function fmtVol(v) {
  if (vacio(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(2);
}

export function fmtDur(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
}

export const utcFmt = new Intl.DateTimeFormat("es-CL", {
  timeZone: "UTC", weekday: "short", day: "2-digit", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export const localFmt = new Intl.DateTimeFormat("es-CL", {
  weekday: "short", day: "2-digit", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function detectDecimals(candles) {
  let d = 0;
  for (const c of candles.slice(-200)) {
    for (const v of [c.open, c.high, c.low, c.close]) {
      // toFixed(8) borra la basura de coma flotante (28763.750000000004 -> 28763.75).
      if (!Number.isFinite(Number(v))) continue;
      const fraccion = Number(v).toFixed(8).split(".")[1]?.replace(/0+$/, "") ?? "";
      d = Math.max(d, fraccion.length);
    }
  }
  // Yahoo manda floats con ruido (1.1208249330520630): no mas decimales que los
  // que tiene sentido para el precio (EUR/USD 5, USD/JPY 3, indices 2).
  const p = Math.abs(Number(candles.at(-1)?.close) || 0);
  const tope = p >= 1000 ? 2 : p >= 100 ? 3 : p >= 10 ? 4 : p >= 0.5 ? 5 : p >= 0.01 ? 6 : 8;
  return Math.min(Math.max(d, 2), tope);
}

/** Signo explicito para variaciones: "+1,23" o "-1,23". */
export const signed = (v, d = 2) => `${v >= 0 ? "+" : ""}${fmtNum(v, d)}`;
