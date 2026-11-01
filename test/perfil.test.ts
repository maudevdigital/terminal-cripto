// Perfiles de volumen (web/src/lib/profile.js): como en TradingView, 24 filas y
// area de valor del 70 %; el del rango visible y los de cada sesion por separado.
import { test } from "node:test";
import assert from "node:assert/strict";

const ruta = "../web/src/lib/profile.js";
const vp: any = await import(ruta as string);

const H = 3600;
// Dos dias de velas de 1H: el primero alrededor de 100, el segundo de 110.
const velas = Array.from({ length: 48 }, (_, i) => {
  const base = i < 24 ? 100 : 110;
  const o = base + (i % 3), c = base + ((i + 1) % 3);
  return { time: Date.UTC(2026, 9, 19) / 1000 + i * H, open: o, close: c, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5,
    buy: 6 + (i % 5), sell: 4 + (i % 4) };
});

test("rango visible: 24 filas, POC en la de mas volumen y area de valor del 70 %", () => {
  assert.equal(vp.FILAS_TV, 24);
  const p = vp.perfilRango(velas);
  assert.equal(p.bins.length, 24);
  const mayor = p.bins.reduce((a: any, b: any) => (b.total > a.total ? b : a));
  assert.ok(p.poc > mayor.low && p.poc < mayor.high);
  const enArea = p.bins.filter((b: any) => b.in_va).reduce((s: number, b: any) => s + b.total, 0);
  assert.ok(enArea >= 0.7 * p.total);
  // Todo el volumen queda repartido entre las filas.
  const total = velas.reduce((s, x) => s + x.buy + x.sell, 0);
  assert.ok(Math.abs(p.total - total) < 1e-9);
});

test("por sesion: un perfil por dia en 1H, cada uno con sus velas", () => {
  const s = vp.perfilSesiones("1h", velas, 100);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x: any) => [x.from, x.to]), [[100, 123], [124, 147]]);
  assert.ok(s[0].prof.poc < 104 && s[1].prof.poc > 109);
  assert.equal(s[0].prof.bins.length, 24);
  // Con otra cantidad de filas (VP_FILAS).
  assert.equal(vp.perfilRango(velas, 60).bins.length, 60);
});
