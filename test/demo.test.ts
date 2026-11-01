// Creditos demo: fills con bid y ask, SL, TP, limites de la cuenta y lo que se mide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Demo, type Cotizacion } from "../src/demo.ts";

const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);
const cot = (bid: number, spread = 2, abierto = true): Cotizacion => ({ bid, ask: bid + spread, porPunto: 1, volMin: 0.01, volPaso: 0.01, volMax: 100, abierto });

function cuenta(balance = 9145.29) {
  const dir = mkdtempSync(join(tmpdir(), "demo-"));
  const d = new Demo(join(dir, "demo.json"), { zona: "UTC", diariaPct: 5, maximaPct: 10 });
  assert.equal(d.empezar(10000, balance, T0).ok, true);
  return { d, dir };
}
const abrir = (d: Demo, q: Cotizacion, extra: any = {}, ahora = T0) => d.abrir({ symbol: "US100", broker: "US100.cash", lado: 1, tipo: "mercado", riesgo: 14, sl: q.bid - 58, tp: q.bid + 118, ...extra }, q, ahora);
const op = (d: Demo) => d.c!.ops.at(-1)!;

test("a mercado la compra entra al ask, los lotes salen del riesgo y el SL es obligatorio", () => {
  const { d, dir } = cuenta();
  const q = cot(1000);
  assert.equal(abrir(d, q, { sl: 0 }).ok, false);
  assert.equal(abrir(d, q, { sl: 1005 }).ok, false);
  const r = abrir(d, q);
  assert.equal(r.ok, true);
  assert.equal(op(d).entrada, 1002);
  assert.equal(op(d).lotes, 0.23);           // 14 USD / 60 puntos
  assert.equal(op(d).riesgoUsd, 13.8);
  assert.equal(abrir(d, q, { riesgo: 0.1 }).ok, false);   // el minimo arriesga mas que eso
  rmSync(dir, { recursive: true });
});

test("el SL se llena al precio que haya, el TP en su precio, y el balance lo refleja", () => {
  const { d, dir } = cuenta();
  abrir(d, cot(1000));
  d.tick(() => cot(1100), T0 + 60_000);
  assert.equal(op(d).estado, "abierta");
  d.tick(() => cot(1118), T0 + 120_000);
  assert.equal(op(d).final, "tp");
  assert.equal(op(d).salida, 1118);
  assert.equal(op(d).usd, 26.68);            // 0,23 x 116 puntos
  assert.equal(d.c!.balance, 9171.97);
  abrir(d, cot(1000), {}, T0 + 3_600_000);
  d.tick(() => cot(930), T0 + 3_660_000);     // salto: pasa de 942 a 930
  assert.equal(op(d).final, "sl");
  assert.equal(op(d).salida, 930);
  assert.ok(op(d).usd! < -op(d).riesgoUsd);
  rmSync(dir, { recursive: true });
});

test("la limite espera su precio, se cancela sin costo y con el mercado cerrado no pasa nada", () => {
  const { d, dir } = cuenta();
  assert.equal(abrir(d, cot(1000), { tipo: "limite", precio: 1005, sl: 950, tp: 1100 }).ok, false);   // sobre el ask
  assert.equal(abrir(d, cot(1000), { tipo: "limite", precio: 990, sl: 950, tp: 1100 }).ok, true);
  d.tick(() => cot(980, 2, false), T0 + 1000);
  assert.equal(op(d).estado, "pendiente");
  d.tick(() => cot(987), T0 + 2000);
  assert.equal(op(d).estado, "abierta");
  assert.equal(op(d).entrada, 990);
  assert.equal(abrir(d, cot(1000, 2, false)).ok, false);
  abrir(d, cot(1000), { tipo: "limite", precio: 900, sl: 850, tp: 1100 });
  const balance = d.c!.balance;
  assert.equal(d.cerrar(op(d).id, cot(1000)).ok, true);
  assert.equal(op(d).estado, "cancelada");
  assert.equal(d.c!.balance, balance);
  rmSync(dir, { recursive: true });
});

test("al tocar el limite total se cierra todo y la cuenta queda perdida hasta recargar", () => {
  const { d, dir } = cuenta(9020);
  abrir(d, cot(1000), { riesgo: 100, sl: 900, tp: null });
  d.tick(() => cot(980), T0 + 60_000);        // 1 lote x 22 puntos: equity 8.998
  assert.equal(op(d).final, "limite");
  assert.match(d.c!.perdida!, /total/);
  assert.equal(abrir(d, cot(1000)).ok, false);
  assert.equal(d.empezar(10000, 9145.29, T0 + 120_000).ok, true);
  assert.equal(d.c!.perdida, null);
  assert.equal(d.c!.recargas, 1);
  assert.equal(abrir(d, cot(1000), {}, T0 + 180_000).ok, true);
  assert.equal(d.resumen(T0 + 180_000).n, 0);  // lo de la cuenta anterior ya no suma
  rmSync(dir, { recursive: true });
});

test("el limite diario se recalcula con el balance de cada dia", () => {
  const { d, dir } = cuenta(10000);
  abrir(d, cot(1000), { riesgo: 600, sl: 900, tp: 1500 });
  d.tick(() => cot(950), T0 + 60_000);        // 6 lotes x 52: -312, no llega a -500
  assert.equal(d.c!.perdida, null);
  d.tick(() => cot(915), T0 + 120_000);       // 6 lotes x 87: -522
  assert.match(d.c!.perdida!, /diaria/);
  rmSync(dir, { recursive: true });
});

test("no bloquea, pero mide: reentrada, SL ampliado, BE antes de 1 R y cierre a mano", () => {
  const { d, dir } = cuenta();
  abrir(d, cot(1000));
  const primera = op(d);
  assert.equal(d.modificar({ id: primera.id, sl: 900, tp: primera.tp }, cot(1000)).ok, true);
  assert.equal(primera.slAmpliado, true);
  assert.equal(primera.riesgoMaxUsd, 23.46);  // 0,23 x 102 puntos
  assert.equal(d.cerrar(primera.id, cot(1010), T0 + 60_000).ok, true);
  assert.equal(primera.final, "manual");
  // Vuelve a entrar a los 9 segundos, y sube el SL a la entrada ganando menos de 1 R.
  abrir(d, cot(1010), {}, T0 + 69_000);
  const segunda = op(d);
  assert.equal(segunda.reentradaSeg, 9);
  assert.equal(d.modificar({ id: segunda.id, sl: segunda.entrada, tp: segunda.tp }, cot(1030)).ok, true);
  assert.equal(segunda.beTemprano, true);
  d.tick(() => cot(1012), T0 + 80_000);
  assert.equal(segunda.final, "be");
  const r = d.resumen(T0 + 80_000);
  assert.deepEqual([r.n, r.reentradas, r.slAmpliados, r.beTempranos, r.aMano, r.be], [2, 1, 1, 1, 1, 1]);
  assert.equal(r.hoy, 2);
  assert.equal(r.diasUna, 0);
  rmSync(dir, { recursive: true });
});

test("sin tocar: sigue el SL y el TP originales aunque ya se haya salido", () => {
  const { d, dir } = cuenta();
  abrir(d, cot(1000), { sl: 950, tp: 1100, riesgo: 52 });     // 1 lote; entra en 1002
  const o = op(d);
  d.cerrar(o.id, cot(1010), T0 + 1000);                       // se salio con +8
  assert.equal(o.usd, 8);
  assert.equal(o.sombra, null);
  d.tick(() => cot(1100), T0 + 60_000);                       // el precio llego al TP original
  assert.deepEqual(o.sombra, { final: "tp", usd: 98 });
  const r = d.resumen(T0 + 60_000);
  assert.deepEqual(r.sinTocar, { n: 1, real: 8, usd: 98 });
  assert.equal(d.c!.balance, 9153.29);                        // la sombra no mueve el balance
  rmSync(dir, { recursive: true });
});

test("se guarda en su archivo y se recupera; borrar lo deja como nuevo", () => {
  const { d, dir } = cuenta();
  abrir(d, cot(1000));
  const ruta = join(dir, "demo.json");
  assert.equal(JSON.parse(readFileSync(ruta, "utf8")).ops.length, 1);
  const otra = new Demo(ruta, { zona: "UTC", diariaPct: 5, maximaPct: 10 });
  assert.equal(otra.c!.ops[0].estado, "abierta");
  const v = otra.vista(() => cot(1020), T0);
  assert.equal(v.flotante, 4.14);            // 0,23 x 18
  assert.equal(v.ops[0].flotanteUsd, 4.14);
  assert.ok(v.plan.usd > 0);
  otra.borrar();
  assert.equal(existsSync(ruta), false);
  assert.deepEqual(otra.vista(() => null), { iniciada: false });
  rmSync(dir, { recursive: true });
});

test("el modulo no conoce la operativa real", () => {
  const fuente = readFileSync(new URL("../src/demo.ts", import.meta.url), "utf8");
  const imports = fuente.match(/^import .*$/gm)!.join("\n");
  assert.doesNotMatch(imports, /operativa|mt5|binanceCuenta/i);
  assert.doesNotMatch(fuente, /\.enviar\(/);
});
