// Freno de disciplina: racha de perdidas, operaciones del dia y perdida del dia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ampliaSl, cargarVigia, evaluar, guardarVigia, HUECO_MS, PausaReal, planSl, vigilar } from "../src/freno.ts";
import type { Operacion } from "../src/historial.ts";

const op = (resultado: number, apertura: number, cierre: number): Operacion => ({
  ticket: apertura, simbolo: "US100.cash", lado: "compra", volumen: 0.5, apertura, cierre, entrada: 1, salida: 1,
  slInicial: null, tp: null, bruto: resultado, costos: 0, resultado, riesgo: null, r: null, pips: null,
  cerradaPor: "manual", minutos: 1, desdeTerminal: true,
});

test("freno: dos perdidas seguidas hoy, el maximo de operaciones o la perdida del dia", () => {
  const dia = 1_000_000, corte = dia + 86_400_000;
  const reglas = { perdidasSeguidas: 2, operacionesDia: 3, perdidaDia: 100, modo: "bloquear" as const };
  assert.equal(evaluar([op(50, dia + 1, dia + 2), op(-30, dia + 3, dia + 4)], 0, dia, corte, reglas).activo, false);
  const f = evaluar([op(50, dia + 1, dia + 2), op(-30, dia + 3, dia + 4), op(-20, dia + 5, dia + 6)], 0, dia, corte, reglas);
  assert.equal(f.bloquea, true);
  assert.equal(f.seguidas, 2);
  assert.equal(f.hasta, corte);
  // La racha de ayer no frena hoy.
  assert.equal(evaluar([op(-30, dia - 9, dia - 8), op(-20, dia - 7, dia - 6)], 0, dia, corte, reglas).activo, false);
  // Tres operaciones hoy (dos cerradas y una abierta).
  assert.match(evaluar([op(50, dia + 1, dia + 2), op(40, dia + 3, dia + 4)], 1, dia, corte, reglas).motivos.join(), /3 operaciones/);
  // Perdio el maximo del dia en una sola operacion.
  assert.match(evaluar([op(-110, dia + 1, dia + 2)], 0, dia, corte, reglas, 110).motivos.join(), /perdiste 110 USD/);
  // Modo avisar: avisa pero no bloquea.
  const a = evaluar([op(-30, dia + 3, dia + 4), op(-20, dia + 5, dia + 6)], 0, dia, corte, { ...reglas, modo: "avisar" });
  assert.equal(a.activo, true);
  assert.equal(a.bloquea, false);
});

test("freno en MT5: no toca lo que ya estaba al activarse; si lo que se abre despues", () => {
  // Primera vuelta (la terminal recien arranca) con el freno ya activo: todo es conocido.
  let r = vigilar(null, "1", ["10", "11"], true);
  assert.deepEqual(r.nuevos, []);
  // Una limite nueva puesta en MT5 con el freno activo.
  r = vigilar(r.estado, "1", ["10", "11", "12"], true);
  assert.deepEqual(r.nuevos, ["12"]);
  // La operacion que activa el freno (la segunda del dia) no se cierra.
  r = vigilar(null, "1", ["20"], false);
  r = vigilar(r.estado, "1", ["20", "21"], true);
  assert.deepEqual(r.nuevos, []);
  // La limite conocida que se ejecuta lleva su ticket: sigue conocida; una nueva, no.
  r = vigilar(r.estado, "1", ["21", "22"], true);
  assert.deepEqual(r.nuevos, ["22"]);
  // Sin freno (dia nuevo) lo abierto pasa a conocido.
  r = vigilar(r.estado, "1", ["21", "22", "23"], false);
  assert.deepEqual(vigilar(r.estado, "1", ["21", "22", "23"], true).nuevos, []);
  // Con otra cuenta en MT5 no se toca nada de lo que hay.
  r = vigilar(null, "1", ["30"], true);
  assert.deepEqual(vigilar(r.estado, "2", ["40", "41"], true).nuevos, []);
});

test("freno en MT5: una orden que falto en una vuelta antes de activarse sigue conocida", () => {
  let r = vigilar(null, "1", ["10"], false);
  r = vigilar(r.estado, "1", [], true);          // la vuelta en que se activa llego sin la 10
  assert.deepEqual(vigilar(r.estado, "1", ["10"], true).nuevos, []);
});

const REGLAS = { perdidasSeguidas: 0, operacionesDia: 0, perdidaDia: 0, modo: "bloquear" as const };

test("una operacion por sesion: la primera activa el freno hasta el corte", () => {
  const dia = 1_000_000, corte = dia + 86_400_000;
  const reglas = { ...REGLAS, operacionesDia: 1 };
  assert.equal(evaluar([], 0, dia, corte, reglas, 0, { ahora: dia + 1000 }).activo, false);
  const f = evaluar([], 1, dia, corte, reglas, 0, { ahora: dia + 1000 });
  assert.equal(f.bloquea, true);
  assert.equal(f.hasta, corte);
  assert.equal(f.porDia, true);
});

test("pausa despues de salir: vale cualquier salida, se ve antes que el historial y se termina", () => {
  const dia = 1_000_000, corte = dia + 86_400_000, min = 60_000;
  const reglas = { ...REGLAS, pausaMin: 30 };
  const gano = op(50, dia + 1000, dia + 2000);
  const f = evaluar([gano], 0, dia, corte, reglas, 0, { ahora: dia + 2000 + 10 * min });
  assert.equal(f.bloquea, true);
  assert.equal(f.hasta, dia + 2000 + 30 * min);
  assert.equal(f.porDia, false);
  assert.match(f.motivos[0], /quedan 20/);
  assert.equal(evaluar([gano], 0, dia, corte, reglas, 0, { ahora: dia + 2000 + 30 * min }).activo, false);
  // El historial todavia no la trae: cuenta la salida vista en lo abierto.
  assert.equal(evaluar([], 0, dia, corte, reglas, 0, { ultimaSalida: dia + 5000, ahora: dia + 6000 }).bloquea, true);
  // Con la regla apagada no frena.
  assert.equal(evaluar([gano], 0, dia, corte, REGLAS, 0, { ahora: dia + 3000 }).activo, false);
});

test("el SL inicial es el techo: acercar o pasar a ganancia si; alejar o quitar no", () => {
  assert.equal(ampliaSl("buy", 100, 101), false);
  assert.equal(ampliaSl("buy", 100, 100), false);
  assert.equal(ampliaSl("buy", 100, 120), false);
  assert.equal(ampliaSl("buy", 100, 99.99), true);
  assert.equal(ampliaSl("buy", 100, 0), true);
  assert.equal(ampliaSl("sell", 100, 99), false);
  assert.equal(ampliaSl("sell", 100, 100.01), true);
  assert.equal(ampliaSl("sell", 100, 0), true);
  assert.equal(ampliaSl("buy", null, 50), false);   // sin SL inicial conocido, nada que comparar
});

test("lo ampliado en MT5 vuelve al inicial; si el precio ya lo paso, no se toca", () => {
  const p = (x: any) => ({ id: "1", lado: "buy" as const, actual: 110, sl: 90, inicial: 100, ...x });
  assert.deepEqual(planSl([p({})]), [{ id: "1", accion: "sl", precio: 100 }]);
  assert.deepEqual(planSl([p({ actual: 95 })]), []);
  assert.deepEqual(planSl([p({ lado: "sell", actual: 95, sl: 110 })]), [{ id: "1", accion: "sl", precio: 100 }]);
  assert.deepEqual(planSl([p({ lado: "sell", actual: 105, sl: 110 })]), []);
  assert.deepEqual(planSl([p({ sl: 100 })]), []);      // en su lugar
  assert.deepEqual(planSl([p({ sl: 105 })]), []);      // mas cerca
  assert.deepEqual(planSl([p({ sl: null })]), []);     // sin SL: es del corte automatico
  assert.deepEqual(planSl([p({ inicial: null })]), []);
});

test("la pausa de la cuenta real bloquea en cualquier modo, tarda en quitarse y se recuerda", () => {
  const dir = mkdtempSync(join(tmpdir(), "pausa-"));
  const ruta = join(dir, "pausa.json"), t = 1_000_000;
  const p = new PausaReal(ruta, 10);
  assert.equal(p.estado(t).activa, false);
  p.poner();
  const f = evaluar([], 0, 0, 0, { ...REGLAS, modo: "avisar" }, 0, { pausa: p.estado(t), ahora: t });
  assert.equal(f.bloquea, true);
  assert.equal(f.hasta, null);
  assert.equal(new PausaReal(ruta, 10).estado(t).activa, true);
  // Quitarla no es inmediato; pedirla de nuevo no adelanta nada.
  p.quitar(t);
  p.quitar(t + 5 * 60_000);
  assert.equal(p.estado(t + 9 * 60_000).activa, true);
  assert.equal(p.estado(t + 9 * 60_000).quitarEn, t + 10 * 60_000);
  assert.equal(evaluar([], 0, 0, 0, REGLAS, 0, { pausa: p.estado(t + 9 * 60_000), ahora: t + 9 * 60_000 }).hasta, t + 10 * 60_000);
  // Arrepentirse la deja como estaba.
  p.poner();
  assert.equal(p.estado(t + 11 * 60_000).activa, true);
  p.quitar(t + 11 * 60_000);
  assert.equal(p.estado(t + 21 * 60_000).activa, false);
  assert.equal(new PausaReal(ruta, 10).estado(t + 22 * 60_000).activa, false);
  rmSync(dir, { recursive: true });
});

test("freno en MT5: un reinicio corto no perdona, pero lo abierto con la terminal sin mirar no se toca", () => {
  const t = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "vigia-"));
  const ruta = join(dir, "vigia.json");
  let r = vigilar(null, "1", ["10"], true, t);
  r = vigilar(r.estado, "1", ["10"], true, t + 3000);
  guardarVigia(ruta, r.estado);
  // El servidor se reinicia y a los pocos segundos ya hay una operacion nueva: se frena.
  const recargado = cargarVigia(ruta)!;
  assert.deepEqual(vigilar(recargado, "1", ["10", "11"], true, t + 9000).nuevos, ["11"]);
  // Un rato sin mirar (PC dormido, MT5 desconectado): lo que aparezca se toma como ya puesto.
  r = vigilar(recargado, "1", ["10", "12"], true, t + 3000 + HUECO_MS + 1);
  assert.deepEqual(r.nuevos, []);
  assert.deepEqual(vigilar(r.estado, "1", ["10", "12"], true, t + 3000 + HUECO_MS + 3001).nuevos, []);
  // Lo siguiente, ya mirando, si se frena.
  assert.deepEqual(vigilar(r.estado, "1", ["10", "12", "13"], true, t + 3000 + HUECO_MS + 3001).nuevos, ["13"]);
  assert.equal(cargarVigia(join(dir, "no-existe.json")), null);
  rmSync(dir, { recursive: true });
});
