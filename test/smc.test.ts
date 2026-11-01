// Estructura de mercado (giros que alternan, BOS y CHoCH en dos niveles) y order
// blocks (desplazamiento, FVG, volumen a la misma hora, invalidacion).
import { test } from "node:test";
import assert from "node:assert/strict";
import { smc, volumenRelativo, SWING, INTERNA } from "../src/smc.ts";

let t = 0;
const vela = (o: number, h: number, l: number, c: number, volume = 100) => ({ time: (t += 300), open: o, high: h, low: l, close: c, volume, buy: volume / 2, closed: true });

/** Un giro alto en 110, una caida a 95 (la vela del OB) y un impulso que cierra arriba de 110. */
function escenario(volImpulso: number) {
  t = 0;
  const v = [];
  for (let i = 0; i < 20; i++) v.push(vela(100, 101, 99, 100));
  v.push(vela(100, 106, 100, 105), vela(105, 110, 104, 108));                 // sube al giro (110)
  for (let i = 0; i < 6; i++) v.push(vela(104, 105, 101, 102));               // baja
  v.push(vela(102, 102, 95, 96, 150));                                        // la vela del OB (minimo 95)
  v.push(vela(96, 104, 96, 103, volImpulso), vela(103, 113, 103, 112, volImpulso));   // impulso: cierra arriba de 110
  for (let i = 0; i < 3; i++) v.push(vela(112, 114, 111, 113));
  return v;
}

test("OB alcista: la vela del minimo antes de la ruptura, con desplazamiento, FVG y volumen", () => {
  const r = smc(escenario(400));
  const ob = r.obs.find((z) => z.alc);
  assert.ok(ob, "hay OB alcista");
  assert.equal(ob.bot, 95);
  assert.equal(ob.top, 102);
  assert.equal(ob.vol, 150 + 400 + 400);
  assert.equal(ob.fvg, true);
  assert.ok(ob.desplaz > 2.5 && ob.fuerza! > 1);
  assert.equal(ob.probado, false);
  // La ruptura del giro de 110: la interna en el mismo nivel no se cuenta dos veces.
  assert.equal(r.rupturas.filter((x) => x.precio === 110).length, 1);
  assert.equal(r.tendencia.interna, 1);
  assert.equal(r.tendencia.swing, 0, "34 velas no confirman un swing de 50");
});

test("sin volumen en el impulso no hay OB (no es al azar)", () => {
  assert.equal(smc(escenario(60)).obs.filter((z) => z.alc).length, 0);
});

test("una vela que cierra debajo del OB lo invalida; una mecha que entra lo deja probado", () => {
  const v = escenario(400);
  assert.equal(smc([...v, vela(113, 113, 100, 108)]).obs.find((z) => z.alc)?.probado, true);
  assert.equal(smc([...v, vela(113, 113, 90, 92)]).obs.filter((z) => z.alc).length, 0);
});

test("los giros alternan y se nombran; romper contra la tendencia es CHoCH", () => {
  t = 0;
  // Zigzag: 100 -> 120 -> 105 -> 130 (HH) -> 112 (HL) -> cae y cierra bajo 112.
  const puntos = [100, 120, 105, 130, 112, 128, 90];
  const v = [];
  for (let k = 1; k < puntos.length; k++) {
    const [p0, p1] = [puntos[k - 1], puntos[k]];
    for (let j = 1; j <= 8; j++) {
      const c = p0 + ((p1 - p0) * j) / 8, o = p0 + ((p1 - p0) * (j - 1)) / 8;
      v.push(vela(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c));
    }
  }
  const r = smc(v, { interna: 3, swing: 12 });
  const g = r.giros.filter((x) => x.nivel === "interna");
  for (let k = 1; k < g.length; k++) assert.notEqual(g[k].alto, g[k - 1].alto, "alternan");
  assert.ok(g.some((x) => x.tipo === "HH") && g.some((x) => x.tipo === "HL"));
  // Subio rompiendo 120 (BOS) y despues cerro bajo el ultimo minimo mas alto (112): CHoCH.
  assert.deepEqual(r.rupturas.filter((x) => x.nivel === "interna").map((x) => [x.tipo, x.alc, Math.round(x.precio)]), [["BOS", true, 120], ["CHoCH", false, 112]]);
  assert.equal(r.tendencia.swing, -1);
  assert.equal(r.alto?.fuerte, true);    // en bajista el maximo es fuerte
});

test("doble techo: el giro es el segundo maximo (antes no habia giro)", () => {
  t = 0;
  const v = [];
  for (let i = 0; i < 8; i++) v.push(vela(100, 101, 99, 100));
  v.push(vela(100, 106, 99, 105), vela(105, 110, 104, 106), vela(106, 107, 103, 104), vela(104, 110, 103, 105));
  for (let i = 0; i < 6; i++) v.push(vela(104, 105, 101, 102));
  const altos = smc(v, { interna: 5, swing: 5 }).giros.filter((x) => x.alto && x.nivel === "interna");
  assert.equal(altos.length, 1);
  assert.equal(altos[0].p, 110);
  assert.equal(altos[0].t, v[11].time);
});

test("el volumen se compara con la misma hora de los dias anteriores", () => {
  // 5 dias de velas de 1 hora: la hora 14 (la apertura) trae siempre 1000 y el resto 100.
  const v = [];
  for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) {
    v.push({ time: d * 86_400 + h * 3600, open: 100, high: 101, low: 99, close: 100, volume: h === 14 ? 1000 : 100, closed: true });
  }
  const rv = volumenRelativo(v);
  const ultima14 = 4 * 24 + 14;
  assert.equal(rv[ultima14], 1);                     // lo normal de esa hora, no 10 veces
  assert.equal(rv[ultima14 + 1], 1);
  // Los primeros dias (sin 3 dias de esa hora) van contra las 50 velas anteriores.
  assert.equal(rv[14], 10);
});

test("ampliar una serie conserva los giros ya confirmados y las rupturas anteriores", () => {
  const todas = Array.from({ length: 360 }, (_, i) => {
    const c = 100 + 20 * Math.sin(i * Math.PI / 30);
    return { time: i * 3600, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 100, closed: true };
  });
  const prefijo = todas.slice(0, 120);
  const corto = smc(prefijo), largo = smc(todas);
  const indice = new Map(todas.map((v, i) => [v.time, i]));
  const confirmados = largo.giros.filter((g) => indice.get(g.t)! + (g.nivel === "swing" ? SWING : INTERNA) < prefijo.length);
  assert.ok(corto.giros.some((g) => g.nivel === "swing"), "la muestra contiene un giro swing confirmado");
  assert.deepEqual(corto.giros, confirmados);
  assert.deepEqual(corto.rupturas, largo.rupturas.filter((r) => r.t1 <= prefijo.at(-1)!.time));
});

test("el swing espera sus 50 velas incluso cuando se carga poca historia", () => {
  const a = escenario(400);
  assert.equal(smc(a).giros.filter((g) => g.nivel === "swing").length, 0);
  assert.ok(smc(a).giros.some((g) => g.nivel === "interna"));
});

test("estructura y bloques excluyen la vela abierta aunque atraviese todos los niveles", () => {
  const a = escenario(400);
  const abierta = { ...vela(113, 1000, 1, 2, 100_000), closed: false };
  assert.deepEqual(smc([...a, abierta]), smc(a));
});

test("una vela despues del fin de semana no cambia el RVOL de las velas anteriores", () => {
  const a = [];
  for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) {
    a.push({ time: d * 86_400 + h * 3600, open: 100, high: 101, low: 99, close: 100, volume: h === 14 ? 1000 : 100, closed: true });
  }
  const antes = volumenRelativo(a);
  assert.equal(antes[4 * 24 + 14], 1, "la hora de mayor actividad se compara con la misma hora");
  const trasFinDeSemana = { ...a.at(-1)!, time: a.at(-1)!.time + 3 * 86_400, volume: 9999 };
  assert.deepEqual(volumenRelativo([...a, trasFinDeSemana]).slice(0, a.length), antes);
});
