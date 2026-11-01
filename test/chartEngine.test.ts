import { test } from "node:test";
import assert from "node:assert/strict";

const ruta = "../web/src/chart/ChartEngine.js";
const { ChartEngine, formateadoresTiempo, areaMomento, factorAdx } = await import(ruta as string);
const rutaDibujos = "../web/src/chart/Dibujos.js";
const { Dibujos } = await import(rutaDibujos as string);
const rutaSeries = "../web/src/lib/graficoVelas.js";
const { armarGrafico, desdeGrafico } = await import(rutaSeries as string);

const vela = (time: number, close = 101) => ({ time, open: 100, high: 103, low: 99, close, volume: 10, closed: true });
const grafico = (velas: any[]) => ({
  velas,
  ema: [velas.map((v) => ({ time: v.time, value: v.close }))],
  momento: [], compresion: [],
  fuerza: velas.map((v) => ({ time: v.time, value: 24, color: "#E8EAED" })),
});

test("el SQZ va en área: cuatro tonos, relleno parejo y sus valores intactos", () => {
  const puntos = [
    { time: 1, value: 4, color: "#00E676" }, { time: 2, value: 3, color: "#1B8A3A" },
    { time: 3, value: -4, color: "#FF1744" }, { time: 4, value: -3, color: "#8B0000" },
  ];
  const area: any[] = puntos.map(areaMomento);
  assert.deepEqual(area.map((p: any) => p.value), [4, 3, -4, -3]);
  assert.equal(new Set(area.map((p: any) => p.topLineColor)).size, 4);
  for (const p of area) {
    assert.equal(p.topFillColor1, p.topFillColor2);
    assert.match(p.topFillColor1, /,0\.65\)$/);
  }
});

test("los FVG cerrados no cambian ni se recalculan por ticks de la vela abierta", () => {
  const e = Object.assign(Object.create(ChartEngine.prototype), {
    velas: [vela(60), vela(120), { ...vela(180), high: 98, low: 95, close: 96 }, { ...vela(240), closed: false }],
  });
  const antes = e.huecos();
  e.velas.at(-1).close = 150;
  e.velas.at(-1).high = 151;
  assert.equal(e.huecos(), antes);
  e.velas.at(-1).closed = true;
  assert.notEqual(e.huecos(), antes);
});

function motor() {
  const sr = () => ({ datos: [] as any[], cambios: [] as any[], opciones: {} as any,
    setData(datos: any[]) { this.datos = datos; },
    update(p: any, historico: boolean) { this.cambios.push([p, historico]); },
    applyOptions(o: any) { this.opciones = o; },
  });
  const eje = { scrolls: 0, rango: null as any, getVisibleLogicalRange() { return this.rango; },
    setVisibleLogicalRange(r: any) { this.rango = r; }, scrollToRealTime() { this.scrolls++; } };
  const e = Object.assign(Object.create(ChartEngine.prototype), {
    s: { velas: sr(), ema: [sr()], momento: sr(), compresion: sr(), fuerza: sr() },
    price: { opciones: {} as any, timeScale: () => eje, applyOptions(o: any) { this.opciones = o; } },
    cb: { onSeguir() {} },
    decimals: 2, velas: [], lastTimes: {}, puntosSeries: {},
    adxPorT: new Map(), siguiendo: true, interval: "1m", symbol: "BTCUSDT",
    encuadrar() {}, agendarDibujo() {},
  });
  return { e, eje };
}

test("el gráfico aplica correcciones a velas e indicadores cerrados", () => {
  const { e } = motor();
  e.aplicarDatos(grafico([vela(60), vela(120)]));
  const g = grafico([vela(60, 102), vela(120)]);
  g.fuerza[0].value = 27;
  e.huecosCache = e.smcCache = e.obCache = e.sesionesCache = { anterior: true };
  e.update(g);
  assert.equal(e.velas[0].close, 102);
  assert.deepEqual(e.s.velas.cambios, [[g.velas[0], true]]);
  assert.deepEqual(e.s.ema[0].cambios, [[g.ema[0][0], true]]);
  assert.equal(e.adxPorT.get(60), 27);
  assert.equal(e.s.fuerza.cambios[0][1], true);
  assert.equal(e.smcCache, null);
  assert.equal(e.obCache, null);
});

test("ticks idénticos no repintan series ni reinician el zoom", () => {
  const { e, eje } = motor();
  const g = grafico([vela(60), vela(120)]);
  e.aplicarDatos(g);
  e.update(structuredClone(g));
  assert.equal(e.s.velas.cambios.length, 0);
  assert.equal(e.s.ema[0].cambios.length, 0);
  assert.equal(eje.scrolls, 0);
  e.update(grafico([vela(120, 102)]));
  assert.equal(e.s.velas.cambios.length, 1);
  assert.equal(eje.scrolls, 0);
  e.update(grafico([vela(120, 102), vela(180)]));
  assert.equal(eje.scrolls, 1);
});

test("paquetes sin cambios no vuelven a pintar las capas del gráfico", () => {
  const { e } = motor();
  const p = { type: "snapshot", conservarVista: true, symbol: "BTCUSDT", interval: "1m", grafico: grafico([vela(60), vela(120)]),
    broker: { disponible: true, posiciones: [], ordenes: [], equity: 10000 }, feed: { server_ms: 1000 } };
  let dibujos = 0;
  e.agendarDibujo = () => { dibujos++; };
  e.handlePayload(p);
  dibujos = 0;
  for (let i = 0; i < 100; i++) e.handlePayload({ ...structuredClone(p), type: "update", feed: { server_ms: 1001 + i }, broker: { ...p.broker, equity: 10001 + i } });
  assert.equal(dibujos, 0);
  e.handlePayload({ ...p, type: "update", grafico: grafico([vela(120, 102)]) });
  assert.equal(dibujos, 1);
});

test("las posiciones se repintan aunque no cambien las velas", () => {
  const { e } = motor();
  e.capas = { posiciones: true };
  const p = { type: "snapshot", conservarVista: true, symbol: "BTCUSDT", interval: "1m", grafico: grafico([vela(60)]),
    broker: { disponible: true, posiciones: [{ entrada: 100, profit: 0 }], ordenes: [] } };
  let dibujos = 0;
  e.agendarDibujo = () => { dibujos++; };
  e.handlePayload(p);
  dibujos = 0;
  e.handlePayload({ ...structuredClone(p), type: "update" });
  assert.equal(dibujos, 0);
  e.handlePayload({ ...p, type: "update", broker: { ...p.broker, posiciones: [{ entrada: 100, profit: 12 }] } });
  assert.equal(dibujos, 1);
});

test("una vela nueva conserva el destino de la animación mientras se sigue el precio", () => {
  const { e, eje } = motor();
  e.aplicarDatos(grafico([vela(60), vela(120)]));
  e.anim = { desde: { from: -20, to: 10 }, destino: { from: -10, to: 10 } };
  e.objetivoZoom = { from: -10, to: 10 };
  e.update(grafico([vela(180)]));
  assert.equal(eje.scrolls, 0);
  assert.deepEqual(e.anim.destino, { from: -9, to: 11 });
  assert.deepEqual(e.objetivoZoom, { from: -9, to: 11 });
});

test("cada gráfico conserva la precisión propia del activo", () => {
  const primero = motor().e, segundo = motor().e;
  primero.symbol = "USDT.D";
  primero.snapshot(grafico([vela(60, 5.125)]), true);
  segundo.snapshot(grafico([vela(60, 70000.25)]), true);
  assert.equal(primero.decimals, 3);
  assert.equal(segundo.decimals, 2);
  assert.equal(primero.fmt(5.125), "5,125");
  assert.equal(primero.price.opciones.localization.priceFormatter(5.125), "5,125");
  assert.equal(segundo.price.opciones.localization.priceFormatter(70000.25), "70.000,25");
});

test("las velas MT5 respetan los decimales oficiales aunque la muestra tenga precios enteros", () => {
  const { e } = motor();
  e.broker = { graficoBroker: true, digitos: 5 };
  e.snapshot(grafico([vela(60, 100)]), true);
  assert.equal(e.decimals, 5);
  assert.equal(e.fmt(100.12345), "100,12345");
  e.broker = { graficoBroker: true, digitos: 0 };
  e.snapshot(grafico([vela(60, 100)]), true);
  assert.equal(e.decimals, 0);
  e.broker = { graficoBroker: true, digitos: -1, info: { digits: 3 } };
  e.snapshot(grafico([vela(60, 100)]), true);
  assert.equal(e.decimals, 3);
  e.broker = { graficoBroker: false, digitos: 5 };
  e.snapshot(grafico([vela(60, 100.25)]), true);
  assert.equal(e.decimals, 2);
});

test("una línea confirmada vence aunque el mercado no haya cambiado", () => {
  const { e } = motor();
  const p = { type: "snapshot", conservarVista: true, symbol: "BTCUSDT", interval: "1m", grafico: grafico([vela(60)]) };
  e.handlePayload(p);
  e.lineasOrden = { confirmado: { vence: Date.now() - 1 } };
  let dibujos = 0;
  e.agendarDibujo = () => { dibujos++; };
  e.handlePayload({ ...p, type: "update" });
  assert.equal(dibujos, 1);
  assert.equal(e.lineasOrden.confirmado, null);
  e.handlePayload({ ...p, type: "update" });
  assert.equal(dibujos, 1);
});

test("el resync conserva el tramo temporal aunque cambien los huecos y el número de velas", () => {
  const { e, eje } = motor();
  const p = { type: "snapshot", symbol: "BTCUSDT", interval: "1m", grafico: grafico([60, 120, 180, 240, 300].map((t) => vela(t))), fuente: { nombre: "Binance" } };
  e.handlePayload(p);
  e.siguiendo = false;
  eje.rango = { from: 1, to: 3 };
  e.handlePayload({ ...p, grafico: grafico([60, 180, 240, 300, 360].map((t) => vela(t))) });
  assert.deepEqual(eje.rango, { from: 0.5, to: 2 });
  assert.equal(e.tiempo(eje.rango.from), 120);
  assert.equal(e.tiempo(eje.rango.to), 240);
});

test("el ADX va en las unidades del SQZ y la leyenda conserva su valor real", () => {
  // Un ADX de 50 queda a la altura del percentil 95 del SQZ; lo viejo y extremo no lo aplasta.
  const momento = Array.from({ length: 300 }, (_, i) => ({ value: i % 2 ? 100 : -100 }));
  assert.equal(factorAdx([{ value: 90000 }, ...momento]), 2);
  assert.equal(factorAdx([]), 1);
  assert.equal(factorAdx([{ value: 0 }]), 1);
  const { e } = motor();
  e.handlePayload({ type: "snapshot", symbol: "BTCUSDT", interval: "1h", grafico: { ...grafico([60, 120].map((t) => vela(t))), momento: [{ time: 60, value: 50, color: "#00E676" }, { time: 120, value: -50, color: "#FF1744" }], fuerza: [{ time: 60, value: 25, color: "#E8EAED" }, { time: 120, value: 30, color: "#E8EAED" }] } });
  assert.equal(e.factorAdx, 1);
  assert.deepEqual(e.s.fuerza.datos.map((p: any) => p.value), [25, 30]);
  assert.equal(e.adxPorT.get(120), 30);
});

test("reconectar mantiene la historia anterior cargada de la misma fuente", () => {
  const { e, eje } = motor();
  const cfg = { indicadores: { adx: [3, 3], sqz: [5, 2, 5, 1.5, true] }, ema: [3] };
  const crudas = Array.from({ length: 101 }, (_, i) => {
    const o = 100 + Math.sin(i / 7) * 8, c = o + Math.sin(i / 3);
    return { t: i * 60, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 10 + i, closed: true };
  });
  const inicial = armarGrafico(crudas.slice(0, 100), cfg);
  let recalculadas: any[] = [];
  e.cb.recalcularGrafico = (velas: any[]) => {
    recalculadas = velas;
    return armarGrafico(velas.map(desdeGrafico), cfg);
  };
  const p = { type: "snapshot", symbol: "BTCUSDT", interval: "1m", grafico: inicial, fuente: { nombre: "Binance" } };
  e.handlePayload(p);
  e.siguiendo = false;
  eje.rango = { from: 0, to: 2 };
  const nueva = armarGrafico(crudas.slice(80), cfg);
  e.handlePayload({ ...p, grafico: nueva });
  const completo = armarGrafico(inicial.velas.slice(0, 80).concat(nueva.velas).map(desdeGrafico), cfg);
  assert.equal(recalculadas.length, 101);
  assert.deepEqual(e.velas, completo.velas);
  assert.deepEqual(eje.rango, { from: 0, to: 2 });
  assert.deepEqual(e.s.ema[0].datos, completo.ema[0]);
  const referencia = motor().e;
  referencia.aplicarDatos(completo);
  assert.deepEqual(e.s.fuerza.datos, referencia.s.fuerza.datos);
  assert.deepEqual(e.s.compresion.datos, referencia.s.compresion.datos);
  assert.deepEqual(e.s.momento.datos, referencia.s.momento.datos);
  assert.equal(e.adxPorT.size, completo.fuerza.length);
  assert.notEqual(e.s.ema[0].datos[80].value, nueva.ema[0][0].value);
});

test("cambiar proveedor conserva una vista con datos sin mezclar historia anterior", () => {
  const { e, eje } = motor();
  const p = { type: "snapshot", symbol: "US100", interval: "1m", grafico: grafico([0, 60, 120].map((t) => vela(t))), fuente: { nombre: "Yahoo" } };
  e.handlePayload(p);
  e.siguiendo = false;
  eje.rango = { from: 0, to: 2 };
  e.handlePayload({ ...p, conservarVista: true, grafico: grafico([1000, 1060, 1120].map((t) => vela(t))), fuente: { nombre: "FTMO", broker: true } });
  assert.deepEqual(e.velas.map((v: any) => v.time), [1000, 1060, 1120]);
  assert.ok(eje.rango.from <= 2 && eje.rango.to >= 0);
  assert.equal(e.siguiendo, false);
});

test("reconectar siguiendo el precio conserva el zoom y muestra la última vela", () => {
  const { e, eje } = motor();
  const p = { type: "snapshot", symbol: "BTCUSDT", interval: "1m", grafico: grafico([0, 60, 120].map((t) => vela(t))) };
  e.handlePayload(p);
  eje.rango = { from: 0, to: 2 };
  e.handlePayload({ ...p, grafico: grafico([120, 180, 240].map((t) => vela(t))) });
  assert.equal(eje.rango.to - eje.rango.from, 2);
  assert.ok(eje.rango.from <= e.velas.length - 1 && eje.rango.to >= e.velas.length - 1);
  assert.equal(e.siguiendo, true);
});

test("entrar o saltar en replay encuadra el destino y conserva su historial separado del vivo", () => {
  const { e, eje } = motor();
  const p = { type: "snapshot", symbol: "US100", interval: "1m", grafico: grafico([1000, 1060, 1120].map((t) => vela(t))) };
  e.handlePayload(p);
  e.siguiendo = false;
  eje.rango = { from: 0, to: 1 };
  e.handlePayload({ ...p, replay: 500, grafico: grafico([0, 60, 120].map((t) => vela(t))) });
  assert.deepEqual(e.velas.map((v: any) => v.time), [0, 60, 120]);
  assert.equal(e.siguiendo, true);
});

test("más historia ordena y elimina duplicados sin desplazar la vista de más", () => {
  const { e, eje } = motor();
  e.aplicarDatos(grafico([vela(120), vela(180)]));
  eje.rango = { from: 0, to: 1 };
  const antiguas = [60, 0, 60].map((t) => [t, 100, 103, 99, 101, 10]);
  e.anteponer(antiguas, true, (s: any[]) => grafico(s.map((v) => vela(v.t, v.c))));
  assert.deepEqual(e.velas.map((v: any) => v.time), [0, 60, 120, 180]);
  assert.deepEqual(eje.rango, { from: 2, to: 3 });
  e.anteponer([], true, () => { throw Error("sin nuevas velas"); });
  assert.equal(e.sinMas, false);
});

test("la extrapolación de dibujos usa la temporalidad y no un hueco del fin de semana", () => {
  const { e } = motor();
  e.interval = "1h";
  e.velas = [vela(60), vela(60 + 3 * 86400)];
  assert.equal(e.paso(), 3600);
});

test("el eje aplica el horario histórico de Chile sin alterar timestamps UTC", () => {
  const { e } = motor();
  const invierno = Date.UTC(2026, 6, 15, 13, 30) / 1000;
  const verano = Date.UTC(2026, 0, 15, 13, 30) / 1000;
  const f = formateadoresTiempo("1m", "America/Santiago");
  assert.match(f.timeFormatter(invierno), /09:30/);
  assert.match(f.timeFormatter(verano), /10:30/);
  assert.equal(f.tickMarkFormatter(invierno, 3), "09:30");
  assert.equal(f.tickMarkFormatter(verano, 3), "10:30");
  e.snapshot(grafico([vela(invierno)]), true);
  assert.equal(e.s.velas.datos[0].time, invierno);
  assert.equal(e.velaEn(invierno).time, invierno);
});

test("el retroceso DST conserva dos velas con la misma hora local y distintos instantes", () => {
  const antes = Date.UTC(2026, 10, 1, 5, 30) / 1000;
  const despues = Date.UTC(2026, 10, 1, 6, 30) / 1000;
  const f = formateadoresTiempo("1m", "America/New_York");
  assert.equal(f.tickMarkFormatter(antes, 3), "01:30");
  assert.equal(f.tickMarkFormatter(despues, 3), "01:30");
  assert.notEqual(f.timeFormatter(antes), f.timeFormatter(despues));
  const { e } = motor();
  e.snapshot(grafico([vela(antes), vela(despues)]), true);
  assert.deepEqual(e.s.velas.datos.map((p: any) => p.time), [antes, despues]);
  assert.equal(e.velaEn(antes).time, antes);
  assert.equal(e.velaEn(despues).time, despues);
});

test("diario y temporalidades de varios días conservan su fecha UTC", () => {
  const t = Date.UTC(2026, 9, 30) / 1000;
  for (const intervalo of ["1d", "2d", "1w", "2w", "1M"]) {
    const f = formateadoresTiempo(intervalo, "America/Santiago");
    assert.match(f.timeFormatter(t), /30/);
    assert.equal(f.tickMarkFormatter(t, 2), "30");
  }
});

test("medir velas atraviesa el fin de semana sin contar barras inexistentes", () => {
  const { e } = motor();
  e.interval = "1h";
  const viernes = Date.UTC(2026, 9, 23, 20) / 1000;
  const lunes = Date.UTC(2026, 9, 26, 1) / 1000;
  e.velas = [vela(viernes), vela(lunes), vela(lunes + 3600), vela(lunes + 7200)];
  const d = Object.assign(Object.create(Dibujos.prototype), { e });
  assert.equal(e.indice(viernes), 0);
  assert.equal(e.indice(lunes), 1);
  assert.equal(d.tiempo(e.indice(lunes)), lunes);
  assert.match(d.duracion({ p1: { t: viernes }, p2: { t: lunes } }), /^1 vela · 2 d 5 h$/);
  assert.equal(d.tiempo(e.indice(viernes) + 3), lunes + 7200);
  assert.equal(d.tiempo(e.indice(lunes + 900)), lunes + 900);
});

test("arrastrar un dibujo entero conserva su ancho al cruzar un hueco del mercado", () => {
  const { e } = motor();
  e.interval = "1h";
  const viernes = Date.UTC(2026, 9, 23, 19) / 1000;
  const lunes = Date.UTC(2026, 9, 26, 1) / 1000;
  e.velas = [vela(viernes), vela(viernes + 3600), vela(lunes), vela(lunes + 3600)];
  e.price.timeScale().width = () => 500;
  e.altoPrecio = () => 300;
  e.cruzEn = () => {};
  const original = { tipo: "rect", p1: { t: viernes, p: 100 }, p2: { t: viernes + 3600, p: 105 } };
  const dibujo = structuredClone(original);
  const d = Object.assign(Object.create(Dibujos.prototype), {
    e, xy: () => ({ x: 100, y: 100 }),
    aDatos: () => ({ t: viernes + 3600, p: 102 }),
    arrastre: { d: dibujo, original, que: "todo", inicio: original.p1 },
  });
  d.move({ clientX: 100, clientY: 100 });
  assert.deepEqual(dibujo.p1, { t: viernes + 3600, p: 102 });
  assert.deepEqual(dibujo.p2, { t: lunes, p: 107 });
  assert.equal(e.indice(dibujo.p2.t) - e.indice(dibujo.p1.t), 1);
});

test("destruir el gráfico cancela repintados, animaciones y listeners táctiles", () => {
  const pendientes = new Map<number, FrameRequestCallback>();
  const anteriorRaf = globalThis.requestAnimationFrame, anteriorCancel = globalThis.cancelAnimationFrame;
  let id = 0, repintados = 0, quitados = 0, liberados = 0;
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => { pendientes.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = (n: number) => { pendientes.delete(n); };
  try {
    const { e } = motor();
    delete e.agendarDibujo;
    e.dibujar = () => { repintados++; };
    e.disposers = [() => { liberados++; }];
    e.price.remove = () => { quitados++; };
    e.lineasOrden = { finDedo: () => { liberados++; } };
    e.cancelarEleccion = () => { liberados++; };
    e.agendarDibujo();
    assert.equal(pendientes.size, 1);
    e.destroy();
    e.agendarDibujo();
    e.destroy();
    assert.equal(pendientes.size, 0);
    assert.equal(repintados, 0);
    assert.equal(quitados, 1);
    assert.equal(liberados, 3);
  } finally {
    globalThis.requestAnimationFrame = anteriorRaf;
    globalThis.cancelAnimationFrame = anteriorCancel;
  }
});
