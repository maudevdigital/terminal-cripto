import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { fmt, fmtNum } from "../lib/format.js";
import { calcularOrden, decVol, enviar, faltaParaOperar, num, ok } from "../lib/operativa.js";
import { mercadoCerrado } from "../lib/horario.js";
import useRevisionOrden from "../hooks/useRevisionOrden.js";

const CLAVE = "terminal-cripto:compra-rapida";
const leer = () => {
  try {
    const p = JSON.parse(localStorage.getItem(CLAVE) || "{}");
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch { return {}; }
};

export function RevisionOrden({ revision, alRevisar }) {
  if (!revision) return null;
  return (
    <div className="op-error flex flex-col gap-2" role="alert">
      <span>{revision.mensaje}</span>
      {revision.orden?.id && <span> · Orden {revision.orden.id}</span>}
      <button type="button" className="tenue" onClick={alRevisar}>Ya revisé las posiciones y órdenes</button>
    </div>
  );
}

/** La compra rapida del grafico (arriba a la izquierda): vender o
 *  comprar a mercado o con una limite, con el volumen y, si se quiere, el SL y el TP.
 *  Usa el mismo calculo que Operar (los errores y el limite de la cuenta de fondeo) y
 *  el servidor aplica el freno igual. Por defecto pregunta antes de mandar. */
export default function CompraRapida({ symbol, broker, freno }) {
  const guardado = useMemo(leer, []);
  const [abierta, setAbierta] = useState(guardado.abierta !== false);
  const [preguntar, setPreguntar] = useState(guardado.preguntar !== false);
  const [vol, setVol] = useState(guardado.vol ?? "");
  const [tipo, setTipo] = useState("mercado");
  const [precioLim, setPrecioLim] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [pendiente, setPendiente] = useState(null);   // "buy" | "sell": esperando confirmar
  const [enviando, setEnviando] = useState(false);
  const enviandoRef = useRef(false);
  const { revision, requiereRevision, marcarRevision, confirmarRevision } = useRevisionOrden("mt5");
  const [aviso, setAviso] = useState(null);           // { ok, texto }
  useEffect(() => { try { localStorage.setItem(CLAVE, JSON.stringify({ abierta, preguntar, vol })); } catch { /* sin almacenamiento */ } }, [abierta, preguntar, vol]);
  useEffect(() => { setPrecioLim(""); setSl(""); setTp(""); setPendiente(null); setAviso(null); }, [symbol]);
  useEffect(() => {
    if (!pendiente) return undefined;
    const esc = (e) => { if (e.key === "Escape") setPendiente(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [pendiente]);
  useEffect(() => {
    if (!aviso) return undefined;
    const t = setTimeout(() => setAviso(null), aviso.ok ? 5000 : 9000);
    return () => clearTimeout(t);
  }, [aviso]);

  const info = broker?.info ?? null;
  const dig = info?.digits ?? 2;
  const orden = (lado) => calcularOrden({
    info, broker, tipo, compra: lado === "buy", precioLim, vol, riesgo: "",
    sl: { modo: "precio", valor: sl }, tp: { modo: "precio", valor: tp },
  });
  const falta = faltaParaOperar(broker) || mercadoCerrado(broker?.horario) || (freno?.bloquea ? `Freno de disciplina: ${freno.motivos.join(" y ")}` : null);

  const mandar = async (lado) => {
    if (enviandoRef.current || requiereRevision() || falta) return;
    const c = orden(lado);
    if (!c || c.errores.length) { setAviso({ ok: false, texto: c?.errores[0] ?? "Sin cotización del broker" }); setPendiente(null); return; }
    if (preguntar && pendiente !== lado) { setPendiente(lado); setAviso(null); return; }
    setPendiente(null);
    enviandoRef.current = true;
    setEnviando(true);
    const r = await enviar({
      accion: "abrir", symbol, lado, tipo, volumen: c.v, precio: tipo === "limite" ? c.entrada : 0,
      sl: ok(c.slP) ? c.slP : 0, tp: ok(c.tpP) ? c.tpP : 0,
    });
    setEnviando(false);
    enviandoRef.current = false;
    marcarRevision(r);
    setAviso({ ok: r.ok, texto: r.mensaje ?? (r.ok ? "Orden enviada" : "No se pudo mandar") });
    if (r.ok) { setSl(""); setTp(""); setPrecioLim(""); }
  };

  if (!broker?.disponible || !info) return null;
  if (!abierta) {
    return (
      <button onClick={() => setAbierta(true)} data-tip="Compra rápida" aria-label="Mostrar la compra rápida"
              className="pointer-events-auto mt-1 flex h-6 cursor-pointer items-center gap-1.5 self-start rounded-md border border-borde bg-vidrio px-2 text-[11px] text-tenue hover:text-texto">
        <Icon name="operar" size={12} /> Compra rápida
      </button>
    );
  }
  const campo = "h-6 w-full min-w-0 rounded border border-linea bg-panel-2 px-1.5 font-mono text-[11px] text-texto outline-none focus:border-tenue placeholder:font-sans placeholder:text-apagado";
  const lado = (l) => {
    const compra = l === "buy";
    const confirmar = pendiente === l;
    const c = orden(l);
    return (
      <button onClick={() => mandar(l)} disabled={Boolean(falta || revision) || enviando}
              title={falta ?? (confirmar ? "Clic de nuevo para mandarla" : undefined)}
              className={`flex min-w-[86px] cursor-pointer flex-col items-center rounded-md border-0 px-2 py-1 leading-tight disabled:cursor-default disabled:opacity-45
                          ${confirmar ? (compra ? "bg-sube-fuerte text-white" : "bg-baja-fuerte text-white")
                            : compra ? "bg-[rgba(var(--rgb-sube),.14)] text-sube hover:bg-[rgba(var(--rgb-sube),.22)]" : "bg-[rgba(var(--rgb-baja),.14)] text-baja hover:bg-[rgba(var(--rgb-baja),.22)]"}`}>
        <span className="text-[11.5px] font-semibold">{confirmar ? "Confirmar" : compra ? "Comprar" : "Vender"}</span>
        <span className="font-mono text-[10px] opacity-90">
          {confirmar && ok(c?.v) ? `${fmtNum(c.v, decVol(c.v, info))} · ${tipo === "limite" ? fmt(c.entrada, dig) : "mercado"}` : fmt(compra ? info.ask : info.bid, dig)}
        </span>
      </button>
    );
  };
  return (
    <div className="pointer-events-auto mt-1 flex w-[300px] flex-col gap-1.5 self-start rounded-lg border border-borde bg-vidrio p-1.5 shadow-desk">
      <div className="flex items-center justify-between px-0.5 text-[10.5px] text-apagado">
        <span>FTMO · {broker.simbolo}</span>
        <span className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1" title="Pedir un segundo clic antes de mandar la orden">
            <input type="checkbox" checked={preguntar} onChange={(e) => setPreguntar(e.target.checked)} className="m-0 size-3 accent-texto" /> Confirmar
          </label>
          <button onClick={() => setAbierta(false)} aria-label="Plegar la compra rápida" className="grid size-4 cursor-pointer place-items-center border-0 bg-transparent p-0 text-apagado hover:text-texto">
            <Icon name="chevron" size={10} className="-rotate-90" />
          </button>
        </span>
      </div>
      <div className="flex items-stretch gap-1">
        {lado("sell")}
        <label className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-md bg-panel-2 px-1">
          <input value={vol} onChange={(e) => { setVol(e.target.value); setPendiente(null); }} inputMode="decimal" placeholder={String(info.volume_min ?? "0,01")}
                 className="w-full border-0 bg-transparent text-center font-mono text-[13px] font-semibold text-texto outline-none placeholder:text-apagado" />
          <span className="text-[9.5px] text-apagado">lotes</span>
        </label>
        {lado("buy")}
      </div>
      <div className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-1">
        <div className="flex rounded bg-panel-2 p-px">
          {[["mercado", "Mercado"], ["limite", "Límite"]].map(([id, n]) => (
            <button key={id} onClick={() => { setTipo(id); setPendiente(null); }}
                    className={`h-[22px] cursor-pointer rounded-sm border-0 px-1.5 text-[10.5px] ${tipo === id ? "bg-panel-3 text-texto" : "bg-transparent text-tenue hover:text-texto"}`}>{n}</button>
          ))}
        </div>
        <input value={precioLim} onChange={(e) => { setPrecioLim(e.target.value); setPendiente(null); }} disabled={tipo !== "limite"} inputMode="decimal"
               placeholder={tipo === "limite" ? "precio" : "—"} className={`${campo} disabled:opacity-40`} />
        <input value={sl} onChange={(e) => { setSl(e.target.value); setPendiente(null); }} inputMode="decimal" placeholder="SL" className={`${campo} text-baja`} />
        <input value={tp} onChange={(e) => { setTp(e.target.value); setPendiente(null); }} inputMode="decimal" placeholder="TP" className={`${campo} text-sube`} />
      </div>
      {(falta || aviso || pendiente) && (
        <p className={`m-0 px-0.5 text-[10.5px] ${aviso ? (aviso.ok ? "text-sube" : "text-baja") : falta ? "text-aviso" : "text-tenue"}`}>
          {aviso ? `${aviso.ok ? "✓" : "✗"} ${aviso.texto}` : falta ?? `Clic en Confirmar para mandar la ${pendiente === "buy" ? "compra" : "venta"} · Esc o cambiar algo la anula`}
        </p>
      )}
      <RevisionOrden revision={revision} alRevisar={confirmarRevision} />
    </div>
  );
}
