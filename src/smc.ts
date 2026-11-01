/* Estructura de mercado y order blocks,
   con reglas fijas, iguales para todos los instrumentos y temporalidades.

   ESTRUCTURA, en dos niveles: la INTERNA (giros de 5 velas) y la SWING (50 velas).
   1. Giros que alternan: un tramo bajista empieza cuando una vela tiene el maximo
      mas alto de las `n` que le siguen (ese maximo es un giro alto); uno alcista,
      cuando tiene el minimo mas bajo (giro bajo). Como el tramo solo cambia de un
      lado al otro, nunca hay dos maximos seguidos sin un minimo entre medio. Con un
      doble techo (dos maximos iguales), el giro es el segundo.
   2. Cada giro se nombra contra el anterior del mismo lado: HH / LH, HL / LL.
   3. Ruptura: una vela CIERRA mas alla del ultimo giro sin romper. A favor de la
      tendencia es BOS; contra ella, CHoCH (cambio de caracter). Una ruptura interna
      en el mismo nivel que el giro swing no se cuenta dos veces.
   4. Maximo y minimo "fuerte" o "debil": el extremo del tramo swing actual. En
      tendencia bajista el maximo es fuerte (de ahi salio la caida) y el minimo
      debil (el objetivo); al reves en la alcista.

   ORDER BLOCKS: nacen de cada ruptura (de los dos niveles).
   5. El OB es la vela del extremo opuesto entre el giro roto y la ruptura (en el
      alcista, la del minimo mas bajo: de ahi salio el impulso). Si mide mas de 2 ATR,
      la zona es su cuerpo y la mecha del lado del OB.
   6. Filtros descriptivos (no una probabilidad de acierto):
      - desplazamiento: lo que se movio del extremo del OB al cierre de la ruptura,
        en ATR (el ATR de 50 velas lo vuelve comparable entre instrumentos);
      - FVG: si el impulso dejo un hueco (vela 1 y vela 3 sin tocarse);
      - volumen relativo: las 3 velas que salen del OB (el desplazamiento; no todo el
        tramo hasta la ruptura, que en diario son semanas y diluye el promedio), cada
        una contra la MEDIANA de las velas de la
        MISMA HORA UTC de hasta 20 dias anteriores (en intradia; no se corrige aqui
        la hora local de la sesion cuando cambia el horario de verano);
        en diario o mas, contra la mediana de las 50 anteriores. La mediana no la
        mueve un pico suelto. En los indices de MT5 el volumen es de ticks; donde no
        hay volumen (USDT.D) no se usa.
      Un OB vale si tuvo desplazamiento (FVG o al menos DESPLAZ_MIN ATR) y, si hay
      volumen, al menos VOL_MIN veces lo normal. Si no, no se marca.
   7. Vigencia: se borra cuando una vela cierra al otro lado. Si el precio vuelve a
      entrar, queda "probado" (mitigado).
   8. Se muestran los vivos mas cercanos al precio: MOSTRAR swing y MOSTRAR_INT
      internos por lado; de dos que se pisan, el swing (o el de mas volumen). */

export interface VelaSMC { time: number; open: number; high: number; low: number; close: number; volume?: number; buy?: number; closed?: boolean }
export type Nivel = "swing" | "interna";
export interface Giro { t: number; p: number; alto: boolean; tipo: "HH" | "LH" | "HL" | "LL" | "H" | "L"; nivel: Nivel }
export interface Ruptura { tipo: "BOS" | "CHoCH"; alc: boolean; nivel: Nivel; precio: number; t0: number; t1: number }
export interface OrderBlock {
  t: number; top: number; bot: number; alc: boolean; nivel: Nivel;
  vol: number; compra: number;          // volumen de la vela del OB y las dos siguientes, y la parte comprada (0 a 1)
  fuerza: number | null;                // volumen relativo del impulso (null: sin volumen)
  desplaz: number; fvg: boolean;        // desplazamiento en ATR y si dejo un FVG
  probado: boolean; t1: number;         // mitigado; la vela de la ruptura
}
export interface Extremo { p: number; t: number; fuerte: boolean }
export interface SMC {
  giros: Giro[]; rupturas: Ruptura[]; obs: OrderBlock[];
  alto: Extremo | null; bajo: Extremo | null;
  tendencia: { swing: 1 | 0 | -1; interna: 1 | 0 | -1 };
}

export const SWING = 50, INTERNA = 5;
export const DESPLAZ_MIN = 2.5, VOL_MIN = 1, ATR_N = 50;
export const MOSTRAR = 3, MOSTRAR_INT = 2;

const vol = (v: VelaSMC) => Number(v.volume) || 0;
const compra = (v: VelaSMC) => (Number.isFinite(v.buy) ? Number(v.buy) : vol(v) / 2);

interface Lado { cur: number; prev: number; i: number; roto: boolean }
interface Estado { n: Nivel; largo: number; tramo: 0 | 1; alto: Lado; bajo: Lado; tendencia: 1 | 0 | -1 }
const lado = (): Lado => ({ cur: NaN, prev: NaN, i: -1, roto: true });

export function smc(velas: VelaSMC[], {
  swing = SWING, interna = INTERNA, desplazMin = DESPLAZ_MIN, volMin = VOL_MIN, mostrar = MOSTRAR, mostrarInt = MOSTRAR_INT,
} = {}): SMC {
  const a = velas.filter((v) => v.closed !== false);
  const n = a.length;
  // La ventana no depende de cuanta historia este cargada. Con pocas velas se
  // espera la confirmacion; ampliarla no debe cambiar el periodo de giros pasados.
  const niveles: Estado[] = [
    { n: "interna", largo: interna, tramo: 0, alto: lado(), bajo: lado(), tendencia: 0 },
    { n: "swing", largo: swing, tramo: 0, alto: lado(), bajo: lado(), tendencia: 0 },
  ];
  const [int, sw] = niveles;
  const giros: Giro[] = [], rupturas: Ruptura[] = [];
  const vivos: (OrderBlock & { desde: number })[] = [];
  const conVolumen = a.some((v) => vol(v) > 0);

  // ATR (media del rango verdadero de ATR_N velas), acumulado.
  const tr = a.map((v, i) => (i ? Math.max(v.high - v.low, Math.abs(v.high - a[i - 1].close), Math.abs(v.low - a[i - 1].close)) : v.high - v.low));
  const acum = [0];
  for (const x of tr) acum.push(acum[acum.length - 1] + x);
  const atr = (i: number) => { const d = Math.max(0, i - ATR_N + 1); return (acum[i + 1] - acum[d]) / (i + 1 - d) || 0; };

  const rv = conVolumen ? volumenRelativo(a) : a.map(() => NaN);

  // El extremo del tramo swing actual (para fuerte/debil).
  let techo: { p: number; t: number } | null = null, piso: { p: number; t: number } | null = null;

  const crear = (desde: number, i: number, alc: boolean, nivel: Nivel) => {
    let k = desde;
    for (let j = desde; j < i; j++) if (alc ? a[j].low < a[k].low : a[j].high > a[k].high) k = j;
    const v = a[k], at = atr(i) || atr(k) || 1;
    const desplaz = (alc ? a[i].close - v.low : v.high - a[i].close) / at;
    let fvg = false;
    for (let j = k + 2; j <= i && !fvg; j++) fvg = alc ? a[j].low > a[j - 2].high : a[j].high < a[j - 2].low;
    let fuerza: number | null = null;
    if (conVolumen) {
      // Las velas que salen del OB (el desplazamiento): las 3 siguientes, sin pasar la ruptura.
      const xs = rv.slice(k + 1, Math.min(i, k + 3) + 1).filter(Number.isFinite);
      fuerza = xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
    }
    if (!fvg && desplaz < desplazMin) return;
    if (fuerza !== null && fuerza < volMin) return;
    let top = v.high, bot = v.low;
    if (top - bot > 2 * (atr(k) || at)) { if (alc) top = Math.max(v.open, v.close); else bot = Math.min(v.open, v.close); }
    let vt = 0, vc = 0;
    for (let j = k; j <= Math.min(i, k + 2); j++) { vt += vol(a[j]); vc += compra(a[j]); }
    vivos.push({ t: v.time, top, bot, alc, nivel, vol: vt, compra: vt > 0 ? vc / vt : 0.5, fuerza, desplaz, fvg, probado: false, t1: a[i].time, desde: i });
  };

  for (let i = 0; i < n; i++) {
    const v = a[i];
    // 1. Giros de cada nivel (se confirman `largo` velas despues).
    for (const e of niveles) {
      const c = i - e.largo;
      if (c < 0) continue;
      let maxD = -Infinity, minD = Infinity;
      for (let j = c + 1; j <= i; j++) { if (a[j].high > maxD) maxD = a[j].high; if (a[j].low < minD) minD = a[j].low; }
      const tramo: 0 | 1 = a[c].high > maxD ? 0 : a[c].low < minD ? 1 : e.tramo;
      if (tramo === e.tramo) continue;
      e.tramo = tramo;
      const s = tramo === 1 ? e.bajo : e.alto, p = tramo === 1 ? a[c].low : a[c].high;
      s.prev = s.cur; s.cur = p; s.i = c; s.roto = false;
      const tipo = tramo === 1
        ? (Number.isNaN(s.prev) ? "L" : p < s.prev ? "LL" : "HL")
        : (Number.isNaN(s.prev) ? "H" : p > s.prev ? "HH" : "LH");
      giros.push({ t: a[c].time, p, alto: tramo === 0, tipo, nivel: e.n });
      if (e === sw) {
        if (tramo === 0) techo = { p, t: a[c].time }; else piso = { p, t: a[c].time };
      }
    }
    // El extremo del tramo swing sigue al precio.
    if (techo && v.high > techo.p) techo = { p: v.high, t: v.time };
    if (piso && v.low < piso.p) piso = { p: v.low, t: v.time };

    // 2. Los OB vivos: invalidados (cierre del otro lado) o probados (el precio volvio a entrar).
    for (let k = vivos.length - 1; k >= 0; k--) {
      const z = vivos[k];
      if (i <= z.desde) continue;
      if (z.alc ? v.close < z.bot : v.close > z.top) { vivos.splice(k, 1); continue; }
      if (z.alc ? v.low <= z.top : v.high >= z.bot) z.probado = true;
    }

    // 3. Rupturas (la interna primero) y su OB.
    for (const e of niveles) {
      for (const alc of [true, false]) {
        const s = alc ? e.alto : e.bajo;
        if (s.roto || Number.isNaN(s.cur)) continue;
        if (alc ? !(v.close > s.cur) : !(v.close < s.cur)) continue;
        // Una interna en el mismo nivel que la swing no se cuenta dos veces.
        if (e === int && s.cur === (alc ? sw.alto.cur : sw.bajo.cur)) { s.roto = true; continue; }
        const tipo = e.tendencia === (alc ? -1 : 1) ? "CHoCH" : "BOS";
        rupturas.push({ tipo, alc, nivel: e.n, precio: s.cur, t0: a[s.i].time, t1: v.time });
        e.tendencia = alc ? 1 : -1;
        s.roto = true;
        crear(s.i, i, alc, e.n);
      }
    }
  }

  // 4. Los OB mas cercanos al precio, sin pisarse (gana el swing, o el de mas volumen).
  const precio = n ? a[n - 1].close : 0;
  const dist = (z: OrderBlock) => Math.abs((z.top + z.bot) / 2 - precio);
  const out: (OrderBlock & { desde: number })[] = [];
  for (const nivel of ["swing", "interna"] as Nivel[]) {
    for (const alc of [true, false]) {
      let puestos = 0;
      const tope = nivel === "swing" ? mostrar : mostrarInt;
      for (const z of vivos.filter((x) => x.nivel === nivel && x.alc === alc).sort((x, y) => dist(x) - dist(y))) {
        if (puestos >= tope) break;
        const pisa = out.findIndex((o) => o.alc === z.alc && z.bot <= o.top && z.top >= o.bot);
        if (pisa >= 0) {
          if (out[pisa].nivel === nivel && z.vol > out[pisa].vol) out[pisa] = z;
          continue;
        }
        out.push(z);
        puestos++;
      }
    }
  }
  return {
    giros, rupturas, obs: out.map(({ desde, ...z }) => z),
    alto: techo ? { ...techo, fuerte: sw.tendencia === -1 } : null,
    bajo: piso ? { ...piso, fuerte: sw.tendencia === 1 } : null,
    tendencia: { swing: sw.tendencia, interna: int.tendencia },
  };
}

/** El volumen de cada vela contra lo normal: la mediana de la misma hora de los
 *  dias anteriores (hasta 20; en intradia) o la de las 50 velas anteriores (diario o
 *  mas, o si todavia no hay 3 dias). NaN sin volumen. */
export function volumenRelativo(a: VelaSMC[]): number[] {
  const mediana = (xs: number[]) => { const o = xs.filter((x) => x > 0).sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : 0; };
  // Cada referencia solo conoce los intervalos observados hasta esa vela. Usar
  // la ultima pareja de toda la serie hacia que un gap de fin de semana cambiara
  // retrospectivamente todas las referencias intradia a la mediana de 50 velas.
  let paso = Infinity;
  const porHora = new Map<number, number[]>();
  return a.map((v, i) => {
    if (i > 0) {
      const salto = v.time - a[i - 1].time;
      if (salto > 0) paso = Math.min(paso, salto);
    }
    const intradia = paso < 86_400;
    let ref = 0;
    if (intradia) {
      const h = ((v.time % 86_400) + 86_400) % 86_400;
      const lista = porHora.get(h) ?? [];
      if (lista.length >= 3) ref = mediana(lista.slice(-20).map((j) => vol(a[j])));
      lista.push(i);
      porHora.set(h, lista);
    }
    if (!ref) ref = mediana(a.slice(Math.max(0, i - 50), i).map(vol));
    return ref > 0 && vol(v) > 0 ? vol(v) / ref : NaN;
  });
}
