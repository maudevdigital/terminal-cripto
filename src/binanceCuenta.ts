/* La cuenta de futuros USDⓈ-M de Binance: el saldo y las posiciones abiertas
 * (entrada, marca, liquidacion, resultado, apalancamiento) con su SL y TP, y las
 * ordenes que se piden desde el panel Operar: abrir a mercado o con limite (con SL y
 * TP), mover o quitar el SL y el TP, cerrar una posicion y cancelar una limite.
 *
 * Cada orden la confirma una persona en el panel, y aca se valida de nuevo antes de
 * mandarla: cantidad y precios redondeados a lo que acepta Binance, el minimo del
 * mercado, el SL y el TP del lado correcto y el SL obligatorio si se pide.
 * BINANCE_TRADING=false deja la cuenta solo para mirar.
 *
 * Necesita BINANCE_API_KEY y BINANCE_API_SECRET en el .env: una clave con permiso de
 * futuros, SIN retiros y con la IP restringida. */

import { createHmac } from "node:crypto";
import { config } from "./config.ts";
import { getLogger } from "./log.ts";
import { planCorte } from "./corte.ts";

const log = getLogger("binance-cuenta");

export interface PosicionBinance {
  simbolo: string;          // BTCUSDT
  lado: "buy" | "sell";
  cantidad: number;         // en la moneda (BTC)
  entrada: number;
  marca: number;
  liquidacion: number | null;
  pnl: number;              // no realizado, en USDT
  apalancamiento: number | null;
  margen: string;           // cross | isolated
  sl: number | null;
  tp: number | null;
}

/** Una orden limite de entrada que espera llenarse. */
export interface PendienteBinance {
  id: string;
  simbolo: string;
  lado: "buy" | "sell";
  cantidad: number;
  precio: number;
  sl: number | null;
  tp: number | null;
}

export interface CuentaBinance {
  disponible: boolean;
  motivo?: string;
  moneda: "USDT";
  saldo: number | null;      // wallet
  equity: number | null;     // saldo + no realizado
  libre: number | null;      // disponible para nuevas posiciones
  pnl: number | null;
  posiciones: PosicionBinance[];
  pendientes: PendienteBinance[];
  trading: boolean;
  slObligatorio: boolean;
  edad_s: number | null;
}

export interface PedidoBinance {
  accion: "abrir" | "niveles" | "cerrar" | "cancelar";
  symbol: string;
  lado: "buy" | "sell";       // el de la orden nueva, o el de la posicion (niveles, cerrar)
  tipo?: "mercado" | "limite";
  cantidad?: number;
  precio?: number;            // limite
  sl?: number | null;         // abrir y niveles: 0 o null = sin; en niveles, ausente = no se toca
  tp?: number | null;
  id?: string;                // cancelar
}

export interface ResultadoBinance {
  ok: boolean; mensaje: string; aviso?: string;
  estado?: "proteccion_incompleta";
  ejecutada?: boolean;
  orden?: { id: string; simbolo: string; lado: "buy" | "sell"; cantidad: number; precio: number; tipo: "mercado" | "limite" };
}

interface Filtros { tick: number; paso: number; pasoMercado: number; minimo: number; minimoMercado: number; nocionalMin: number }
interface Condicional { id: string; algo: boolean; precio: number }

const n = (x: unknown): number => Number(x);
const verdad = (x: unknown) => x === true || x === "true";
const decimalesDe = (paso: number) => {
  const [mantisa, exponente = "0"] = String(paso).toLowerCase().split("e");
  return Math.max(0, Math.min(12, (mantisa.split(".")[1]?.length ?? 0) - Number(exponente)));
};
/** Redondeo a un multiplo de `paso` (hacia abajo para cantidades). */
const aPaso = (x: number, paso: number, abajo = false) => {
  const k = abajo ? Math.floor(x / paso + 1e-9) : Math.round(x / paso);
  return Number((k * paso).toFixed(decimalesDe(paso)));
};

export class BinanceCuenta {
  private desfase = 0;                 // reloj de Binance - el nuestro (ms)
  private ultimo: CuentaBinance;
  private ms = 0;
  private reloj: ReturnType<typeof setInterval> | null = null;
  private ordenes: any[] = [];
  private ordenesMs = 0;
  private filtros: { ms: number; mapa: Map<string, Filtros> } | null = null;
  private cobertura: boolean | null = null;   // modo de posiciones Long/Short separadas (hedge)
  private corteIntentos = new Map<string, number>();
  private enCurso = new Set<string>();

  constructor() {
    this.ultimo = this.vacio(this.configurada ? "Conectando con Binance…" : "Sin la API key y el secret de Binance en el .env");
  }

  private vacio(motivo: string): CuentaBinance {
    return {
      disponible: false, motivo, moneda: "USDT", saldo: null, equity: null, libre: null, pnl: null,
      posiciones: [], pendientes: [], trading: config.BINANCE_TRADING, slObligatorio: config.BINANCE_SL_OBLIGATORIO, edad_s: null,
    };
  }

  get configurada(): boolean {
    return Boolean(config.BINANCE_API_KEY && config.BINANCE_API_SECRET);
  }

  iniciar(): void {
    if (!this.configurada || this.reloj) return;
    const tic = () => { void this.actualizar(); };
    tic();
    this.reloj = setInterval(tic, 5000);
    this.reloj.unref?.();
  }

  detener(): void {
    if (this.reloj) clearInterval(this.reloj);
    this.reloj = null;
  }

  estado(): CuentaBinance {
    return { ...this.ultimo, edad_s: this.ms ? Math.round((Date.now() - this.ms) / 1000) : null };
  }

  // ---------------------------------------------------------------- consultas

  /** Un pedido firmado. Los parametros van en la URL (Binance lo acepta tambien en POST y DELETE). */
  private async firmado(metodo: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now() + this.desfase) });
    const firma = createHmac("sha256", config.BINANCE_API_SECRET).update(qs.toString()).digest("hex");
    const r = await fetch(`${config.FUTURES_REST}${path}?${qs}&signature=${firma}`, {
      method: metodo,
      headers: { "X-MBX-APIKEY": config.BINANCE_API_KEY, "User-Agent": "cripto-terminal/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    const cuerpo = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(cuerpo?.msg ?? `HTTP ${r.status}`) as Error & { code?: number; status?: number };
      e.code = cuerpo?.code;
      e.status = r.status;
      if (e.code === -1021) await this.sincronizarReloj().catch(() => {});
      throw e;
    }
    return cuerpo;
  }

  private async sincronizarReloj(): Promise<void> {
    const r = await fetch(`${config.FUTURES_REST}/fapi/v1/time`, { signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    this.desfase = Number(j.serverTime) - Date.now();
  }

  /** Las ordenes abiertas: las comunes y las condicionales (SL y TP), que Binance
   *  tiene en su servicio de ordenes algoritmicas. */
  private async ordenesAbiertas(forzar = false): Promise<any[]> {
    if (!forzar && Date.now() - this.ordenesMs < 10_000) return this.ordenes;
    const listas = await Promise.all([
      this.firmado("GET", "/fapi/v1/openOrders"),
      this.firmado("GET", "/fapi/v1/openAlgoOrders").then((x) => {
        const ordenes = Array.isArray(x) ? x : x?.orders;
        if (!Array.isArray(ordenes)) throw new Error("Respuesta inválida de órdenes condicionales");
        return ordenes;
      }),
    ]);
    if (!Array.isArray(listas[0])) throw new Error("Respuesta inválida de órdenes abiertas");
    this.ordenes = listas.flat();
    this.ordenesMs = Date.now();
    return this.ordenes;
  }

  /** El SL o el TP puestos para un lado de un mercado (de una posicion o de una limite que espera). */
  private condicionales(ordenes: any[], simbolo: string, lado: "buy" | "sell", clase: "sl" | "tp"): Condicional[] {
    // El SL de una compra es una venta stop; el TP, una venta take profit (y al reves).
    const cierra = lado === "buy" ? "SELL" : "BUY";
    const tipos = clase === "sl" ? ["STOP_MARKET", "STOP"] : ["TAKE_PROFIT_MARKET", "TAKE_PROFIT"];
    return ordenes
      .filter((x) => x.symbol === simbolo && x.side === cierra && tipos.includes(String(x.type ?? x.orderType))
        && (verdad(x.closePosition) || verdad(x.reduceOnly)))
      .map((x) => ({ id: String(x.algoId ?? x.orderId), algo: x.algoId !== undefined, precio: n(x.stopPrice ?? x.triggerPrice) }))
      .filter((c) => c.precio > 0);
  }

  private async actualizar(): Promise<void> {
    try {
      const [cuenta, riesgo, ordenes] = await Promise.all([
        this.firmado("GET", "/fapi/v2/account"),
        this.firmado("GET", "/fapi/v2/positionRisk"),
        this.ordenesAbiertas(),
      ]);
      const nivel = (simbolo: string, lado: "buy" | "sell", clase: "sl" | "tp") => this.condicionales(ordenes, simbolo, lado, clase)[0]?.precio ?? null;
      const posiciones: PosicionBinance[] = (riesgo as any[])
        .filter((p) => n(p.positionAmt) !== 0)
        .map((p) => {
          const lado: "buy" | "sell" = n(p.positionAmt) > 0 ? "buy" : "sell";
          return {
            simbolo: String(p.symbol), lado, cantidad: Math.abs(n(p.positionAmt)),
            entrada: n(p.entryPrice), marca: n(p.markPrice),
            liquidacion: n(p.liquidationPrice) > 0 ? n(p.liquidationPrice) : null,
            pnl: n(p.unRealizedProfit), apalancamiento: n(p.leverage) > 0 ? n(p.leverage) : null,
            margen: String(p.marginType ?? "cross"),
            sl: nivel(String(p.symbol), lado, "sl"), tp: nivel(String(p.symbol), lado, "tp"),
          };
        });
      const pendientes: PendienteBinance[] = ordenes
        .filter((o) => o.orderId !== undefined && o.type === "LIMIT" && !verdad(o.reduceOnly) && !verdad(o.closePosition))
        .map((o) => {
          const lado: "buy" | "sell" = o.side === "BUY" ? "buy" : "sell";
          return {
            id: String(o.orderId), simbolo: String(o.symbol), lado, cantidad: n(o.origQty) - n(o.executedQty), precio: n(o.price),
            sl: nivel(String(o.symbol), lado, "sl"), tp: nivel(String(o.symbol), lado, "tp"),
          };
        });
      this.ultimo = {
        disponible: true, moneda: "USDT",
        saldo: n(cuenta.totalWalletBalance), equity: n(cuenta.totalMarginBalance),
        libre: n(cuenta.availableBalance), pnl: n(cuenta.totalUnrealizedProfit),
        posiciones, pendientes, trading: config.BINANCE_TRADING, slObligatorio: config.BINANCE_SL_OBLIGATORIO, edad_s: 0,
      };
      this.ms = Date.now();
      void this.corteAutomatico(posiciones).catch((e) => log.warn(`Corte automático: ${e}`));
    } catch (exc) {
      const e = exc as Error & { code?: number };
      if (e.code === -1021) return;
      const motivo = e.code === -2015 || e.code === -2014
        ? "Binance rechazó la API key: revisa que tenga permiso de futuros y que tu IP esté habilitada"
        : `No se pudo leer la cuenta de Binance: ${e.message}`;
      if (this.ultimo.motivo !== motivo) log.warn(motivo);
      // Si ya habia datos, quedan los ultimos (con su edad) hasta que vuelva.
      this.ultimo = this.ultimo.disponible ? { ...this.ultimo, motivo } : this.vacio(motivo);
    }
  }

  /** Corte automatico: a lo abierto sin SL se le pone uno en la perdida de
   *  CORTE_AUTO_USD (si ya la paso, no se toca). Cada posicion se reintenta como mucho
   *  cada 30 s. */
  private async corteAutomatico(posiciones: PosicionBinance[]): Promise<void> {
    const tope = config.CORTE_AUTO_USD;
    if (!(tope > 0) || !config.BINANCE_TRADING) return;
    const sinSl = posiciones.filter((p) => !p.sl);
    if (!sinSl.length) return;
    const abiertas = await Promise.all(sinSl.map(async (p) => ({
      id: `${p.simbolo}:${p.lado}`, lado: p.lado, entrada: p.entrada, actual: p.marca, sl: null, resultado: p.pnl,
      valorPorUnidad: p.cantidad, tick: (await this.filtrosDe(p.simbolo).catch(() => null))?.tick ?? null,
    })));
    for (const c of planCorte(abiertas, tope)) {
      if (Date.now() - (this.corteIntentos.get(c.id) ?? 0) < 30_000) continue;
      this.corteIntentos.set(c.id, Date.now());
      const p = sinSl.find((x) => `${x.simbolo}:${x.lado}` === c.id)!;
      const que = `${p.lado === "buy" ? "compra" : "venta"} ${p.cantidad} ${p.simbolo} en Binance`;
      const r = await this.enviar({ accion: "niveles", symbol: p.simbolo, lado: p.lado, sl: c.precio });
      log.warn(`Corte automático: ${que} estaba sin SL. ${r.ok ? `Le puse SL en ${c.precio} (pérdida máxima ${tope} USDT).` : `No se pudo poner el SL en ${c.precio}: ${r.mensaje}`}`);
    }
  }

  // ---------------------------------------------------------------- operar

  /** Tick, paso de cantidad y minimos de cada mercado (de exchangeInfo, una vez por hora). */
  private async filtrosDe(simbolo: string): Promise<Filtros | null> {
    if (!this.filtros || Date.now() - this.filtros.ms > 3_600_000) {
      const r = await fetch(`${config.FUTURES_REST}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json();
      const mapa = new Map<string, Filtros>();
      for (const s of j.symbols ?? []) {
        if (s.status !== "TRADING") continue;
        const f = (t: string) => (s.filters ?? []).find((x: any) => x.filterType === t) ?? {};
        mapa.set(s.symbol, {
          tick: n(f("PRICE_FILTER").tickSize), paso: n(f("LOT_SIZE").stepSize), minimo: n(f("LOT_SIZE").minQty),
          pasoMercado: n(f("MARKET_LOT_SIZE").stepSize) || n(f("LOT_SIZE").stepSize),
          minimoMercado: n(f("MARKET_LOT_SIZE").minQty) || n(f("LOT_SIZE").minQty),
          nocionalMin: n(f("MIN_NOTIONAL").notional) || 0,
        });
      }
      this.filtros = { ms: Date.now(), mapa };
    }
    return this.filtros.mapa.get(simbolo) ?? null;
  }

  private async enCobertura(): Promise<boolean> {
    if (this.cobertura === null) this.cobertura = verdad((await this.firmado("GET", "/fapi/v1/positionSide/dual")).dualSidePosition);
    return this.cobertura;
  }

  private async precioMarca(simbolo: string): Promise<number> {
    const r = await fetch(`${config.FUTURES_REST}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(simbolo)}`, { signal: AbortSignal.timeout(10_000) });
    return n((await r.json()).markPrice);
  }

  /** Pone un SL o un TP que cierra toda la posicion de ese lado, por precio de marca.
   *  Va por el servicio de ordenes algoritmicas; si la cuenta todavia no lo tiene, por
   *  el endpoint de siempre. */
  private async ponerCondicional(simbolo: string, lado: "buy" | "sell", clase: "sl" | "tp", precio: number, cobertura: boolean): Promise<void> {
    const comun: Record<string, string> = {
      symbol: simbolo, side: lado === "buy" ? "SELL" : "BUY", type: clase === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      closePosition: "true", workingType: "MARK_PRICE", priceProtect: "true",
      ...(cobertura ? { positionSide: lado === "buy" ? "LONG" : "SHORT" } : {}),
    };
    try {
      await this.firmado("POST", "/fapi/v1/algoOrder", { ...comun, algoType: "CONDITIONAL", triggerPrice: String(precio) });
    } catch (e) {
      const err = e as Error & { status?: number; code?: number };
      // Sin el servicio nuevo (404) o sin conocer sus parametros: por el de siempre.
      if (err.status !== 404 && err.code !== -1100 && err.code !== -1101 && err.code !== -1102 && err.code !== -1104) throw e;
      await this.firmado("POST", "/fapi/v1/order", { ...comun, stopPrice: String(precio) });
    }
  }

  private async quitarCondicional(simbolo: string, c: Condicional): Promise<void> {
    if (c.algo) await this.firmado("DELETE", "/fapi/v1/algoOrder", { algoId: c.id });
    else await this.firmado("DELETE", "/fapi/v1/order", { symbol: simbolo, orderId: c.id });
  }

  /** El SL y el TP del lado correcto de un precio de referencia. */
  private problemaNiveles(lado: "buy" | "sell", ref: number, sl: number | null | undefined, tp: number | null | undefined): string | null {
    const compra = lado === "buy";
    if (sl && (compra ? sl >= ref : sl <= ref)) return `El SL de una ${compra ? "compra va debajo" : "venta va arriba"} del precio (${ref})`;
    if (tp && (compra ? tp <= ref : tp >= ref)) return `El TP de una ${compra ? "compra va arriba" : "venta va debajo"} del precio (${ref})`;
    return null;
  }

  private explicar(e: unknown): string {
    const err = e as Error & { code?: number };
    if (err.code === -2015 || err.code === -2014) return "Binance rechazó la API key: necesita permiso de futuros (trading) y tu IP habilitada";
    if (err.code === -2019) return "Margen insuficiente para esa orden";
    if (err.code === -2021) return "El SL o el TP se activaría en el acto: está del lado equivocado del precio de marca";
    if (err.code === -4164) return "La orden es más chica que el mínimo de Binance para ese mercado";
    return `Binance: ${err.message}`;
  }

  async enviar(p: PedidoBinance): Promise<ResultadoBinance> {
    const clave = String(p.symbol ?? "").toUpperCase();
    if (this.enCurso.has(clave)) return { ok: false, mensaje: "Ya hay un pedido en curso para este mercado; espera su respuesta antes de repetirlo" };
    this.enCurso.add(clave);
    let resultado: ResultadoBinance;
    try { resultado = await this.ejecutar(p); } finally { this.enCurso.delete(clave); }
    if (resultado.ok || resultado.ejecutada) {
      this.ordenesMs = 0;
      void this.actualizar();
    }
    return resultado;
  }

  private async ejecutar(p: PedidoBinance): Promise<ResultadoBinance> {
    if (!config.BINANCE_TRADING) return { ok: false, mensaje: "La operativa de Binance está apagada (BINANCE_TRADING=false en el .env)" };
    if (!this.configurada) return { ok: false, mensaje: "Falta la API key y el secret de Binance en el .env" };
    if (!this.ultimo.disponible) return { ok: false, mensaje: this.ultimo.motivo ?? "La cuenta de Binance no responde" };
    const simbolo = String(p.symbol ?? "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(simbolo)) return { ok: false, mensaje: "Mercado inválido" };
    if (p.lado !== "buy" && p.lado !== "sell") return { ok: false, mensaje: "Falta el lado (compra o venta)" };
    for (const campo of ["cantidad", "precio", "sl", "tp"] as const) {
      const valor = p[campo];
      if (valor != null && (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0)) {
        return { ok: false, mensaje: `El campo ${campo} debe ser un número válido, mayor o igual a cero` };
      }
    }
    try {
      const f = await this.filtrosDe(simbolo);
      if (!f) return { ok: false, mensaje: `${simbolo} no se opera en Binance Futures` };
      const cobertura = await this.enCobertura();
      const lado = p.lado;
      const ladoPos: Record<string, string> = cobertura ? { positionSide: lado === "buy" ? "LONG" : "SHORT" } : {};
      const precioOk = (x: unknown) => Number.isFinite(n(x)) && n(x) > 0;
      const redondear = (x: number | null | undefined) => (precioOk(x) ? aPaso(n(x), f.tick) : null);
      let r: ResultadoBinance;

      if (p.accion === "abrir") {
        if (p.tipo !== undefined && p.tipo !== "mercado" && p.tipo !== "limite") return { ok: false, mensaje: "Elige a mercado o límite" };
        const limite = p.tipo === "limite";
        const marca = await this.precioMarca(simbolo);
        const entrada = limite ? redondear(p.precio) : marca;
        if (!entrada) return { ok: false, mensaje: "Falta el precio límite" };
        if (limite && (lado === "buy" ? entrada >= marca : entrada <= marca)) {
          return { ok: false, mensaje: `La ${lado === "buy" ? "compra límite va debajo" : "venta límite va arriba"} del precio (${marca})` };
        }
        const cantidad = aPaso(n(p.cantidad), limite ? f.paso : f.pasoMercado, true);
        if (!(cantidad >= (limite ? f.minimo : f.minimoMercado))) return { ok: false, mensaje: `La cantidad mínima en ${simbolo} es ${limite ? f.minimo : f.minimoMercado}` };
        if (f.nocionalMin && cantidad * entrada < f.nocionalMin) return { ok: false, mensaje: `La orden tiene que valer al menos ${f.nocionalMin} USDT` };
        const sl = redondear(p.sl), tp = redondear(p.tp);
        if (config.BINANCE_SL_OBLIGATORIO && !sl) return { ok: false, mensaje: "Falta el stop loss (BINANCE_SL_OBLIGATORIO)" };
        const malo = this.problemaNiveles(lado, entrada, sl, tp);
        if (malo) return { ok: false, mensaje: malo };
        const o = await this.firmado("POST", "/fapi/v1/order", {
          symbol: simbolo, side: lado === "buy" ? "BUY" : "SELL", type: limite ? "LIMIT" : "MARKET", quantity: String(cantidad),
          ...(limite ? { price: String(entrada), timeInForce: "GTC" } : {}), ...ladoPos, newOrderRespType: "RESULT",
        });
        const fallas: string[] = [];
        let slConfirmado = false;
        for (const [clase, nivel] of [["sl", sl], ["tp", tp]] as const) {
          if (!nivel) continue;
          try {
            await this.ponerCondicional(simbolo, lado, clase, nivel, cobertura);
            if (clase === "sl") slConfirmado = true;
          } catch (e) { fallas.push(`${clase.toUpperCase()}: ${this.explicar(e)}`); }
        }
        const hecho = limite ? `Límite puesta: ${lado === "buy" ? "compra" : "venta"} ${cantidad} ${simbolo} a ${entrada}`
          : `${lado === "buy" ? "Compra" : "Venta"} ${cantidad} ${simbolo} a mercado${n(o.avgPrice) > 0 ? ` a ${n(o.avgPrice)}` : ""}`;
        r = config.BINANCE_SL_OBLIGATORIO && !slConfirmado
          ? {
            ok: false, estado: "proteccion_incompleta", ejecutada: true,
            orden: { id: String(o.orderId ?? ""), simbolo, lado, cantidad, precio: n(o.avgPrice) || entrada, tipo: limite ? "limite" : "mercado" },
            mensaje: `${hecho}. No se pudo confirmar el stop loss obligatorio. Revisa la posición y su protección antes de repetir el pedido.`,
            aviso: fallas.join(" · "),
          }
          : fallas.length
          ? { ok: true, mensaje: hecho, aviso: `¡Ojo! La orden entró pero no se pudo poner ${fallas.join(" · ")}. Ponlo ahora.` }
          : { ok: true, mensaje: hecho + (sl ? ` · SL ${sl}` : "") + (tp ? ` · TP ${tp}` : "") };
      } else if (p.accion === "niveles") {
        // Mover, poner o quitar el SL y el TP de una posicion (o de una limite que espera).
        const ordenes = await this.ordenesAbiertas(true);
        const marca = await this.precioMarca(simbolo);
        const cambios: string[] = [];
        const fallas: string[] = [];
        const tocar = { sl: p.sl !== undefined, tp: p.tp !== undefined };
        const nuevos = { sl: redondear(p.sl), tp: redondear(p.tp) };
        if (tocar.sl && config.BINANCE_SL_OBLIGATORIO && !nuevos.sl) return { ok: false, mensaje: "No se puede quitar el stop loss (BINANCE_SL_OBLIGATORIO)" };
        const malo = this.problemaNiveles(lado, marca, tocar.sl ? nuevos.sl : null, tocar.tp ? nuevos.tp : null);
        if (malo) return { ok: false, mensaje: malo };
        for (const clase of ["sl", "tp"] as const) {
          if (!tocar[clase]) continue;
          const viejos = this.condicionales(ordenes, simbolo, lado, clase);
          const nivel = nuevos[clase];
          if (nivel && viejos.length === 1 && viejos[0].precio === nivel) continue;
          try {
            // Primero el nuevo y despues se quita el viejo: nunca queda sin SL por un error.
            if (nivel) await this.ponerCondicional(simbolo, lado, clase, nivel, cobertura);
            for (const v of viejos) await this.quitarCondicional(simbolo, v);
            cambios.push(nivel ? `${clase.toUpperCase()} ${nivel}` : `sin ${clase.toUpperCase()}`);
          } catch (e) {
            fallas.push(`${clase.toUpperCase()}: ${this.explicar(e)}`);
          }
        }
        if (fallas.length) r = { ok: cambios.length > 0, mensaje: cambios.length ? `Listo: ${cambios.join(" · ")}` : fallas.join(" · "), ...(cambios.length ? { aviso: fallas.join(" · ") } : {}) };
        else r = { ok: true, mensaje: cambios.length ? `Listo: ${cambios.join(" · ")}` : "No había nada que cambiar" };
      } else if (p.accion === "cerrar") {
        const riesgo: any[] = await this.firmado("GET", "/fapi/v2/positionRisk", { symbol: simbolo });
        const pos = riesgo.find((x) => n(x.positionAmt) !== 0 && (n(x.positionAmt) > 0) === (lado === "buy")
          && (!cobertura || x.positionSide === (lado === "buy" ? "LONG" : "SHORT")));
        if (!pos) return { ok: false, mensaje: `No hay una ${lado === "buy" ? "compra" : "venta"} abierta en ${simbolo}` };
        const cantidad = Math.abs(n(pos.positionAmt));
        await this.firmado("POST", "/fapi/v1/order", {
          symbol: simbolo, side: lado === "buy" ? "SELL" : "BUY", type: "MARKET", quantity: String(cantidad),
          ...(cobertura ? ladoPos : { reduceOnly: "true" }), newOrderRespType: "RESULT",
        });
        // Su SL y su TP ya no sirven.
        let aviso: string | undefined;
        try {
          const ordenes = await this.ordenesAbiertas(true);
          for (const c of [...this.condicionales(ordenes, simbolo, lado, "sl"), ...this.condicionales(ordenes, simbolo, lado, "tp")]) {
            await this.quitarCondicional(simbolo, c);
          }
        } catch (e) {
          aviso = `La posición se cerró, pero no se pudo comprobar o retirar su SL/TP: ${this.explicar(e)}`;
        }
        r = { ok: true, mensaje: `Cerrada: ${lado === "buy" ? "compra" : "venta"} ${cantidad} ${simbolo} a mercado`, ...(aviso ? { aviso } : {}) };
      } else if (p.accion === "cancelar") {
        if (!/^\d+$/.test(String(p.id ?? ""))) return { ok: false, mensaje: "Falta la orden a cancelar" };
        await this.firmado("DELETE", "/fapi/v1/order", { symbol: simbolo, orderId: String(p.id) });
        // Sin posicion de ese lado, su SL y su TP quedan sueltos: se quitan.
        let aviso: string | undefined;
        try {
          const riesgo: any[] = await this.firmado("GET", "/fapi/v2/positionRisk", { symbol: simbolo });
          const hayPos = riesgo.some((x) => n(x.positionAmt) !== 0 && (n(x.positionAmt) > 0) === (lado === "buy"));
          const otraLimite = (await this.ordenesAbiertas(true)).some((o) => o.symbol === simbolo && o.type === "LIMIT" && o.side === (lado === "buy" ? "BUY" : "SELL") && !verdad(o.reduceOnly));
          if (!hayPos && !otraLimite) {
            for (const c of [...this.condicionales(this.ordenes, simbolo, lado, "sl"), ...this.condicionales(this.ordenes, simbolo, lado, "tp")]) {
              await this.quitarCondicional(simbolo, c);
            }
          }
        } catch (e) {
          aviso = `La orden se canceló, pero no se pudo comprobar o retirar su SL/TP: ${this.explicar(e)}`;
        }
        r = { ok: true, mensaje: `Orden cancelada en ${simbolo}`, ...(aviso ? { aviso } : {}) };
      } else {
        return { ok: false, mensaje: "Acción desconocida" };
      }
      log.info(`Binance ${p.accion} ${simbolo} ${lado}: ${r.mensaje}${r.aviso ? ` · ${r.aviso}` : ""}`);
      return r;
    } catch (e) {
      const mensaje = this.explicar(e);
      log.warn(`Binance ${p.accion} ${simbolo}: ${mensaje}`);
      return { ok: false, mensaje };
    }
  }
}
