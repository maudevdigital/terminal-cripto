// Horario del mercado en el broker (sesiones de MT5) y el aviso cuando MT5 rechaza
// algo por mercado cerrado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { horario, type Sesion } from "../src/horario.ts";
import { explicar } from "../src/operativa.ts";

const OFFSET = 3 * 3600;                         // servidor de FTMO en verano: UTC+3
const hm = (h: number, m = 0) => h * 3600 + m * 60;
// Indice de FTMO: lunes a viernes de 01:05 a 23:55 (hora del servidor).
const INDICE: Sesion[] = [1, 2, 3, 4, 5].map((d) => [d, hm(1, 5), hm(23, 55)]);
// Hora del servidor -> ms UTC. El 21/10/2026 es miercoles.
const srv = (dia: number, h: number, m = 0) => Date.UTC(2026, 9, dia, h, m) - OFFSET * 1000;

test("abierto: cuando cierra y cuando reabre", () => {
  const h = horario(INDICE, OFFSET, srv(21, 23, 30))!;
  assert.equal(h.abierto, true);
  assert.equal(h.cierra, srv(21, 23, 55));
  assert.equal(h.abre, srv(22, 1, 5));
  assert.equal(h.tramos[0].hasta, srv(21, 23, 55));
});

test("en la pausa diaria: cerrado hasta las 01:05", () => {
  const h = horario(INDICE, OFFSET, srv(21, 23, 58))!;
  assert.equal(h.abierto, false);
  assert.equal(h.cierra, null);
  assert.equal(h.abre, srv(22, 1, 5));
});

test("fin de semana: reabre el lunes", () => {
  const h = horario(INDICE, OFFSET, srv(24, 12))!;   // sabado
  assert.equal(h.abierto, false);
  assert.equal(h.abre, srv(26, 1, 5));
});

test("dias completos seguidos son un solo tramo", () => {
  const cripto: Sesion[] = [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 0, 86_400]);
  const h = horario(cripto, OFFSET, srv(21, 12))!;
  assert.equal(h.abierto, true);
  assert.ok(h.cierra! - srv(21, 12) > 7 * 86_400_000, "no cierra en la semana");
  assert.equal(horario([], OFFSET), null);
  assert.equal(horario(undefined, OFFSET), null);
});

test("mercado cerrado: se dice claro que la pendiente sigue viva", () => {
  const r = { ok: false, retcode: 10018, mensaje: "Orden cancelada: market closed" };
  assert.match(explicar("cancelar", r), /SIGUE PUESTA/);
  assert.match(explicar("cerrar", r), /posición sigue abierta/);
  assert.equal(explicar("cancelar", { ok: false, mensaje: "Volumen invalido" }), "Volumen invalido");
  assert.equal(explicar("cancelar", { ok: true, mensaje: "Orden cancelada" }), "Orden cancelada");
});
