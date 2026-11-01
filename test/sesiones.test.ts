// Sesiones: horario local de cada plaza (con su horario de verano), maximo,
// minimo y cuando el precio los toma despues.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/binance.ts";
import { deLocal, leerSesiones, sesiones, SESIONES_TV } from "../src/sesiones.ts";

test("hora local -> UTC, con el cambio de hora", () => {
  // Londres 08:00: verano (BST, UTC+1) es 07:00 UTC; invierno, 08:00 UTC.
  assert.equal(deLocal(2026, 10, 21, 8 * 60, "Europe/London"), Date.UTC(2026, 9, 21, 7));
  assert.equal(deLocal(2026, 11, 2, 8 * 60, "Europe/London"), Date.UTC(2026, 10, 2, 8));
  // Nueva York 08:00 en octubre (EDT, UTC-4) = 12:00 UTC. Tokio no cambia: 09:00 = 00:00 UTC.
  assert.equal(deLocal(2026, 10, 21, 8 * 60, "America/New_York"), Date.UTC(2026, 9, 21, 12));
  assert.equal(deLocal(2026, 10, 21, 9 * 60, "Asia/Tokyo"), Date.UTC(2026, 9, 21, 0));
  assert.deepEqual(leerSesiones(SESIONES_TV).map((s) => [s.nombre, s.zona, s.desde, s.hasta]),
    [["Asia", "Asia/Tokyo", 540, 1080], ["Londres", "Europe/London", 480, 1020], ["Nueva York", "America/New_York", 480, 1020]]);
});

test("maximo y minimo de la sesion, y la vela que los toma despues", () => {
  const ini = Date.UTC(2026, 9, 21, 7) / 1000;      // Londres abre 07:00 UTC
  const velas: Candle[] = [];
  for (let k = 0; k < 12 * 24; k++) {   // 5m durante 24 h desde la apertura
    const t = ini + k * 300;
    let h = 101, l = 99;
    if (k === 10) h = 110;               // maximo de la sesion
    if (k === 20) l = 90;                // minimo
    if (k === 12 * 10 + 6) h = 111;       // 10.5 h despues (sesion cerrada): toma el maximo
    velas.push({ t, t_ms: t * 1000, close_time: (t + 300) * 1000 - 1, o: 100, h, l, c: 100, v: 1, vb: 0.5, trades: 1, closed: true });
  }
  const s = sesiones(velas, leerSesiones("Londres:Europe/London:08:00-17:00"), 0, Date.UTC(2026, 9, 22, 6))[0];
  assert.equal(s.nombre, "Londres");
  assert.equal(s.inicio, ini);
  assert.equal(s.fin, ini + 9 * 3600);
  assert.equal(s.enCurso, false);
  assert.deepEqual([s.max.p, s.max.t, s.max.tomado], [110, ini + 10 * 300, ini + (12 * 10 + 6) * 300]);
  assert.deepEqual([s.min.p, s.min.t, s.min.tomado], [90, ini + 20 * 300, null]);
  // Sin velas en el horario (fin de semana): no hay sesion.
  assert.equal(sesiones(velas, leerSesiones("Asia:Asia/Tokyo:09:00-10:00"), 0, Date.UTC(2026, 9, 21, 2)).length, 0);
});
