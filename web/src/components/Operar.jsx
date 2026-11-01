import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, fmtNum } from "../lib/format.js";
import { avisoPendiente, estadoHorario, mercadoCerrado } from "../lib/horario.js";
import { FrenoEstado } from "./FrenoEstado.jsx";
import PausaReal from "./PausaReal.jsx";
import { CabinaRiesgo } from "./Riesgo.jsx";
import { RevisionOrden } from "./CompraRapida.jsx";
import useRevisionOrden from "../hooks/useRevisionOrden.js";
import {
  calcularOrden, decVol, destino, enviar, enviarBinance, esCompra, esPendiente, faltaParaOperar, nombreOperacion, num, ok, pedidoModificar, problemaCambio, problemaNumero, resultadoEn,
} from "../lib/operativa.js";

const signo = (x, d = 2) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), d)}`;
/** Decimales de un precio del broker (los que trae el numero). */
const decimales = (x) => Math.min(5, String(x ?? "").split(".")[1]?.length ?? 2);


/** Lo que falta para poder operar, en orden. */
function Preparacion({ broker }) {
  const op = broker?.operador ?? {};
  const login = broker?.cuenta?.login;
  const pasos = [
    [broker?.disponible && broker?.vivo, "MT5 abierto con el puente", "Abrí MT5 (npm run dev lo abre solo)."],
    [broker?.trading, "Operativa activada en la terminal", "TRADING_ACTIVO=true en el .env."],
    [op.vivo, "EA CriptoTerminalOperador corriendo", "En MT5: Navegador › Asesores › CriptoTerminal › CriptoTerminalOperador, arrastralo a cualquier gráfico."],
    [op.vivo && op.habilitado, "Operador habilitado para tu cuenta",
      op.motivo || `En las propiedades del EA: InpCuenta = ${login || "tu login"} y tildá "Permitir trading algorítmico". Activá Algo Trading en la barra de MT5.`],
  ];
  if (pasos.every(([hecho]) => hecho)) return null;
  return (
    <div className="dato preparacion">
      <small>Para operar desde la terminal</small>
      <ol>
        {pasos.map(([hecho, titulo, ayuda]) => (
          <li key={titulo} className={hecho ? "hecho" : ""}>
            <b>{hecho ? "✓" : "·"} {titulo}</b>
            {!hecho && <span className="tenue">{ayuda}</span>}
          </li>
        ))}
      </ol>
      {broker?.desactualizado && <span className="aviso-mt5">Reinicia MT5 para cargar la versión nueva del puente (trae el calendario económico de MT5, con el dato real de cada noticia).</span>}
    </div>
  );
}

/** Abierto, cierra pronto o cerrado en el broker, con los proximos horarios. */
function HorarioMercado({ broker }) {
  const h = broker?.horario;
  const e = estadoHorario(h);
  if (!e) return null;
  return (
    <div className={`dato horario-panel ${e.estado}`}>
      <span className={`horario-mercado ${e.estado}`}><i />{broker.simbolo} · {e.texto}</span>
      {e.estado !== "abierto" && (
        <span className="tenue">
          {e.estado === "cerrado"
            ? "Con el mercado cerrado no se puede abrir, cerrar, cancelar ni mover nada: las órdenes pendientes siguen vivas y pueden ejecutarse al reabrir."
            : "Si tienes órdenes pendientes que no quieres que se ejecuten al reabrir, cancélalas antes del cierre."}
        </span>
      )}
    </div>
  );
}

/** El capital de la cuenta: balance, equity, lo que va flotando y el margen libre,
 *  con los limites de la cuenta de fondeo debajo. */
function Cuenta({ broker, moneda }) {
  const c = broker.cuenta ?? {};
  const flotante = [...(broker.posiciones ?? []), ...(broker.otras ?? [])].reduce((x, p) => x + (p.profit ?? 0) + (p.swap ?? 0), 0);
  const plata = (x) => (Number.isFinite(x) ? fmtNum(x, 2) : "—");
  return (
    <div className="dato cuenta">
      <span className="fila"><small>Cuenta {c.login || "—"}</small><span className="tenue">{c.servidor}</span></span>
      <div className="cuenta-cifras">
        <span><small>Balance</small><b>{plata(c.balance)}</b></span>
        <span><small>Equity</small><b>{plata(c.equity)}</b></span>
        <span><small>Flotante</small><b className={flotante > 0 ? "pos" : flotante < 0 ? "neg" : ""}>{signo(flotante)}</b></span>
        <span><small>Margen libre</small><b>{plata(broker.margenLibre)}</b></span>
      </div>
      <CabinaRiesgo riesgo={broker.riesgo} moneda={moneda} />
    </div>
  );
}

/** Lo que contesta Binance a una orden (con el aviso si algo quedo a medias). */
function ResultadoBinance({ r }) {
  if (!r) return null;
  return (
    <span className={`op-resultado ${r.ok ? "pos" : "neg"}`}>
      {r.ok ? "✓ " : "✗ "}{r.mensaje}
      {r.aviso && <><br /><b className="neg">{r.aviso}</b></>}
    </span>
  );
}

/** Una posicion de Binance (o una limite que espera): mover o quitar su SL y su TP,
 *  cerrarla a mercado o cancelarla. Todo con confirmacion. */
function PosicionBinance({ p, pendiente, b, falta, onSymbol, cfg, alResultado }) {
  const [modo, setModo] = useState(null);   // null | "editar" | "cerrar"
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [enviando, setEnviando] = useState(false);
  const enviandoRef = useRef(false);
  const compra = p.lado === "buy";
  const d = (x) => decimales(x);
  const ref = pendiente ? p.precio : p.marca;
  const leer = (x) => (String(x).trim() === "" ? 0 : num(x));
  const nuevo = { sl: leer(sl), tp: leer(tp) };
  const cambia = nuevo.sl !== (p.sl ?? 0) || nuevo.tp !== (p.tp ?? 0);
  const problema = problemaNumero(sl, "el SL") || problemaNumero(tp, "el TP") || (Number.isNaN(nuevo.sl) ? "Revisa el SL" : Number.isNaN(nuevo.tp) ? "Revisa el TP"
    : b.slObligatorio && !ok(nuevo.sl) ? "No se puede dejar sin stop loss (BINANCE_SL_OBLIGATORIO)"
    : ok(nuevo.sl) && (compra ? nuevo.sl >= ref : nuevo.sl <= ref) ? `El SL de una ${compra ? "compra va debajo" : "venta va arriba"} del precio`
    : ok(nuevo.tp) && (compra ? nuevo.tp <= ref : nuevo.tp >= ref) ? `El TP de una ${compra ? "compra va arriba" : "venta va debajo"} del precio`
    : null);
  // Lo que se gana o se pierde en un nivel, con la cantidad de la posicion.
  const enUsd = (nivel) => (ok(nivel) ? (compra ? 1 : -1) * (nivel - (pendiente ? p.precio : p.entrada)) * p.cantidad : NaN);
  const accion = async (cuerpo) => {
    if (enviandoRef.current || falta) return;
    enviandoRef.current = true;
    setEnviando(true);
    const r = await enviarBinance(cuerpo);
    setEnviando(false);
    enviandoRef.current = false;
    alResultado(r);
    if (r.ok || r.estado === "sin_respuesta") setModo(null);
  };
  const enTerminal = cfg?.symbols?.includes(p.simbolo);
  return (
    <li className={`op-posicion ${compra ? "compra" : "venta"}`}>
      <span className="fila">
        <b className="texto">{compra ? "Compra" : "Venta"}{pendiente ? " límite" : ""} {fmtNum(p.cantidad, decVol(p.cantidad))} · {p.simbolo}{p.apalancamiento ? ` · ×${p.apalancamiento}` : ""}</b>
        {!pendiente && <b className={p.pnl >= 0 ? "pos" : "neg"}>{signo(p.pnl)} USDT</b>}
      </span>
      <span className="fila tenue">
        <span>{pendiente ? `Precio ${fmt(p.precio, d(p.precio))}` : `Entrada ${fmt(p.entrada, d(p.entrada))} · marca ${fmt(p.marca, d(p.marca))}`}</span>
      </span>
      <span className="fila tenue">
        <span>SL {p.sl ? `${fmt(p.sl, d(p.sl))} (${signo(enUsd(p.sl))})` : "—"} · TP {p.tp ? `${fmt(p.tp, d(p.tp))} (${signo(enUsd(p.tp))})` : "—"}</span>
        {!pendiente && <span>liquidación {p.liquidacion ? fmt(p.liquidacion, d(p.liquidacion)) : "—"}</span>}
      </span>
      {modo === null && (
        <span className="op-acciones">
          <button onClick={() => { setSl(p.sl ? String(p.sl) : ""); setTp(p.tp ? String(p.tp) : ""); setModo("editar"); }}>SL / TP</button>
          <button className="peligro" onClick={() => setModo("cerrar")}>{pendiente ? "Cancelar orden" : "Cerrar"}</button>
          {enTerminal && onSymbol && <button className="tenue" onClick={() => onSymbol(p.simbolo)}>Ver en el gráfico ›</button>}
        </span>
      )}
      {modo === "editar" && (
        <div className="op-modificar">
          <label className="op-mod-fila">
            <span>SL</span>
            <input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" placeholder="sin SL" />
            <span className="neg">{ok(nuevo.sl) ? `${signo(enUsd(nuevo.sl))} USDT` : ""}</span>
          </label>
          <label className="op-mod-fila">
            <span>TP</span>
            <input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" placeholder="sin TP" />
            <span className="pos">{ok(nuevo.tp) ? `${signo(enUsd(nuevo.tp))} USDT` : ""}</span>
          </label>
          <span className="op-atajos">
            {!pendiente && <button onClick={() => setSl(String(p.entrada))} title="Mueve el SL al precio de entrada">SL a la entrada</button>}
            <button onClick={() => setTp("")}>Sin TP</button>
            {!b.slObligatorio && <button onClick={() => setSl("")}>Sin SL</button>}
            <button onClick={() => { setSl(p.sl ? String(p.sl) : ""); setTp(p.tp ? String(p.tp) : ""); }}>Como estaba</button>
          </span>
          {cambia && problema && <span className="op-error">{problema}</span>}
          {cambia && !problema && falta && <span className="op-error">Para mandarlo: {falta}</span>}
          <span className="op-acciones">
            <button className="boton-orden confirmar" disabled={!cambia || Boolean(problema || falta) || enviando}
                    onClick={() => accion({ accion: "niveles", symbol: p.simbolo, lado: p.lado, sl: nuevo.sl, tp: nuevo.tp })}>
              {enviando ? "Enviando a Binance…" : "Guardar en Binance"}
            </button>
            <button className="tenue" onClick={() => setModo(null)}>Volver</button>
          </span>
        </div>
      )}
      {modo === "cerrar" && (
        <span className="op-editar">
          <span>{pendiente ? "¿Cancelar la orden límite?" : `¿Cerrar a mercado ${fmtNum(p.cantidad, decVol(p.cantidad))} ${p.simbolo}?`}</span>
          <button className="peligro" disabled={enviando || Boolean(falta)} title={falta ?? ""}
                  onClick={() => accion(pendiente ? { accion: "cancelar", symbol: p.simbolo, lado: p.lado, id: p.id } : { accion: "cerrar", symbol: p.simbolo, lado: p.lado })}>
            {enviando ? "Enviando…" : pendiente ? "Sí, cancelar" : "Sí, cerrar"}
          </button>
          <button className="tenue" onClick={() => setModo(null)}>No</button>
          {falta && <span className="op-error">Para mandarlo: {falta}</span>}
        </span>
      )}
    </li>
  );
}

/** Por que todavia no se puede mandar nada a Binance (null: se puede). */
function faltaBinance(b, freno, abrir = false) {
  if (!b?.disponible) return b?.motivo ?? "La cuenta de Binance no responde";
  if (!b.trading) return "La operativa de Binance está apagada (BINANCE_TRADING=false en el .env)";
  if (abrir && freno?.bloquea) return `Freno de disciplina: ${freno.motivos.join(" y ")}`;
  return null;
}

/** La cuenta de futuros de Binance: saldo, posiciones y limites que esperan, con
 *  sus SL y TP para mover, y cerrar o cancelar. */
function CuentaBinance({ b, onSymbol, cfg, mostrarRevision = true }) {
  const [resultado, setResultado] = useState(null);
  const { revision, marcarRevision, confirmarRevision } = useRevisionOrden("binance");
  const alResultado = (r) => { setResultado(r); marcarRevision(r); };
  if (!b) return null;
  const plata = (x) => (Number.isFinite(x) ? fmtNum(x, 2) : "—");
  const falta = faltaBinance(b, null);
  return (
    <div className="dato binance">
      <span className="fila">
        <small>Binance · futuros</small>
        <span className="tenue">{b.trading ? "USDⓈ-M" : "solo para mirar"}</span>
      </span>
      {!b.disponible ? <span className="tenue">{b.motivo}</span> : (
        <>
          <div className="cuenta-cifras">
            <span><small>Saldo</small><b>{plata(b.saldo)}</b></span>
            <span><small>Equity</small><b>{plata(b.equity)}</b></span>
            <span><small>No realizado</small><b className={b.pnl > 0 ? "pos" : b.pnl < 0 ? "neg" : ""}>{Number.isFinite(b.pnl) ? signo(b.pnl) : "—"}</b></span>
            <span><small>Disponible</small><b>{plata(b.libre)}</b></span>
          </div>
          {b.motivo && <span className="aviso-cierre">{b.motivo} (datos de hace {b.edad_s ?? "?"} s)</span>}
          {!b.posiciones.length && !b.pendientes?.length && <span className="tenue">Sin posiciones ni órdenes abiertas.</span>}
          <ul className="op-lista">
            {b.posiciones.map((p) => (
              <PosicionBinance key={`p${p.simbolo}${p.lado}`} p={p} b={b} falta={falta} onSymbol={onSymbol} cfg={cfg} alResultado={alResultado} />
            ))}
            {(b.pendientes ?? []).map((p) => (
              <PosicionBinance key={`o${p.id}`} p={p} pendiente b={b} falta={falta} onSymbol={onSymbol} cfg={cfg} alResultado={alResultado} />
            ))}
          </ul>
          <ResultadoBinance r={revision ? null : resultado} />
        </>
      )}
      {mostrarRevision && <RevisionOrden revision={revision} alRevisar={confirmarRevision} />}
    </div>
  );
}

/** Orden nueva en Binance (futuros) para el mercado del grafico: a mercado o limite,
 *  por cantidad o por riesgo, con SL y TP. Se revisa y se confirma. */
function OrdenBinance({ b, simbolo, precio, freno }) {
  const [lado, setLado] = useState("buy");
  const [tipo, setTipo] = useState("mercado");
  const [cantidad, setCantidad] = useState("");
  const [riesgo, setRiesgo] = useState("");
  const [precioLim, setPrecioLim] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const enviandoRef = useRef(false);
  const { revision, requiereRevision, marcarRevision, confirmarRevision } = useRevisionOrden("binance");
  const [resultado, setResultado] = useState(null);
  const compra = lado === "buy";
  const d = decimales(precio);
  const ref = tipo === "limite" ? num(precioLim) : precio;
  const slP = num(sl), tpP = num(tp);
  const dist = ok(ref) && ok(slP) ? Math.abs(ref - slP) : NaN;
  // Por riesgo: la cantidad que pierde eso si toca el SL (en pasos de 0,001).
  const porRiesgo = ok(num(riesgo)) && ok(dist) ? Math.floor((num(riesgo) / dist) * 1000) / 1000 : NaN;
  const cant = ok(num(riesgo)) ? porRiesgo : num(cantidad);
  const apal = b.posiciones.find((p) => p.simbolo === simbolo)?.apalancamiento ?? null;
  const nocional = ok(cant) && ok(ref) ? cant * ref : NaN;
  const pierde = ok(cant) && ok(dist) ? cant * dist : NaN;
  const gana = ok(cant) && ok(ref) && ok(tpP) ? cant * Math.abs(tpP - ref) : NaN;
  const problema = problemaNumero(sl, "el SL") || problemaNumero(tp, "el TP") || problemaNumero(riesgo, "el riesgo", { cero: false }) || (!ok(ref) ? (tipo === "limite" ? "Falta el precio límite" : "Sin precio")
    : tipo === "limite" && ok(precio) && (compra ? ref >= precio : ref <= precio) ? `La ${compra ? "compra límite va debajo" : "venta límite va arriba"} del precio`
    : !ok(cant) ? "Falta la cantidad (o el riesgo con el SL)"
    : b.slObligatorio && !ok(slP) ? "Falta el stop loss"
    : ok(slP) && (compra ? slP >= ref : slP <= ref) ? `El SL de una ${compra ? "compra va debajo" : "venta va arriba"} del precio`
    : ok(tpP) && (compra ? tpP <= ref : tpP >= ref) ? `El TP de una ${compra ? "compra va arriba" : "venta va debajo"} del precio`
    : null);
  const falta = faltaBinance(b, freno, true);
  const mandar = async () => {
    if (enviandoRef.current || requiereRevision() || problema || falta) return;
    enviandoRef.current = true;
    setEnviando(true);
    const r = await enviarBinance({ accion: "abrir", symbol: simbolo, lado, tipo, cantidad: cant, precio: tipo === "limite" ? ref : 0, sl: ok(slP) ? slP : 0, tp: ok(tpP) ? tpP : 0 });
    setEnviando(false);
    enviandoRef.current = false;
    marcarRevision(r);
    setResultado(r);
    setConfirmar(false);
    if (r.ok) { setSl(""); setTp(""); }
  };
  return (
    <>
      <div className="cotizacion">
        <button className={`lado venta${!compra ? " activo" : ""}`} onClick={() => setLado("sell")}>
          <small>VENDER</small><b>{ok(precio) ? fmt(precio, d) : "—"}</b>
        </button>
        <button className={`lado compra${compra ? " activo" : ""}`} onClick={() => setLado("buy")}>
          <small>COMPRAR</small><b>{ok(precio) ? fmt(precio, d) : "—"}</b>
        </button>
      </div>
      <span className="op-simbolo tenue">{simbolo} perpetuo en Binance{apal ? ` · ×${apal}` : ""} · precio del gráfico (el que vale es el de Binance al mandar)</span>
      <div className="dato op-form">
        <div className="segmento">
          <button className={tipo === "mercado" ? "activo" : ""} onClick={() => setTipo("mercado")}>A mercado</button>
          <button className={tipo === "limite" ? "activo" : ""} onClick={() => setTipo("limite")}>Límite</button>
        </div>
        {tipo === "limite" && (
          <label className="op-campo">Precio límite
            <input value={precioLim} onChange={(e) => setPrecioLim(e.target.value)} inputMode="decimal"
                   placeholder={ok(precio) ? `${compra ? "debajo" : "arriba"} de ${fmt(precio, d)}` : ""} />
          </label>
        )}
        <div className="op-fila">
          <label className="op-campo">Cantidad ({simbolo.replace(/USDT$|USDC$/, "")})
            <input value={ok(num(riesgo)) && ok(porRiesgo) ? String(porRiesgo) : cantidad} disabled={ok(num(riesgo))}
                   onChange={(e) => setCantidad(e.target.value)} inputMode="decimal" placeholder="0,001" />
          </label>
          <label className="op-campo">o riesgo (USDT)
            <input value={riesgo} onChange={(e) => setRiesgo(e.target.value)} inputMode="decimal" placeholder="con el SL" />
          </label>
        </div>
        <div className="op-fila">
          <label className="op-campo">Stop loss
            <input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" placeholder="precio" />
          </label>
          <label className="op-campo">Take profit
            <input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" placeholder="precio" />
          </label>
        </div>
        <div className="op-resumen">
          <span>Nocional <b>{ok(nocional) ? `${fmtNum(nocional, 2)} USDT` : "—"}</b></span>
          <span>Margen <b>{ok(nocional) && apal ? `${fmtNum(nocional / apal, 2)} USDT` : "—"}</b></span>
          <span>Si toca el SL <b className="neg">{ok(pierde) ? `−${fmtNum(pierde, 2)} USDT` : "—"}</b></span>
          <span>Si toca el TP <b className="pos">{ok(gana) ? `+${fmtNum(gana, 2)} USDT` : "—"}</b></span>
          <span>Relación <b>{ok(gana) && ok(pierde) && pierde > 0 ? `${fmtNum(gana / pierde, 2)} R` : "—"}</b></span>
        </div>
        {problema && (cantidad || riesgo || sl || precioLim) && <span className="op-error">{problema}</span>}
        {!confirmar ? (
          <button className={`boton-orden ${compra ? "compra" : "venta"}`} disabled={Boolean(problema || revision) || enviando}
                  onClick={() => { setResultado(null); setConfirmar(true); }}>
            Revisar {compra ? "compra" : "venta"} en Binance
          </button>
        ) : (
          <div className={`op-confirmar ${compra ? "compra" : "venta"}`}>
            <b>{compra ? "Comprar" : "Vender"} {fmtNum(cant, decVol(cant))} {simbolo} en Binance {tipo === "mercado" ? `a mercado (≈ ${fmt(ref, d)})` : `con límite en ${fmt(ref, d)}`}</b>
            <span>SL {ok(slP) ? `${fmt(slP, d)} · −${fmtNum(pierde, 2)} USDT` : "sin stop loss"}</span>
            <span>TP {ok(tpP) ? `${fmt(tpP, d)} · +${fmtNum(gana, 2)} USDT` : "sin take profit"}</span>
            {falta && <span className="op-error">{falta}</span>}
            <span className="op-acciones">
              <button className={`boton-orden ${compra ? "compra" : "venta"}`} disabled={Boolean(falta || problema || revision) || enviando} onClick={mandar}>
                {enviando ? "Enviando a Binance…" : `Confirmar ${compra ? "compra" : "venta"}`}
              </button>
              <button className="tenue" onClick={() => setConfirmar(false)}>Volver</button>
            </span>
          </div>
        )}
        <ResultadoBinance r={revision ? null : resultado} />
        <RevisionOrden revision={revision} alRevisar={confirmarRevision} />
      </div>
    </>
  );
}

/** El spread y de que lado pesa mas respecto del precio del grafico. */
function Spread({ info, broker, precio, dig }) {
  const spread = info.ask - info.bid;
  const ref = precio;
  const compra = info.ask - ref, venta = ref - info.bid;
  const lado = Math.abs(compra - venta) < spread * 0.05 ? "parejo" : compra > venta ? "compras" : "ventas";
  const contra = broker.graficoBroker ? "del gráfico (bid)" : "del precio del gráfico";
  return (
    <div className="spread">
      <span className="fila"><span>Spread</span>
        <b>{fmt(spread, dig)} <em>· {fmtNum(spread / info.pip, 1)} pips · {fmtNum(spread * info.por_punto, 2)} USD/lote</em></b></span>
      <span className="fila" title={`Cuánto paga cada lado respecto ${contra}: comprar al ask y vender al bid`}>
        <span>Respecto {contra}</span>
        <b><em>comprar</em> {signo(compra, dig)} · <em>vender</em> {signo(venta, dig)}</b></span>
      <span className={`spread-lado ${lado}`}>
        {lado === "parejo" ? "El spread está parejo entre compras y ventas"
          : `El spread pesa más en las ${lado}: ${lado === "compras" ? "comprar" : "vender"} sale ${fmt(Math.abs(compra - venta), dig)} más caro`}
      </span>
    </div>
  );
}

/** Un SL o TP mientras se edita: pips desde la entrada y lo que da si toca. */
function Resultado({ p, nivel, info, moneda, esSl }) {
  if (!ok(nivel)) return <span className="tenue">{esSl ? "sin stop loss" : "sin take profit"}</span>;
  const r = resultadoEn(p, nivel, info);
  return (
    <span className={r.usd >= 0 ? "pos" : "neg"}>
      {Number.isFinite(r.pips) ? `${fmtNum(r.pips, 1)} pips · ` : ""}
      {Number.isFinite(r.usd) ? `${signo(r.usd)} ${moneda}` : ""}
      {esSl && r.usd >= 0 ? " · asegurado" : ""}
    </span>
  );
}

/** Una posicion u orden pendiente: mover su SL y TP (y el precio, si es
 *  pendiente), cerrarla entera o en parte, o cancelarla. */
function Posicion({ p, info, moneda, falta, slObligatorio, enGrafico, alResultado, onVista, adonde = "MT5" }) {
  const [modo, setModo] = useState(null);   // null | "editar" | "cerrar"
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [precio, setPrecio] = useState("");
  const [vol, setVol] = useState(String(p.volumen));
  const [enviando, setEnviando] = useState(false);
  const enviandoRef = useRef(false);
  const pendiente = esPendiente(p);
  const compra = esCompra(p);
  const infoSym = info?.symbol === p.simbolo ? info : null;
  const dig = p.digitos ?? infoSym?.digits ?? decimales(p.entrada);

  const comoEstaba = () => {
    setSl(p.sl ? String(p.sl) : "");
    setTp(p.tp ? String(p.tp) : "");
    setPrecio(String(p.entrada));
  };
  // Lo escrito: vacio es "sin SL" / "sin TP".
  const leer = (s) => (String(s).trim() === "" ? 0 : num(s));
  const nuevo = { sl: leer(sl), tp: leer(tp), ...(pendiente ? { precio: num(precio) } : {}) };
  const base = pendiente && ok(nuevo.precio) ? { ...p, entrada: nuevo.precio } : p;
  const cambia = nuevo.sl !== (p.sl ?? 0) || nuevo.tp !== (p.tp ?? 0) || (pendiente && nuevo.precio !== p.entrada);
  const problema = problemaNumero(sl, "el SL") || problemaNumero(tp, "el TP") || (Number.isNaN(nuevo.sl) ? "Revisá el SL" : Number.isNaN(nuevo.tp) ? "Revisá el TP"
    : pendiente && !ok(nuevo.precio) ? "Revisá el precio"
    : slObligatorio && !ok(nuevo.sl) ? "El Operador no deja operar sin stop loss"
    : problemaCambio(p, nuevo, infoSym));
  const problemaCierre = pendiente ? null : problemaNumero(vol, "el volumen a cerrar", { cero: false, opcional: false })
    || (num(vol) > p.volumen ? `La posición tiene ${fmtNum(p.volumen, decVol(p, infoSym))} lotes` : null);

  // Lo que se escribe se ve en el grafico (si la operacion es del mercado que se esta mirando).
  const editando = modo === "editar";
  useEffect(() => {
    if (!onVista || !enGrafico || !editando) return undefined;
    onVista({
      ticket: p.ticket,
      sl: ok(nuevo.sl) ? nuevo.sl : null,
      tp: ok(nuevo.tp) ? nuevo.tp : null,
      ...(pendiente ? { precio: ok(nuevo.precio) ? nuevo.precio : p.entrada } : {}),
    });
    return () => onVista(null);
  }, [onVista, enGrafico, editando, p.ticket, p.entrada, pendiente, nuevo.sl, nuevo.tp, nuevo.precio]);

  const accion = async (cuerpo) => {
    if (enviandoRef.current || falta) return;
    enviandoRef.current = true;
    setEnviando(true);
    const r = await enviar(cuerpo);
    setEnviando(false);
    enviandoRef.current = false;
    alResultado(r);
    if (r.ok || r.estado === "sin_respuesta") setModo(null);
  };
  const usd = (nivel) => resultadoEn(p, nivel, infoSym).usd;
  const conUsd = (nivel) => (nivel && Number.isFinite(usd(nivel)) ? ` (${signo(usd(nivel))})` : "");
  return (
    <li className={`op-posicion ${compra ? "compra" : "venta"}`}>
      <span className="fila">
        <b className="texto">{nombreOperacion(p)} {fmtNum(p.volumen, decVol(p, infoSym))} · {p.simbolo}</b>
        {!pendiente && <b className={p.profit >= 0 ? "pos" : "neg"}>{signo(p.profit ?? 0)} {moneda}</b>}
      </span>
      <span className="fila tenue">
        <span>{pendiente ? "Precio" : "Entrada"} {fmt(p.entrada, dig)}</span>
        <span>SL {p.sl ? fmt(p.sl, dig) : "—"}{conUsd(p.sl)} · TP {p.tp ? fmt(p.tp, dig) : "—"}{conUsd(p.tp)}</span>
      </span>
      {ok(p.liquidacion) && (
        <span className="fila tenue"><span>Liquidación {fmt(p.liquidacion, dig)}</span>{p.apalancamiento && <span>x{p.apalancamiento}</span>}</span>
      )}
      {modo === null && (
        <span className="op-acciones">
          <button onClick={() => { comoEstaba(); setModo("editar"); }}>{pendiente ? "Precio / SL / TP" : "SL / TP"}</button>
          <button className="peligro" onClick={() => { setVol(String(p.volumen)); setModo("cerrar"); }}>{pendiente ? "Cancelar orden" : "Cerrar"}</button>
        </span>
      )}
      {editando && (
        <div className="op-modificar">
          {pendiente && (
            <label className="op-mod-fila">
              <span>Precio</span>
              <input value={precio} onChange={(e) => setPrecio(e.target.value)} inputMode="decimal" />
              <span className="tenue">antes {fmt(p.entrada, dig)}</span>
            </label>
          )}
          <label className="op-mod-fila">
            <span>SL</span>
            <input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" placeholder="sin SL" />
            <Resultado p={base} nivel={nuevo.sl} info={infoSym} moneda={moneda} esSl />
          </label>
          <label className="op-mod-fila">
            <span>TP</span>
            <input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" placeholder="sin TP" />
            <Resultado p={base} nivel={nuevo.tp} info={infoSym} moneda={moneda} esSl={false} />
          </label>
          <span className="op-atajos">
            {!pendiente && <button onClick={() => setSl(String(p.entrada))} title="Mueve el SL al precio de entrada">SL a la entrada</button>}
            <button onClick={() => setTp("")}>Sin TP</button>
            {!slObligatorio && <button onClick={() => setSl("")}>Sin SL</button>}
            <button onClick={comoEstaba}>Como estaba</button>
          </span>
          {enGrafico && <span className="tenue op-ayuda">También podés arrastrar las líneas del SL y el TP en el gráfico.</span>}
          {cambia && problema && <span className="op-error">{problema}</span>}
          {cambia && !problema && falta && <span className="op-error">Para mandarlo: {falta}</span>}
          <span className="op-acciones">
            <button className="boton-orden confirmar" disabled={!cambia || Boolean(problema || falta) || enviando}
                    onClick={() => accion(pedidoModificar(p, nuevo))}>
              {enviando ? `Enviando a ${adonde}…` : "Guardar cambios"}
            </button>
            <button className="tenue" onClick={() => setModo(null)}>Volver</button>
          </span>
        </div>
      )}
      {modo === "cerrar" && (
        <span className="op-editar">
          {pendiente ? <span>¿Cancelar la orden?</span> : (
            <label>Cerrar <input value={vol} onChange={(e) => setVol(e.target.value)} inputMode="decimal" /> lotes</label>
          )}
          <button className="peligro" disabled={enviando || Boolean(falta || problemaCierre)} title={falta ?? problemaCierre ?? ""}
                  onClick={() => { if (!problemaCierre) accion(pendiente ? { accion: "cancelar", ticket: p.ticket } : { accion: "cerrar", ticket: p.ticket, volumen: num(vol) }); }}>
            {enviando ? "Enviando…" : pendiente ? "Sí, cancelar" : "Sí, cerrar"}
          </button>
          <button className="tenue" onClick={() => setModo(null)}>No</button>
          {falta && <span className="op-error">Para mandarlo: {falta}</span>}
          {problemaCierre && <span className="op-error">{problemaCierre}</span>}
        </span>
      )}
    </li>
  );
}

/** Panel Operar: abrir a mercado o limite con SL y TP, y manejar lo abierto. */
export default function Operar({ cfg, symbol, broker, binance, precio, onBorrador, onVista, freno, onSymbol, ajuste }) {
  const adonde = destino(broker);
  const info = broker?.info ?? null;
  const [lado, setLado] = useState("buy");
  // A donde va la orden nueva: FTMO (MT5) o Binance (si el grafico es de un mercado de Binance).
  const [hacia, setHacia] = useState("mt5");
  const simboloBinance = binance?.disponible && ["cripto", "materia"].includes(cfg?.mercados?.[symbol]?.tipo) ? symbol : null;
  const haciaBinance = hacia === "binance" && Boolean(simboloBinance);
  const [tipo, setTipo] = useState("mercado");
  const [precioLim, setPrecioLim] = useState("");
  const [vol, setVol] = useState("");
  const [riesgo, setRiesgo] = useState("");
  const [sl, setSl] = useState({ modo: "pips", valor: "" });
  const [tp, setTp] = useState({ modo: "pips", valor: "" });
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const enviandoRef = useRef(false);
  const { revision, requiereRevision, marcarRevision, confirmarRevision } = useRevisionOrden("mt5");
  const [resultado, setResultado] = useState(null);
  const [resultadoOp, setResultadoOp] = useState(null);   // de modificar, cerrar o cancelar
  // El aviso de lo abierto se va solo despues de un rato.
  useEffect(() => {
    if (!resultadoOp) return undefined;
    const t = setTimeout(() => setResultadoOp(null), resultadoOp.ok ? 5000 : 12000);
    return () => clearTimeout(t);
  }, [resultadoOp]);

  // Al cambiar de mercado, el formulario arranca de cero.
  useEffect(() => {
    setPrecioLim(""); setVol(""); setRiesgo(""); setSl({ modo: "pips", valor: "" }); setTp({ modo: "pips", valor: "" });
    setConfirmar(false); setResultado(null);
  }, [symbol]);

  // Una linea de la orden arrastrada en el grafico (precio limite, SL o TP): el precio
  // va al campo, en precio (no en pips). Si estaba por confirmarse, vuelve a revisarse.
  useEffect(() => {
    if (!ajuste) return;
    const dig = broker?.info?.digits ?? 2;
    // El + del eje: una limite a ese precio (del grafico, pasado a la cuenta). Debajo
    // del precio es una compra; arriba, una venta.
    if (ajuste.campo === "nueva" && Number.isFinite(ajuste.precioGrafico)) {
      const p = ajuste.precioGrafico + (broker?.graficoBroker ? 0 : broker?.diferencia ?? 0);
      const bid = num(broker?.bid);
      setHacia("mt5");
      setTipo("limite");
      setLado(ok(bid) && p > bid ? "sell" : "buy");
      setPrecioLim(String(Number(p.toFixed(dig))));
      setConfirmar(false);
      return;
    }
    if (!Number.isFinite(ajuste.precio)) return;
    const v = String(Number(ajuste.precio.toFixed(dig)));
    if (ajuste.campo === "precio") { setTipo("limite"); setPrecioLim(v); }
    else if (ajuste.campo === "sl") setSl({ modo: "precio", valor: v });
    else if (ajuste.campo === "tp") setTp({ modo: "precio", valor: v });
    setConfirmar(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ajuste]);

  // Con el mercado cerrado en el broker no se manda nada (MT5 lo rechazaria igual), y
  // con el freno de disciplina puesto no se abre nada nuevo.
  const falta = faltaParaOperar(broker) ?? mercadoCerrado(broker?.horario)
    ?? (freno?.bloquea ? `Freno de disciplina: ${freno.motivos.join(" y ")}` : null);
  const listo = !falta;
  const dig = info?.digits ?? 2;
  const compra = lado === "buy";
  const c = useMemo(() => calcularOrden({ info, broker, tipo, compra, precioLim, sl, tp, vol, riesgo }), [info, tipo, compra, precioLim, sl, tp, vol, riesgo, broker]);

  // El borrador se dibuja en el grafico (pasado al precio del grafico).
  useEffect(() => {
    if (!onBorrador) return;
    // Solo cuando se esta armando una orden: con el formulario vacio no se dibuja nada.
    const armando = tipo === "limite" || [vol, riesgo, sl.valor, tp.valor].some((x) => String(x).trim() !== "");
    if (!c || !ok(c.entrada) || !armando) { onBorrador(null); return; }
    onBorrador({
      lado, tipo, dif: broker?.graficoBroker ? 0 : broker?.diferencia ?? 0, volumen: c.v,
      entrada: c.entrada, sl: ok(c.slP) ? c.slP : null, tp: ok(c.tpP) ? c.tpP : null,
      slUsd: c.sl.usd, tpUsd: c.tp.usd,
    });
  }, [c, lado, tipo, vol, riesgo, sl.valor, tp.valor, broker?.diferencia, broker?.graficoBroker, onBorrador]);
  useEffect(() => () => onBorrador?.(null), [onBorrador]);

  if (!broker?.disponible) {
    return <div className="operar"><Preparacion broker={broker} /><CuentaBinance b={binance} onSymbol={onSymbol} cfg={cfg} /></div>;
  }
  const moneda = broker.cuenta?.moneda ?? "USD";
  const alResultado = (r) => { setResultado(r); marcarRevision(r); setConfirmar(false); };
  const mandar = async () => {
    if (enviandoRef.current || requiereRevision() || !listo || !c || c.errores.length) return;
    enviandoRef.current = true;
    setEnviando(true);
    const r = await enviar({
      accion: "abrir", symbol, lado, tipo, volumen: c.v, precio: tipo === "limite" ? c.entrada : 0,
      sl: ok(c.slP) ? c.slP : 0, tp: ok(c.tpP) ? c.tpP : 0,
    });
    setEnviando(false);
    enviandoRef.current = false;
    alResultado(r);
    if (r.ok) { setSl({ ...sl, valor: "" }); setTp({ ...tp, valor: "" }); }
  };
  const campoNivel = (campo, setCampo, esSl) => {
    const d = esSl ? c?.sl : c?.tp;
    const p = esSl ? c?.slP : c?.tpP;
    return (
      <div className="op-nivel">
        <span className="op-nivel-titulo">{esSl ? "Stop loss" : "Take profit"}</span>
        <div className="segmento chico">
          <button className={campo.modo === "pips" ? "activo" : ""} onClick={() => setCampo({ modo: "pips", valor: ok(d?.pips) ? fmtNum(d.pips, 1).replace(/\./g, "") : "" })}>pips</button>
          <button className={campo.modo === "precio" ? "activo" : ""} onClick={() => setCampo({ modo: "precio", valor: ok(p) ? String(Number(p.toFixed(dig))) : "" })}>precio</button>
        </div>
        <input value={campo.valor} onChange={(e) => setCampo({ ...campo, valor: e.target.value })} inputMode="decimal"
               placeholder={campo.modo === "pips" ? "pips" : "precio"} />
        <span className={`op-nivel-valor ${esSl ? "neg" : "pos"}`}>
          {ok(p) ? <>{fmt(p, dig)} · {fmtNum(d.pips, 1)} pips · {esSl ? "−" : "+"}{fmtNum(d.usd, 2)} {moneda}</> : "—"}
        </span>
      </div>
    );
  };

  return (
    <div className="operar">
      {/* De arriba hacia abajo: lo que falta para operar, la cuenta, el freno, lo
          abierto y, al final, la orden nueva. */}
      <Preparacion broker={broker} />
      <Cuenta broker={broker} moneda={moneda} />
      <FrenoEstado freno={freno} />
      <PausaReal pausa={freno?.pausa} />
      <RevisionOrden revision={revision} alRevisar={confirmarRevision} />
      {[["Operaciones abiertas", [...(broker.posiciones ?? []), ...(broker.otras ?? [])]],
        ["Órdenes pendientes", [...(broker.ordenes ?? []), ...(broker.otrasOrdenes ?? [])]]].map(([titulo, lista], k) => (
        (lista.length > 0 || k === 0) && (
          <div key={titulo} className="dato">
            <span className="fila">
              <small>{titulo}</small>
              {k === 0 && lista.length > 0 && (() => {
                const total = lista.reduce((x, p) => x + (p.profit ?? 0) + (p.swap ?? 0), 0);
                return <b className={total >= 0 ? "pos" : "neg"}>{signo(total)} {moneda}</b>;
              })()}
            </span>
            {!lista.length && <span className="tenue">Ninguna.</span>}
            {lista.some((p) => p.simbolo !== broker.simbolo) && (
              <span className="tenue op-otros">
                {[...new Set(lista.filter((p) => p.simbolo !== broker.simbolo).map((p) => p.simbolo))].map((s) => {
                  const t = Object.entries(cfg?.mt5_simbolos ?? {}).find(([, b]) => b.toUpperCase() === String(s).toUpperCase())?.[0];
                  return t && onSymbol
                    ? <button key={s} className="chip" onClick={() => onSymbol(t)} title="Ver ese mercado en el gráfico">{s} ›</button>
                    : <span key={s}>{s}</span>;
                })}
              </span>
            )}
            <ul className="op-lista">
              {lista.map((p) => (
                <Posicion key={p.ticket} p={p} info={info} moneda={moneda} falta={faltaParaOperar(broker) ?? mercadoCerrado(p.horario)}
                          slObligatorio={Boolean(broker.operador?.sl_obligatorio)} enGrafico={p.simbolo === broker.simbolo}
                          alResultado={(r) => { setResultadoOp(r); marcarRevision(r); }} onVista={onVista} adonde={adonde} />
              ))}
            </ul>
          </div>
        )
      ))}
      {resultadoOp && (
        <span className={`op-resultado ${resultadoOp.ok ? "pos" : "neg"}`}>
          {resultadoOp.ok ? "✓ " : "✗ "}{resultadoOp.mensaje}
        </span>
      )}
      <CuentaBinance b={binance} onSymbol={onSymbol} cfg={cfg} mostrarRevision={!haciaBinance} />
      <span className="op-titulo fila">
        <span>Nueva orden · {haciaBinance ? simboloBinance : broker.simbolo}</span>
        {simboloBinance && (
          <span className="segmento chico">
            <button className={!haciaBinance ? "activo" : ""} onClick={() => setHacia("mt5")}>FTMO · MT5</button>
            <button className={haciaBinance ? "activo" : ""} onClick={() => setHacia("binance")}>Binance</button>
          </span>
        )}
      </span>
      {haciaBinance ? <OrdenBinance b={binance} simbolo={simboloBinance} precio={precio} freno={freno} /> : (<>
      <HorarioMercado broker={broker} />
      {info ? (
        <>
          <div className="cotizacion">
            <button className={`lado venta${!compra ? " activo" : ""}`} onClick={() => setLado("sell")}>
              <small>VENDER</small><b>{fmt(info.bid ?? broker.bid, dig)}</b>
            </button>
            <button className={`lado compra${compra ? " activo" : ""}`} onClick={() => setLado("buy")}>
              <small>COMPRAR</small><b>{fmt(broker.ask, dig)}</b>
            </button>
          </div>
          <span className="op-simbolo tenue">
            {`${info.symbol} · 1 pip = ${fmt(info.pip, dig)} · ${fmtNum(info.pip * info.por_punto, 2)} ${moneda} por pip y lote${info.apalancamiento ? ` · apalancamiento 1:${info.apalancamiento}` : ""}`}
          </span>
          {broker.bid && broker.ask && <Spread info={{ ...info, bid: broker.bid, ask: broker.ask }} broker={broker} precio={precio} dig={dig} />}

          <div className="dato op-form">
            <div className="segmento">
              <button className={tipo === "mercado" ? "activo" : ""} onClick={() => setTipo("mercado")}>A mercado</button>
              <button className={tipo === "limite" ? "activo" : ""} onClick={() => setTipo("limite")}>Límite</button>
            </div>
            {tipo === "limite" && (
              <label className="op-campo">Precio límite
                <input value={precioLim} onChange={(e) => setPrecioLim(e.target.value)} inputMode="decimal"
                       placeholder={compra ? `debajo de ${fmt(broker.ask, dig)}` : `arriba de ${fmt(broker.bid, dig)}`} />
              </label>
            )}
            <div className="op-fila">
              <label className="op-campo">Volumen (lotes)
                <input value={ok(num(riesgo)) && ok(c?.v) ? String(c.v) : vol} disabled={ok(num(riesgo))}
                       onChange={(e) => setVol(e.target.value)} inputMode="decimal" placeholder={String(info.volume_min ?? 0.01)} />
              </label>
              <label className="op-campo">o riesgo ({moneda})
                <input value={riesgo} onChange={(e) => setRiesgo(e.target.value)} inputMode="decimal" placeholder="con el SL" />
              </label>
              {/* El riesgo del plan (lo que queda hasta el limite ÷ RIESGO_AGUANTAR, como mucho
                  RIESGO_PCT del balance; lo calcula el servidor): un click lo escribe. */}
              {broker.riesgoPlan?.usd > 0 && (
                <button className="riesgo-plan" onClick={() => setRiesgo(String(broker.riesgoPlan.usd))}
                        title={broker.riesgoPlan.aguantar > 0
                          ? `Riesgo del plan: te quedan ${fmtNum(broker.riesgoPlan.colchon, 0)} ${moneda} hasta el límite de la cuenta; ÷ ${broker.riesgoPlan.aguantar} SL seguidos, como mucho ${fmtNum(broker.riesgoPct, 2)} % del balance (${fmtNum(broker.riesgoPlan.tope, 0)} ${moneda}). Sube si ganas y baja si pierdes.`
                          : `Riesgo del plan: ${fmtNum(broker.riesgoPct, 2)} % del balance`}>
                  Plan {fmtNum(broker.riesgoPlan.usd, 0)}
                </button>
              )}
            </div>
            {campoNivel(sl, setSl, true)}
            {campoNivel(tp, setTp, false)}
            <div className="op-resumen">
              <span>Valor del pip <b>{ok(c?.pipUsd) ? `${fmtNum(c.pipUsd, 2)} ${moneda}` : "—"}</b></span>
              <span>Relación <b>{ok(c?.rr) ? `${fmtNum(c.rr, 2)} R` : "—"}</b></span>
              <span>Riesgo <b className="neg">{ok(c?.pctEquity) ? `${fmtNum(c.pctEquity, 2)} % del equity` : "—"}</b></span>
              <span>Margen <b>{ok(c?.margen) ? `${fmtNum(c.margen, 2)} ${moneda}` : "—"}</b></span>
              {c?.cuenta && (
                <span className="op-cuenta" title="Lo que quedaría antes del primer límite de la cuenta de fondeo si esta orden y todo lo abierto tocan su SL">
                  Si toca el SL, quedan{" "}
                  <b className={Number.isFinite(c.quedan) && c.quedan < 0 ? "neg" : ""}>
                    {Number.isFinite(c.quedan) ? `${fmtNum(c.quedan, 2)} ${moneda}` : c.cuenta.sinSl > 0 ? "— (hay posiciones sin SL)" : "—"}
                  </b>{" "}
                  hasta el límite de la cuenta
                </span>
              )}
            </div>
            {c?.errores.length > 0 && <span className="op-error">{c.errores[0]}</span>}
            {!confirmar ? (
              <button className={`boton-orden ${compra ? "compra" : "venta"}`} disabled={!c || c.errores.length > 0 || Boolean(revision) || enviando}
                      onClick={() => { setResultado(null); setConfirmar(true); }}>
                Revisar {compra ? "compra" : "venta"}
              </button>
            ) : (
              <div className={`op-confirmar ${compra ? "compra" : "venta"}`}>
                <b>{compra ? "Comprar" : "Vender"} {fmtNum(c.v, decVol(c.v, info))} lotes de {info.symbol} {tipo === "mercado" ? `a mercado (≈ ${fmt(c.entrada, dig)})` : `con límite en ${fmt(c.entrada, dig)}`}</b>
                <span>SL {ok(c.slP) ? `${fmt(c.slP, dig)} · ${fmtNum(c.sl.pips, 1)} pips · −${fmtNum(c.sl.usd, 2)} ${moneda}` : "sin stop loss"}</span>
                <span>TP {ok(c.tpP) ? `${fmt(c.tpP, dig)} · ${fmtNum(c.tp.pips, 1)} pips · +${fmtNum(c.tp.usd, 2)} ${moneda}` : "sin take profit"}</span>
                {!listo && <span className="op-error">{mercadoCerrado(broker?.horario) || freno?.bloquea ? falta : "Falta preparar el Operador (arriba): la orden no se puede mandar todavía."}</span>}
                {tipo === "limite" && avisoPendiente(broker?.horario) && <span className="aviso-cierre">{avisoPendiente(broker.horario)}</span>}
                <span className="op-acciones">
                  <button className={`boton-orden ${compra ? "compra" : "venta"}`} disabled={!listo || enviando || Boolean(revision) || !c || c.errores.length > 0} onClick={mandar}>
                    {enviando ? `Enviando a ${adonde}…` : `Confirmar ${compra ? "compra" : "venta"}`}
                  </button>
                  <button className="tenue" onClick={() => setConfirmar(false)}>Volver</button>
                </span>
              </div>
            )}
            {resultado && (
              <span className={`op-resultado ${resultado.ok ? "pos" : "neg"}`}>
                {resultado.ok ? "✓ " : "✗ "}{resultado.mensaje}
                {resultado.ok && resultado.precio ? ` · ${fmt(resultado.precio, dig)}` : ""}
                {resultado.ticket ? ` · ticket ${resultado.ticket}` : ""}
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="dato"><span className="tenue">El broker no publica este mercado: sumalo a InpSimbolos del puente.</span></div>
      )}
      </>)}

      <p className="pie tenue">Cada orden se confirma acá y la valida de nuevo el EA en MT5 · cuenta {broker.cuenta?.login || "—"}</p>
    </div>
  );
}
