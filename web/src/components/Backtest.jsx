import { useEffect, useMemo, useState } from "react";
import { fmt, fmtNum, getDecimals } from "../lib/format.js";
import { cerrarAMano, flotante, lotesPara, nuevaOperacion, resumen, validar } from "../lib/simulacion.js";

const CLAVE = "terminal-cripto:backtest";
const FECHA = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const FINAL = { tp: "TP", sl: "SL", be: "BE", manual: "Cierre", no_entro: "no se llenó", abierta: "abierta" };
const conSigno = (x, d = 1) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), d)}`;
const num = (s) => Number(String(s).replace(",", "."));

function cargar() {
  try { return { balance: 10000, riesgo: null, valorPunto: 1, ...JSON.parse(localStorage.getItem(CLAVE) || "{}") }; } catch { return { balance: 10000, riesgo: null, valorPunto: 1 }; }
}

/** Lo que suman las operaciones (cerradas). */
function Resumen({ r }) {
  if (!r.n) return <span className="tenue">Todavía no hay operaciones cerradas.</span>;
  return (
    <div className="bt-resumen">
      <span><small>Operaciones</small><b>{r.n}</b></span>
      <span><small>Acierto</small><b>{fmtNum(r.acierto * 100, 0)} %</b></span>
      <span><small>Total</small><b className={r.totalR >= 0 ? "pos" : "neg"}>{conSigno(r.totalR)} R</b></span>
      <span><small>USD</small><b className={r.totalUsd >= 0 ? "pos" : "neg"}>{conSigno(r.totalUsd, 0)}</b></span>
      <span><small>Por operación</small><b>{conSigno(r.promedioR, 2)} R</b></span>
      <span><small>Factor</small><b>{r.factor === null ? "—" : fmtNum(r.factor, 2)}</b></span>
      <span><small>Caída máx.</small><b className="neg">{fmtNum(r.caida, 1)} R</b></span>
      <span><small>TP · SL · BE</small><b>{r.ganadas} · {r.perdidas} · {r.be}</b></span>
    </div>
  );
}

/** Backtest en el replay: operaciones simuladas (con el riesgo del plan) que se
 *  llenan y cierran con las velas que van saliendo, y sus resultados. Nada va a la cuenta. */
export default function Backtest({ cfg, cursor, precio, ops, onOps, sesion }) {
  const dig = getDecimals();
  const [ajustes, setAjustes] = useState(cargar);
  useEffect(() => { try { localStorage.setItem(CLAVE, JSON.stringify(ajustes)); } catch { /* sin almacenamiento */ } }, [ajustes]);
  const riesgoPct = ajustes.riesgo ?? cfg.riesgo_pct;
  const riesgoUsd = (ajustes.balance * riesgoPct) / 100;

  const [lado, setLado] = useState(1);
  const [tipo, setTipo] = useState("limite");
  const [entrada, setEntrada] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [error, setError] = useState(null);
  const [ver, setVer] = useState("sesion");

  const e = tipo === "mercado" ? precio : num(entrada);
  const s = num(sl), t = num(tp);
  const puntos = Number.isFinite(e) && Number.isFinite(s) ? Math.abs(e - s) : NaN;
  const lotes = lotesPara(riesgoUsd, puntos, ajustes.valorPunto);
  const rr = Number.isFinite(t) && t > 0 && puntos > 0 ? Math.abs(t - e) / puntos : null;

  const colocar = () => {
    const orden = { lado, entrada: e, sl: s, tp: t > 0 ? t : null };
    const err = validar(orden) ?? (lotes > 0 ? null : "Con ese SL el riesgo no alcanza para 0,01 lotes.");
    if (err) { setError(err); return; }
    if (tipo === "limite" && (lado === 1 ? e > precio : e < precio)) {
      setError(`Una ${lado === 1 ? "compra" : "venta"} límite va ${lado === 1 ? "bajo" : "sobre"} el precio (${fmt(precio, dig)}). Para entrar ya, usa A mercado.`);
      return;
    }
    setError(null);
    onOps((xs) => [...xs, nuevaOperacion({
      ...orden, tipo, riesgoUsd, valorPunto: ajustes.valorPunto, cursor, simbolo: cfg.replay_simbolo, sesion,
    })]);
  };
  const cambiar = (id, f) => onOps((xs) => xs.map((o) => (o.id === id ? f(o) : o)));

  const vivas = ops.filter((o) => o.sesion === sesion && (o.estado === "pendiente" || o.estado === "abierta"));
  const lista = (ver === "sesion" ? ops.filter((o) => o.sesion === sesion) : ops).filter((o) => o.estado === "cerrada");
  const r = useMemo(() => resumen(lista), [lista]);

  return (
    <div className="simulacion backtest">
      <div className="dato">
        <span className="fila"><b>Backtest</b><span className="tenue">simulado · no va a la cuenta</span></span>
        <span className="fila tenue bt-ajustes">
          <label>Balance <input type="number" min="100" step="100" value={ajustes.balance} onChange={(x) => setAjustes((a) => ({ ...a, balance: num(x.target.value) || 0 }))} /></label>
          <label>Riesgo % <input type="number" min="0.1" max="5" step="0.1" value={riesgoPct} onChange={(x) => setAjustes((a) => ({ ...a, riesgo: num(x.target.value) || 0 }))} /></label>
          <label title="USD que mueve 1 lote por cada punto (US100.cash de FTMO: 1)">USD/punto <input type="number" min="0.01" step="0.01" value={ajustes.valorPunto} onChange={(x) => setAjustes((a) => ({ ...a, valorPunto: num(x.target.value) || 1 }))} /></label>
        </span>
        <span className="tenue">Riesgo por operación: {fmtNum(riesgoUsd, 2)} USD</span>
      </div>

      <div className="dato bt-orden">
        <div className="segmento">
          <button className={lado === 1 ? "activo compra" : ""} onClick={() => setLado(1)}>Compra</button>
          <button className={lado === -1 ? "activo venta" : ""} onClick={() => setLado(-1)}>Venta</button>
        </div>
        <div className="segmento chico">
          <button className={tipo === "limite" ? "activo" : ""} onClick={() => setTipo("limite")}>Límite</button>
          <button className={tipo === "mercado" ? "activo" : ""} onClick={() => setTipo("mercado")}>A mercado</button>
        </div>
        <label>Entrada
          {tipo === "mercado" ? <input value={Number.isFinite(precio) ? fmt(precio, dig) : "—"} disabled />
            : <input inputMode="decimal" value={entrada} onChange={(x) => setEntrada(x.target.value)} placeholder={Number.isFinite(precio) ? fmt(precio, dig) : ""} />}
        </label>
        <label>SL <input inputMode="decimal" value={sl} onChange={(x) => setSl(x.target.value)} /></label>
        <label>TP <input inputMode="decimal" value={tp} onChange={(x) => setTp(x.target.value)} placeholder="opcional" /></label>
        <span className="fila tenue">
          <span>{lotes > 0 ? `${fmtNum(lotes, 2)} lotes · ${fmtNum(puntos, 1)} pts de SL` : "Lotes: pon la entrada y el SL"}</span>
          <span>{rr !== null ? `${fmtNum(rr, 2)} R` : ""}</span>
        </span>
        {error && <span className="neg">{error}</span>}
        <span className="op-acciones">
          <button className={`boton-orden ${lado === 1 ? "compra" : "venta"}`} onClick={colocar}>
            Colocar {lado === 1 ? "compra" : "venta"}{tipo === "limite" ? " límite" : ""}
          </button>
        </span>
      </div>

      {vivas.length > 0 && (
        <div className="dato">
          <small>Abiertas y pendientes</small>
          {vivas.map((o) => {
            const f = flotante(o, precio);
            return (
              <div key={o.id} className="bt-op">
                <span className="fila">
                  <b className={o.lado === 1 ? "pos" : "neg"}>{o.lado === 1 ? "Compra" : "Venta"} {fmtNum(o.lotes, 2)}{o.estado === "pendiente" ? " · límite" : ""}</b>
                  {f && <b className={f.r >= 0 ? "pos" : "neg"}>{conSigno(f.r, 2)} R · {conSigno(f.usd, 0)} USD</b>}
                </span>
                <span className="fila tenue"><span>Entrada {fmt(o.entrada, dig)}</span><span>SL {fmt(o.sl, dig)}</span><span>TP {o.tp ? fmt(o.tp, dig) : "—"}</span></span>
                <span className="op-acciones">
                  {o.estado === "abierta" && o.sl !== o.entrada && (
                    <button onClick={() => cambiar(o.id, (x) => ({ ...x, sl: x.entrada }))} title="Mover el SL a la entrada">SL a BE</button>
                  )}
                  <button onClick={() => cambiar(o.id, (x) => cerrarAMano(x, precio, cursor))}>
                    {o.estado === "abierta" ? "Cerrar a mercado" : "Cancelar"}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="dato">
        <span className="fila">
          <small>Resultados</small>
          <span className="segmento chico">
            <button className={ver === "sesion" ? "activo" : ""} onClick={() => setVer("sesion")}>Este replay</button>
            <button className={ver === "todas" ? "activo" : ""} onClick={() => setVer("todas")}>Todas</button>
          </span>
        </span>
        <Resumen r={r} />
        {lista.length > 0 && (
          <table className="bt-tabla">
            <thead><tr><th>Entrada</th><th>Lado</th><th>Final</th><th>R</th><th>USD</th><th /></tr></thead>
            <tbody>
              {[...lista].sort((a, b) => b.cerrada - a.cerrada).slice(0, 60).map((o) => (
                <tr key={o.id}>
                  <td>{FECHA.format(o.entro * 1000)}</td>
                  <td className={o.lado === 1 ? "pos" : "neg"}>{o.lado === 1 ? "C" : "V"}</td>
                  <td>{FINAL[o.final] ?? o.final}</td>
                  <td className={o.r > 0.01 ? "pos" : o.r < -0.01 ? "neg" : "tenue"}>{conSigno(o.r, 2)}</td>
                  <td>{conSigno(o.usd, 0)}</td>
                  <td><button className="chico-x" title="Borrar del registro" onClick={() => onOps((xs) => xs.filter((x) => x.id !== o.id))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
