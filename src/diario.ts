/* El diario de la cuenta: junta el historial que exporta el puente (v5) con el
 * estado de la cuenta, guarda lo calculado mientras el historial no cambie y le
 * pasa a Google Sheets lo nuevo. Tambien da la cabina de riesgo de la cuenta de
 * fondeo para la pantalla, que se recalcula con cada envio (es barata). */

import { config } from "./config.ts";
import {
  armarOperaciones, curvaBalance, type Deal, fechaEn, metricas, porDia, primerDeposito, relojDeals, riesgoCuenta, SlIniciales,
} from "./historial.ts";
import * as mt5 from "./mt5.ts";
import { Sheets } from "./sheets.ts";

export class Diario {
  sheets = new Sheets();
  private sl = new SlIniciales();
  private cache: { hist: any; balance: number | null; valor: any } | null = null;
  private avisado: any = null;          // el historial que ya se paso a Sheets
  private reloj: ReturnType<typeof setInterval> | null = null;
  private broker: mt5.BrokerBridge;

  constructor(broker: mt5.BrokerBridge) {
    this.broker = broker;
  }

  /** Revisa cada 10 s si hay historial nuevo para Google Sheets. */
  iniciar(): void {
    if (this.reloj || !this.sheets.estado.configurado) return;
    this.reloj = setInterval(() => this.revisar(), 10_000);
    this.reloj.unref?.();
    setTimeout(() => this.revisar(), 3_000).unref?.();
  }

  detener(): void {
    if (this.reloj) clearInterval(this.reloj);
    this.reloj = null;
  }

  /** El historial del puente, si es de la cuenta que esta publicando. */
  private historial(est: any): { deals: Deal[]; gmt: number | null; crudo: any } | null {
    const h = this.broker.historial();
    if (!h || !Array.isArray(h.deals)) return null;
    if (String(h.login ?? "") !== String(est.account?.login ?? "")) return null;
    return { deals: h.deals, gmt: mt5.num(h.gmt_offset), crudo: h };
  }

  private inicial(deals: Deal[] | null): { valor: number | null; origen: "env" | "historial" } {
    if (config.PROP_BALANCE_INICIAL > 0) return { valor: config.PROP_BALANCE_INICIAL, origen: "env" };
    return { valor: deals ? primerDeposito(deals) : null, origen: "historial" };
  }

  /** Las posiciones abiertas con lo necesario para medir su riesgo (precio de
   *  cierre y valor del punto de su simbolo). */
  private posiciones(est: any): any[] {
    return (est.positions ?? []).map((p: any) => {
      const s = mt5.buscar(est.symbols as Record<string, any>, String(p.symbol));
      return {
        ticket: p.ticket, tipo: p.type, volumen: mt5.num(p.volume) ?? 0, sl: mt5.num(p.sl) ?? 0,
        bid: mt5.num(s?.bid), ask: mt5.num(s?.ask), por_punto: s ? mt5.porPunto(s) : null,
      };
    });
  }

  /** El primer SL que se le vio a una posicion abierta. */
  slInicial(ticket: unknown): number | null {
    return this.sl.get(Number(ticket));
  }

  /** La cabina de riesgo: perdida del dia y maxima contra los limites de la firma. */
  riesgo(est: any) {
    if (!est?.available) return null;
    const posiciones = this.posiciones(est);
    this.sl.observar(posiciones);
    const h = this.historial(est);
    const ini = this.inicial(h?.deals ?? null);
    const cta = est.account ?? {};
    return riesgoCuenta({
      deals: h?.deals ?? null, aUtc: relojDeals(h?.gmt ?? mt5.num(est.gmt_offset)),
      balance: mt5.num(cta.balance) ?? 0, equity: mt5.num(cta.equity) ?? 0, posiciones,
      inicial: ini.valor, origenInicial: ini.origen,
      diariaPct: config.PROP_DIARIA_PCT, maximaPct: config.PROP_MAXIMA_PCT, zona: config.PROP_ZONA,
    });
  }

  /** Todo el historial: operaciones, metricas, dias, curva del balance y riesgo.
   *  Con `dias`, solo los ultimos dias (las metricas, recalculadas para ese tramo). */
  resumen(dias = 0): any {
    const est = this.broker.estado();
    const sheets = this.sheets.estado;
    if (!est.available) return { disponible: false, motivo: "MT5 no está conectado con el puente", sheets };
    const h = this.historial(est);
    if (!h) {
      return {
        disponible: false, sheets,
        motivo: est.version < 5 ? "Reiniciá MT5: el puente nuevo (v5) es el que exporta el historial de la cuenta"
          : "Esperando el historial del puente…",
      };
    }
    const cta = est.account ?? {};
    const balance = mt5.num(cta.balance);
    if (!this.cache || this.cache.hist !== h.crudo || this.cache.balance !== balance) {
      const aUtc = relojDeals(h.gmt);
      const info = (s: string) => mt5.buscar(est.symbols as Record<string, any>, s) ?? null;
      const operaciones = armarOperaciones(h.deals, { aUtc, info, slVisto: (t) => this.sl.get(t), magic: config.OPERADOR_MAGIC });
      const curva = curvaBalance(h.deals, aUtc, balance);
      const ini = this.inicial(h.deals);
      const limiteDiario = ini.valor && config.PROP_DIARIA_PCT > 0 ? (ini.valor * config.PROP_DIARIA_PCT) / 100 : null;
      this.cache = {
        hist: h.crudo, balance,
        valor: {
          disponible: true, moneda: cta.currency ?? "USD", zona: config.PROP_ZONA,
          inicial: ini.valor, origenInicial: ini.origen,
          limites: { diariaPct: config.PROP_DIARIA_PCT, maximaPct: config.PROP_MAXIMA_PCT },
          desde: Number(h.crudo.desde) ? Number(h.crudo.desde) * 1000 : null,
          operaciones, curva,
          metricas: metricas(operaciones, curva),
          dias: porDia(h.deals, operaciones, { aUtc, zona: config.PROP_ZONA, limiteDiario, balanceActual: balance }),
        },
      };
    }
    const todo = { ...this.cache.valor, riesgo: this.riesgo(est), sheets, rango: 0 };
    if (!(dias > 0)) return todo;
    const desde = Date.now() - dias * 86_400_000;
    const operaciones = todo.operaciones.filter((o: any) => o.cierre >= desde);
    // La curva arranca en el balance que habia al empezar el tramo.
    const previo = [...todo.curva].reverse().find((p: any) => p.t < desde);
    const curva = [...(previo ? [{ t: desde, balance: previo.balance }] : []), ...todo.curva.filter((p: any) => p.t >= desde)];
    const fDesde = fechaEn(desde, config.PROP_ZONA);
    return {
      ...todo, rango: dias, operaciones, curva, metricas: metricas(operaciones, curva),
      dias: todo.dias.filter((d: any) => d.fecha >= fDesde),
    };
  }

  /** Si hay historial nuevo, lo pasa a Google Sheets. */
  private revisar(): void {
    const r = this.resumen();
    if (!r.disponible || this.cache?.hist === this.avisado) return;
    this.avisado = this.cache?.hist ?? null;
    this.sheets.pedir({ operaciones: r.operaciones, dias: r.dias, metricas: r.metricas, riesgo: r.riesgo, moneda: r.moneda });
  }

  /** "Sincronizar ahora" desde la pantalla. */
  sincronizarYa(): any {
    const r = this.resumen();
    if (r.disponible) {
      this.avisado = this.cache?.hist ?? null;
      this.sheets.pedir({ operaciones: r.operaciones, dias: r.dias, metricas: r.metricas, riesgo: r.riesgo, moneda: r.moneda }, true);
    }
    return this.sheets.estado;
  }
}
