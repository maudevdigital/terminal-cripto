/* Order blocks con volumen, con
   reglas fijas:

   1. Estructura: los maximos y minimos de giro (pivotes de LARGO velas cerradas a
      cada lado).
   2. Ruptura (BOS): una vela CIERRA por encima del ultimo maximo de giro sin romper
      (alcista) o por debajo del ultimo minimo (bajista).
   3. El OB: entre el giro y la ruptura, la vela del extremo opuesto (en el alcista,
      la del minimo mas bajo: de ahi salio el impulso). La zona es esa vela; si mide
      mas de 2 ATR, solo su cuerpo y la mecha del lado del OB.
   4. Volumen: el impulso (de la vela del OB a la de la ruptura) tiene que traer al
      menos FUERZA_MIN veces el volumen promedio de las 20 velas anteriores; si no,
      no hay OB. El volumen del OB es el de su vela y las dos siguientes, con la parte
      comprada y la vendida.
   5. Vigencia: se borra cuando una vela cierra al otro lado (invalidado). Si el
      precio vuelve a entrar, queda "probado".
   6. Se muestran los MOSTRAR alcistas y bajistas vivos mas cercanos al precio; de dos
      que se pisan, el de mas volumen. */

export interface VelaOB { time: number; open: number; high: number; low: number; close: number; volume?: number; buy?: number; closed?: boolean }
export interface OrderBlock { t: number; top: number; bot: number; alc: boolean; vol: number; compra: number; fuerza: number | null; probado: boolean }

export const LARGO = 5;
export const FUERZA_MIN = 1.2;
export const MOSTRAR = 3;

/** ATR simple de 14 velas en `i`. */
function atr(a: VelaOB[], i: number): number {
  let s = 0, n = 0;
  for (let k = Math.max(1, i - 13); k <= i; k++) {
    s += Math.max(a[k].high - a[k].low, Math.abs(a[k].high - a[k - 1].close), Math.abs(a[k].low - a[k - 1].close));
    n++;
  }
  return n ? s / n : 0;
}

const vol = (v: VelaOB) => Number(v.volume) || 0;
const compra = (v: VelaOB) => (Number.isFinite(v.buy) ? Number(v.buy) : vol(v) / 2);

/** Velas [{ time, open, high, low, close, volume, buy, closed }] -> los OB vivos
 *  [{ t, top, bot, alc, vol, compra (0 a 1), fuerza, probado }]. */
export function orderBlocks(velas: VelaOB[], { largo = LARGO, fuerzaMin = FUERZA_MIN, mostrar = MOSTRAR } = {}): OrderBlock[] {
  const a = velas.filter((v) => v.closed !== false);
  const n = a.length;
  const vivos: (OrderBlock & { desde: number })[] = [];
  let max: { p: number; i: number } | null = null, min: { p: number; i: number } | null = null;   // el ultimo giro sin romper
  const conVolumen = a.some((v) => vol(v) > 0);

  const crear = (desde: number, i: number, alc: boolean) => {
    // La vela del extremo opuesto entre el giro y la ruptura.
    let k = desde;
    for (let j = desde; j < i; j++) if (alc ? a[j].low < a[k].low : a[j].high > a[k].high) k = j;
    const v = a[k];
    // El impulso contra el promedio de las 20 velas de antes.
    let fuerza: number | null = null;
    if (conVolumen) {
      let antes = 0, nb = 0;
      for (let j = Math.max(0, k - 20); j < k; j++) { antes += vol(a[j]); nb++; }
      let imp = 0;
      for (let j = k; j <= i; j++) imp += vol(a[j]);
      const prom = nb ? antes / nb : 0;
      fuerza = prom > 0 ? imp / (i - k + 1) / prom : null;
      if (fuerza !== null && fuerza < fuerzaMin) return;
    }
    let top = v.high, bot = v.low;
    if (top - bot > 2 * atr(a, k)) {
      if (alc) top = Math.max(v.open, v.close);
      else bot = Math.min(v.open, v.close);
    }
    let vt = 0, vc = 0;
    for (let j = k; j <= Math.min(n - 1, k + 2); j++) { vt += vol(a[j]); vc += compra(a[j]); }
    vivos.push({ t: v.time, top, bot, alc, vol: vt, compra: vt > 0 ? vc / vt : 0.5, fuerza, probado: false, desde: i });
  };

  for (let i = 0; i < n; i++) {
    // Un giro se confirma LARGO velas despues.
    const g = i - largo;
    if (g >= largo) {
      let esMax = true, esMin = true;
      for (let j = g - largo; j <= g + largo; j++) {
        if (j === g) continue;
        if (a[j].high >= a[g].high) esMax = false;
        if (a[j].low <= a[g].low) esMin = false;
      }
      if (esMax) max = { p: a[g].high, i: g };
      if (esMin) min = { p: a[g].low, i: g };
    }
    const v = a[i];
    // Los vivos: invalidados (cierre del otro lado) o probados (el precio volvio a entrar).
    for (let k = vivos.length - 1; k >= 0; k--) {
      const z = vivos[k];
      if (i <= z.desde) continue;
      if (z.alc ? v.close < z.bot : v.close > z.top) { vivos.splice(k, 1); continue; }
      if (z.alc ? v.low <= z.top : v.high >= z.bot) z.probado = true;
    }
    if (max && v.close > max.p) { crear(max.i, i, true); max = null; }
    if (min && v.close < min.p) { crear(min.i, i, false); min = null; }
  }

  // Los mas cercanos al precio, sin pisarse (de dos que se pisan, el de mas volumen).
  const precio = n ? a[n - 1].close : 0;
  const elegir = (alc: boolean) => {
    const lista = vivos.filter((z) => z.alc === alc)
      .sort((x, y) => Math.abs((x.top + x.bot) / 2 - precio) - Math.abs((y.top + y.bot) / 2 - precio));
    const out: typeof vivos = [];
    for (const z of lista) {
      const pisa = out.findIndex((o) => z.bot <= o.top && z.top >= o.bot);
      if (pisa < 0) out.push(z);
      else if (z.vol > out[pisa].vol) out[pisa] = z;
      if (out.length >= mostrar) break;
    }
    return out;
  };
  return [...elegir(true), ...elegir(false)].map(({ desde, ...z }) => z);
}
