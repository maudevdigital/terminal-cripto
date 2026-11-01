import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Módulo compartido con el navegador.
import { cargarPrefs, guardarPrefs, PERFIL_VISUAL } from "../web/src/lib/prefs.js";

function almacen(inicial: Record<string, unknown> = {}) {
  const datos = new Map(Object.entries(inicial).map(([k, v]) => [k, JSON.stringify(v)]));
  return { datos, getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => datos.set(k, v) };
}

test("el perfil nuevo migra una vez la vista y conserva mercado, grilla, sonidos y dibujos", () => {
  const anterior = { symbol: "BTCUSDT", interval: "5m", sonidos: false, diseno: "4", paneles: [{ symbol: "US100", interval: "15m" }], estacion: "operar", presentacion: true, apal: [2, 5], fijas: ["1m"], capas: { sesiones: true, volumen: true, zonas: true }, vp: { vpvr: true, vpsv: true } };
  const a = almacen({ "terminal-cripto:v3": anterior, "terminal-cripto:dibujos:BTCUSDT": [{ id: "dibujo-1" }] });
  const dibujo = a.datos.get("terminal-cripto:dibujos:BTCUSDT");
  const p = cargarPrefs(a);
  assert.equal(p.interval, "1h");
  assert.deepEqual(p.fijas, ["1w", "1d", "4h", "1h", "15m"]);
  assert.deepEqual(p.capas, { sesiones: false, volumen: false, fvg: true, estructura: true, ob: true, medias: false, osc: true, posiciones: true });
  assert.deepEqual(p.vp, { vpvr: false, vpsv: false, extPoc: false });
  for (const k of ["symbol", "sonidos", "diseno", "paneles", "estacion", "presentacion", "apal"] as const) assert.deepEqual(p[k], anterior[k]);
  assert.equal(a.datos.get("terminal-cripto:dibujos:BTCUSDT"), dibujo);
  assert.equal(a.datos.get("terminal-cripto:v3"), JSON.stringify(anterior));
  guardarPrefs({ ...p, interval: "4h", capas: { ...p.capas, sesiones: true }, fijas: ["1d", "4h"] }, a);
  const vuelta = cargarPrefs(a);
  assert.equal(vuelta.interval, "4h");
  assert.equal(vuelta.capas.sesiones, true);
  assert.deepEqual(vuelta.fijas, ["1d", "4h"]);
});

test("una estación que ya no existe queda cerrada", () => {
  for (const estacion of ["plan", "bitacora", "estudio"]) {
    assert.equal(cargarPrefs(almacen({ "terminal-cripto:v4": { perfilVisual: PERFIL_VISUAL, estacion } })).estacion, null);
  }
});

test("las capas que ya no existen se ignoran", () => {
  const p = cargarPrefs(almacen({ "terminal-cripto:v4": { perfilVisual: PERFIL_VISUAL, capas: { vol: true, zonas: true, kronos: true, ob: false } } }));
  assert.equal("vol" in p.capas, false);
  assert.equal("zonas" in p.capas, false);
  assert.equal("kronos" in p.capas, false);
  assert.equal(p.capas.ob, false);
});

test("las preferencias v4 válidas prevalecen sobre v3 y se validan los valores persistidos", () => {
  const a = almacen({ "terminal-cripto:v3": { symbol: "US100" }, "terminal-cripto:v4": { perfilVisual: PERFIL_VISUAL, symbol: "BTCUSDT", interval: "15m", sonidos: false, capas: { sesiones: true, estructura: "no" }, fijas: ["4h", "4h", null, "inválida"], paneles: [{ symbol: "US100", interval: "1h" }, null] } });
  const p = cargarPrefs(a);
  assert.equal(p.symbol, "BTCUSDT");
  assert.equal(p.interval, "15m");
  assert.equal(p.capas.sesiones, true);
  assert.equal(p.capas.estructura, true);
  assert.equal(p.sonidos, false);
  assert.deepEqual(p.fijas, ["4h"]);
  assert.deepEqual(p.paneles, [{ symbol: "US100", interval: "1h" }]);
});

test("almacenamiento ilegible o bloqueado conserva una vista utilizable sin compartir objetos", () => {
  const a = almacen({ "terminal-cripto:v3": { symbol: "BTCUSDT", sonidos: false } });
  a.setItem("terminal-cripto:v4", "{");
  assert.equal(cargarPrefs(a).symbol, "BTCUSDT");
  const bloqueado = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("bloqueado"); } };
  const p = cargarPrefs(bloqueado);
  p.capas.ob = false;
  p.fijas.push("5m");
  const otra = cargarPrefs(bloqueado);
  assert.equal(otra.capas.ob, true);
  assert.deepEqual(otra.fijas, ["1w", "1d", "4h", "1h", "15m"]);
  assert.doesNotThrow(() => guardarPrefs(p, bloqueado));
});

test("desde swing-v1 solo se prende el IFVG y se conserva lo que ya se eligio", () => {
  const a = almacen({ "terminal-cripto:v4": { perfilVisual: "swing-v1", symbol: "US100", interval: "4h", fijas: ["4h", "5m"], capas: { fvg: false, sesiones: true }, zonas: { fvg: true, ifvg: false, estrInterna: true } } });
  const p = cargarPrefs(a);
  assert.equal(p.interval, "4h");
  assert.deepEqual(p.fijas, ["4h", "5m"]);
  assert.equal(p.capas.sesiones, true);
  assert.equal(p.capas.fvg, true);
  assert.equal(p.zonas.ifvg, true);
  assert.equal(p.zonas.fvg, false);
  assert.equal(p.zonas.estrInterna, true);
  // Una sola vez: despues manda lo que se elija.
  guardarPrefs({ ...p, capas: { ...p.capas, fvg: false } }, a);
  assert.equal(cargarPrefs(a).capas.fvg, false);
});
