// Historial de la cuenta: operaciones armadas con los deals del puente, metricas,
// dias de la firma y cabina de riesgo de la cuenta de fondeo.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armarOperaciones, curvaBalance, type Deal, fechaEn, inicioDia, metricas, porDia, primerDeposito, riesgoCuenta, riesgoPlan,
} from "../src/historial.ts";

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 19, 9, 0);   // 19/10/2026 09:00 UTC
let siguiente = 1;
function deal(p: Partial<Deal>): Deal {
  return {
    ticket: siguiente++, order: 0, position: 0, time: 0, time_msc: T0, type: "buy", entry: "in", reason: "client",
    symbol: "BTCUSD", volume: 0.1, price: 0, sl: 0, tp: 0, profit: 0, commission: 0, swap: 0, fee: 0, magic: 0, comment: "",
    ...p,
  };
}
const aUtc = (d: Deal) => d.time_msc;
// BTCUSD en FTMO: 1 lote = 1 BTC, el punto vale 1 USD por lote.
const info = (s: string) => (s === "BTCUSD" ? { symbol: "BTCUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01, bid: 82000 } : null);

const deposito = deal({ type: "balance", entry: "", symbol: "", volume: 0, profit: 10_000, time_msc: T0 - 48 * H });
// Compra 0,10 a 80.000 con SL 79.000; cierra la mitad a mano en 81.000 y el resto por TP en 82.000.
const c1 = [
  deal({ position: 11, price: 80_000, sl: 79_000, tp: 82_000, commission: -2, magic: 770100, time_msc: T0 }),
  deal({ position: 11, type: "sell", entry: "out", volume: 0.05, price: 81_000, profit: 50, commission: -1, time_msc: T0 + 2 * H }),
  deal({ position: 11, type: "sell", entry: "out", volume: 0.05, price: 82_000, profit: 100, commission: -1, swap: -3, reason: "tp", time_msc: T0 + 5 * H }),
];
// Venta 0,10 a 82.000 sin SL al abrir; el SL (82.500) se vio despues; cierra por SL.
const v1 = [
  deal({ position: 12, type: "sell", price: 82_000, time_msc: T0 + 6 * H }),
  deal({ position: 12, type: "buy", entry: "out", price: 82_500, profit: -50, commission: -2, reason: "sl", time_msc: T0 + 7 * H }),
];
// Sigue abierta: cerrada en parte. No es una operacion todavia.
const abierta = [
  deal({ position: 13, price: 81_000, sl: 80_000, time_msc: T0 + 8 * H }),
  deal({ position: 13, type: "sell", entry: "out", volume: 0.05, price: 81_500, profit: 25, time_msc: T0 + 9 * H }),
];
const deals = [deposito, ...c1, ...v1, ...abierta];
const slVisto = (t: number) => (t === 12 ? 82_500 : null);

test("arma cada operacion con sus entradas y cierres parciales", () => {
  const ops = armarOperaciones(deals, { aUtc, info, slVisto, magic: 770100 });
  assert.equal(ops.length, 2, "la posicion cerrada en parte no cuenta");
  const [c, v] = ops;
  assert.equal(c.ticket, 11);
  assert.equal(c.lado, "compra");
  assert.equal(c.volumen, 0.1);
  assert.equal(c.entrada, 80_000);
  assert.equal(c.salida, 81_500);                    // promedio de 81.000 y 82.000
  assert.equal(c.bruto, 150);
  assert.equal(c.costos, -7);                         // comisiones -4 y swap -3
  assert.equal(c.resultado, 143);
  assert.equal(c.riesgo, 100);                        // 1.000 de distancia * 0,10
  assert.equal(c.r, 1.43);
  assert.equal(c.pips, 1500);
  assert.equal(c.cerradaPor, "tp");
  assert.equal(c.minutos, 300);
  assert.equal(c.desdeTerminal, true);
  // Sin SL al abrir: usa el primero que se vio; cerrada por SL.
  assert.equal(v.lado, "venta");
  assert.equal(v.slInicial, 82_500);
  assert.equal(v.resultado, -52);
  assert.equal(v.r, -1.04);
  assert.equal(v.pips, -500);
  assert.equal(v.cerradaPor, "sl");
  assert.equal(v.desdeTerminal, false);
});

test("el balance con que se dio la cuenta y la curva anclada al balance actual", () => {
  assert.equal(primerDeposito(deals), 10_000);
  const curva = curvaBalance(deals, aUtc);
  assert.equal(curva[0].balance, 10_000);
  assert.equal(curva.at(-1)!.balance, 10_000 - 2 + 49 + 96 - 52 + 25);
  // Si el historial no llega al deposito, se ancla al balance de la cuenta.
  const sinDeposito = curvaBalance(deals.slice(1), aUtc, 10_114);
  assert.equal(sinDeposito.at(-1)!.balance, 10_114);
  assert.equal(sinDeposito[0].balance, 9_996);   // 10.114 - 116 movidos + la primera comision (-2)
});

test("metricas en castellano: ganadoras, factor de beneficio, expectativa, rachas y caida", () => {
  const ops = armarOperaciones(deals, { aUtc, info, slVisto, magic: 770100 });
  const m = metricas(ops, curvaBalance(deals, aUtc));
  assert.equal(m.operaciones, 2);
  assert.equal(m.pctGanadoras, 50);
  assert.equal(m.neto, 91);
  assert.equal(m.factorBeneficio, 2.75);   // 143 / 52
  assert.equal(m.expectativa, 45.5);
  assert.ok(Math.abs(m.expectativaR! - 0.195) < 0.006);   // (1,43 - 1,04) / 2
  assert.equal(m.rachaGanadora, 1);
  assert.equal(m.rachaActual, -1);
  assert.equal(m.porMotivo.tp, 1);
  assert.equal(m.porMotivo.sl, 1);
  assert.equal(m.conSl, 100);
  assert.equal(m.porMercado[0].simbolo, "BTCUSD");
  // La peor caida del balance: del maximo (10.143) a 10.091 despues del SL.
  assert.equal(m.caidaMax, 52);
  assert.equal(m.distribucionR.find((t) => t.rotulo === "1 a 2")!.n, 1);
  assert.equal(m.distribucionR.find((t) => t.rotulo === "−1,5 a −1")!.n, 1);
});

test("el dia de la firma corta a medianoche de Praga, con horario de verano", () => {
  // 20/10/2026: Praga en verano (UTC+2) -> el dia empieza a las 22:00 UTC del 19.
  assert.equal(inicioDia(Date.UTC(2026, 9, 20, 10), "Europe/Prague"), Date.UTC(2026, 9, 19, 22));
  // 2/11/2026: ya en invierno (UTC+1) -> 23:00 UTC del dia anterior.
  assert.equal(inicioDia(Date.UTC(2026, 10, 2, 10), "Europe/Prague"), Date.UTC(2026, 10, 1, 23));
  // Un cierre a las 22:30 UTC ya es del dia siguiente en Praga.
  assert.equal(fechaEn(Date.UTC(2026, 9, 19, 22, 30), "Europe/Prague"), "2026-10-20");
  assert.equal(fechaEn(Date.UTC(2026, 9, 19, 21, 30), "Europe/Prague"), "2026-10-19");
});

test("resultado por dia: incluye cierres parciales y el uso del limite diario", () => {
  const ops = armarOperaciones(deals, { aUtc, info, slVisto });
  const dias = porDia(deals, ops, { aUtc, zona: "Europe/Prague", limiteDiario: 500, balanceActual: null });
  assert.equal(dias.length, 1);
  const d = dias[0];
  assert.equal(d.fecha, "2026-10-19");
  assert.equal(d.operaciones, 2);
  assert.equal(d.ganadas, 1);
  assert.equal(d.resultado, 116);          // todo lo realizado ese dia, con la posicion abierta en parte
  assert.equal(d.balance, 10_116);
  assert.equal(d.pctLimite, 0);
});

test("cabina de riesgo: perdida del dia y maxima contra los limites de FTMO", () => {
  const ahora = Date.UTC(2026, 9, 20, 12);                      // 20/10, 14:00 en Praga
  const hoy = [
    deal({ position: 21, price: 82_000, time_msc: Date.UTC(2026, 9, 20, 8) }),
    deal({ position: 21, type: "sell", entry: "out", price: 81_500, profit: -50, commission: -2, time_msc: Date.UTC(2026, 9, 20, 9) }),
  ];
  const r = riesgoCuenta({
    deals: [deposito, ...hoy], aUtc, balance: 9_489, equity: 9_492, inicial: 10_000, origenInicial: "historial",
    diariaPct: 5, maximaPct: 10, zona: "Europe/Prague", ahora,
    posiciones: [
      { tipo: "buy", volumen: 0.05, sl: 81_500, bid: 82_000, ask: 82_001, por_punto: 1 },
      { tipo: "sell", volumen: 0.1, sl: 0, bid: 4_000, ask: 4_000.5, por_punto: 100 },
    ],
  })!;
  assert.equal(r.balanceInicioDia, 9_541);          // 9.489 + lo perdido hoy (52)
  assert.equal(r.diaria!.limite, 500);
  assert.equal(r.diaria!.piso, 9_041);
  assert.equal(r.diaria!.usado, 49);                // 9.541 - 9.492
  assert.equal(r.maxima!.piso, 9_000);
  assert.equal(r.maxima!.usado, 508);
  assert.equal(r.disponible, 451);                  // el limite diario es el que esta mas cerca
  assert.equal(r.abierto, 25);                      // la compra pierde 25 mas si toca su SL
  assert.equal(r.sinSl, 1);
  assert.equal(r.siTocaSl, 426);
  assert.equal(r.inicioDia, Date.UTC(2026, 9, 19, 22));
  assert.equal(r.exacto, true);
  // Sin balance inicial no hay limites que medir.
  assert.equal(riesgoCuenta({ deals: null, aUtc, balance: 1, equity: 1, inicial: null, origenInicial: "historial",
    diariaPct: 5, maximaPct: 10, zona: "Europe/Prague", posiciones: [] }), null);
});

test("riesgo del plan: lo que queda hasta el limite / SL a aguantar, con tope en % del balance", () => {
  const r = (siTocaSl: number) => ({ siTocaSl, disponible: siTocaSl } as any);
  // 145,29 USD hasta el limite, 10 SL: 14 USD (el 0,5 % del balance, 45, no llega)
  assert.deepEqual(riesgoPlan(r(145.29), 9145.29, 0.5, 10), { usd: 14, colchon: 145.29, aguantar: 10, tope: 45 });
  // Con ganancias sube, hasta el tope; con perdidas baja.
  assert.equal(riesgoPlan(r(245), 9245, 0.5, 10)!.usd, 24);
  assert.equal(riesgoPlan(r(900), 9900, 0.5, 10)!.usd, 49);
  assert.equal(riesgoPlan(r(95), 9095, 0.5, 10)!.usd, 9);
  // Pasado el limite (o sin cuenta de fondeo): 0, o solo el % del balance.
  assert.equal(riesgoPlan(r(-20), 8980, 0.5, 10)!.usd, 0);
  assert.equal(riesgoPlan(null, 9145.29, 0.5, 10)!.usd, 45);
  assert.equal(riesgoPlan(r(145.29), 9145.29, 0.5, 0)!.usd, 45);
});
