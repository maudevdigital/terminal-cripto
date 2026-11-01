import { useEffect, useState } from "react";
import { fmtNum } from "../lib/format.js";
import { num, ok } from "../lib/operativa.js";
import PausaReal from "./PausaReal.jsx";

/* Creditos demo: la misma practica con los precios de MT5, en una cuenta virtual
   (src/demo.ts). Tiene su propia ruta en el servidor: nada de aca llega a la cuenta real. */

const FECHA = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const FINAL = { tp: "TP", sl: "SL", be: "BE", manual: "A mano", limite: "Límite de la cuenta" };
const conSigno = (x, d = 2) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), d)}`;
const color = (x) => (x > 0 ? "text-sube" : x < 0 ? "text-baja" : "text-tenue");

async function pedir(cuerpo) {
  try {
    const r = await fetch("/api/demo", { method: "POST", headers: { "content-type": "application/json", "x-terminal": "demo" }, body: JSON.stringify(cuerpo) });
    return await r.json();
  } catch {
    return { ok: false, mensaje: "No se pudo hablar con el servidor." };
  }
}

const BOTON = "cursor-pointer rounded-md border border-borde bg-panel-2 px-2.5 py-1.5 text-[12px] text-texto hover:bg-panel-3";

function Empezar({ alResultado, titulo = "¿Con qué cuenta quieres practicar?" }) {
  const elegir = async (modo) => alResultado(await pedir({ accion: "empezar", modo }));
  return (
    <div className="flex flex-col gap-2 text-[12px] text-tenue">
      <b className="text-texto">{titulo}</b>
      <button className={BOTON} onClick={() => elegir("ftmo")}>Igual a mi FTMO: el mismo balance y el mismo límite</button>
      <button className={BOTON} onClick={() => elegir("nueva")}>Cuenta nueva de 10.000</button>
    </div>
  );
}

function Abierta({ o, dig, alResultado }) {
  const [sl, setSl] = useState(String(o.sl));
  const [tp, setTp] = useState(o.tp === null ? "" : String(o.tp));
  const pendiente = o.estado === "pendiente";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-borde bg-panel-2 p-2.5 text-[12px]">
      <div className="flex items-baseline justify-between gap-2">
        <b className={o.lado === 1 ? "text-sube" : "text-baja"}>{o.lado === 1 ? "Compra" : "Venta"}{pendiente ? " límite" : ""} {fmtNum(o.lotes, 2)} · {o.simbolo}</b>
        {!pendiente && <b className={`font-mono ${color(o.flotanteUsd)}`}>{o.flotanteUsd === null ? "—" : `${conSigno(o.flotanteUsd)} · ${conSigno(o.flotanteR, 2)} R`}</b>}
      </div>
      <span className="text-tenue">Entrada {fmtNum(o.entrada, dig)} · riesgo inicial {fmtNum(o.riesgoUsd, 2)} USD{o.riesgoMaxUsd > o.riesgoUsd ? ` · ampliado a ${fmtNum(o.riesgoMaxUsd, 2)}` : ""}</span>
      <div className="op-fila">
        <label className="op-campo">SL<input value={sl} inputMode="decimal" onChange={(e) => setSl(e.target.value)} /></label>
        <label className="op-campo">TP<input value={tp} inputMode="decimal" onChange={(e) => setTp(e.target.value)} /></label>
      </div>
      <div className="op-fila">
        <button className={BOTON} onClick={async () => alResultado(await pedir({ accion: "modificar", id: o.id, sl: num(sl), tp: tp.trim() ? num(tp) : null }))}>Guardar SL y TP</button>
        <button className={BOTON} onClick={async () => alResultado(await pedir({ accion: "cerrar", id: o.id }))}>{pendiente ? "Cancelar" : "Cerrar"}</button>
      </div>
    </div>
  );
}

function Medida({ nombre, valor, aviso = false }) {
  return <div className="flex justify-between gap-2"><span>{nombre}</span><b className={`font-mono ${aviso && valor ? "text-aviso" : "text-texto"}`}>{valor}</b></div>;
}

export default function Demo({ demo, broker, symbol, onBorrador, ajuste }) {
  const [lado, setLado] = useState("buy");
  const [tipo, setTipo] = useState("mercado");
  const [precioLim, setPrecioLim] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [riesgo, setRiesgo] = useState("");
  const [resultado, setResultado] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [recargar, setRecargar] = useState(false);

  const info = broker?.info;
  const dig = info?.digits ?? 2;
  const bid = num(broker?.bid), ask = num(broker?.ask);
  const cerrado = broker?.horario?.abierto === false;
  const entrada = tipo === "mercado" ? (lado === "buy" ? ask : bid) : num(precioLim);
  const slP = num(sl), tpP = num(tp);
  const riesgoUsd = ok(num(riesgo)) ? num(riesgo) : demo?.plan?.usd;
  const porPunto = num(info?.por_punto), paso = num(info?.volume_step) || 0.01;
  const pts = ok(entrada) && ok(slP) ? Math.abs(entrada - slP) : NaN;
  const lotes = ok(riesgoUsd) && ok(pts) && ok(porPunto) ? Math.floor(riesgoUsd / (pts * porPunto) / paso + 1e-9) * paso : NaN;
  const slUsd = ok(lotes) ? lotes * pts * porPunto : NaN;
  const tpUsd = ok(lotes) && ok(tpP) && ok(entrada) ? lotes * Math.abs(tpP - entrada) * porPunto : NaN;

  // Las lineas de lo que se arma, en el grafico y arrastrables, como en Operar.
  useEffect(() => {
    if (!onBorrador) return;
    const armando = tipo === "limite" || [sl, tp].some((x) => x.trim() !== "");
    if (!demo?.iniciada || !ok(entrada) || !armando) { onBorrador(null); return; }
    onBorrador({ demo: true, lado, tipo, dif: broker?.graficoBroker ? 0 : broker?.diferencia ?? 0, volumen: lotes, entrada, sl: ok(slP) ? slP : null, tp: ok(tpP) ? tpP : null, slUsd, tpUsd });
  }, [demo?.iniciada, lado, tipo, entrada, slP, tpP, lotes, slUsd, tpUsd, broker?.diferencia, broker?.graficoBroker, onBorrador]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBorrador?.(null), [onBorrador]);

  // Una linea arrastrada, o el + del eje: el precio va al formulario.
  useEffect(() => {
    if (!ajuste) return;
    if (ajuste.campo === "nueva" && Number.isFinite(ajuste.precioGrafico)) {
      const p = ajuste.precioGrafico + (broker?.graficoBroker ? 0 : broker?.diferencia ?? 0);
      setTipo("limite");
      setLado(ok(bid) && p > bid ? "sell" : "buy");
      setPrecioLim(String(Number(p.toFixed(dig))));
      return;
    }
    if (!Number.isFinite(ajuste.precio)) return;
    const v = String(Number(ajuste.precio.toFixed(dig)));
    if (ajuste.campo === "precio") { setTipo("limite"); setPrecioLim(v); }
    else if (ajuste.campo === "sl") setSl(v);
    else if (ajuste.campo === "tp") setTp(v);
  }, [ajuste]);   // eslint-disable-line react-hooks/exhaustive-deps

  const abrir = async () => {
    if (enviando) return;
    setEnviando(true);
    const r = await pedir({ accion: "abrir", symbol, lado, tipo, riesgo: riesgoUsd, precio: tipo === "limite" ? entrada : undefined, sl: ok(slP) ? slP : 0, tp: ok(tpP) ? tpP : null });
    setEnviando(false);
    setResultado(r);
    if (r.ok) { setSl(""); setTp(""); }
  };

  const aviso = "rounded-md border border-[rgba(var(--rgb-aviso),.45)] px-2.5 py-1.5 text-[11.5px] text-aviso";
  const encabezado = <div className={aviso}><b>DEMO</b> · créditos virtuales con precios reales. Nada de esto va a tu cuenta FTMO.</div>;
  const nota = resultado && <p className={`m-0 text-[12px] ${resultado.ok ? "text-tenue" : "text-baja"}`}>{resultado.mensaje}</p>;
  if (!demo) return <div className="operar">{encabezado}<span className="text-[12px] text-tenue">Cargando…</span></div>;
  if (!demo.iniciada) return <div className="operar">{encabezado}<Empezar alResultado={setResultado} />{nota}</div>;

  const vivas = demo.ops.filter((o) => o.estado === "abierta" || o.estado === "pendiente");
  const cerradas = demo.ops.filter((o) => o.estado === "cerrada");
  const r = demo.resumen;
  return (
    <div className="operar">
      {encabezado}
      <PausaReal pausa={broker?.freno?.pausa} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px] text-tenue">
        <span>Créditos<b className="block font-mono text-[15px] text-texto">{fmtNum(demo.balance, 2)}</b></span>
        <span>Flotante<b className={`block font-mono text-[15px] ${color(demo.flotante)}`}>{conSigno(demo.flotante)}</b></span>
        <span>Hasta el límite<b className="block font-mono text-texto">{fmtNum(demo.disponible, 2)}</b></span>
        <span>Objetivo<b className="block font-mono text-texto">{fmtNum(demo.objetivo, 0)}</b></span>
      </div>

      {demo.perdida ? (
        <div className="flex flex-col gap-2 rounded-md border border-baja-fuerte p-2.5 text-[12px]">
          <b className="text-baja">Cuenta demo perdida. {demo.perdida}</b>
          <span className="text-tenue">Es lo que habría pasado en FTMO. Mira lo que midió abajo antes de recargar.</span>
          <Empezar alResultado={setResultado} titulo="Recargar créditos" />
        </div>
      ) : !broker?.disponible || !broker?.vivo ? (
        <span className="text-[12px] text-tenue">Hace falta MT5 conectado: la demo usa sus precios.</span>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="op-fila">
            <div className="segmento chico">
              <button className={lado === "buy" ? "activo" : ""} onClick={() => setLado("buy")}>Compra</button>
              <button className={lado === "sell" ? "activo" : ""} onClick={() => setLado("sell")}>Venta</button>
            </div>
            <div className="segmento chico">
              <button className={tipo === "mercado" ? "activo" : ""} onClick={() => setTipo("mercado")}>Mercado</button>
              <button className={tipo === "limite" ? "activo" : ""} onClick={() => setTipo("limite")}>Límite</button>
            </div>
          </div>
          <div className="op-fila">
            {tipo === "limite" && <label className="op-campo">Precio límite<input value={precioLim} inputMode="decimal" onChange={(e) => setPrecioLim(e.target.value)} /></label>}
            <label className="op-campo">Riesgo (USD)
              <input value={riesgo} inputMode="decimal" placeholder={`Plan ${demo.plan?.usd ?? "—"}`} onChange={(e) => setRiesgo(e.target.value)}
                     title="Vacío: lo que queda hasta el límite repartido en tus SL seguidos. Sube si ganas y baja si pierdes." />
            </label>
          </div>
          <div className="op-fila">
            <label className="op-campo">Stop loss (obligatorio)<input value={sl} inputMode="decimal" placeholder="precio" onChange={(e) => setSl(e.target.value)} /></label>
            <label className="op-campo">Take profit<input value={tp} inputMode="decimal" placeholder="precio" onChange={(e) => setTp(e.target.value)} /></label>
          </div>
          <span className="text-[11.5px] text-tenue">
            {broker.simbolo} · {ok(lotes) ? `${fmtNum(lotes, 2)} lotes · riesgo ${fmtNum(slUsd, 2)} USD` : "pon el SL para ver los lotes"}{ok(tpUsd) && ok(slUsd) ? ` · ${fmtNum(tpUsd / slUsd, 1)} R` : ""}
          </span>
          <button className={`boton-orden ${lado === "buy" ? "compra" : "venta"}`} disabled={enviando || cerrado} onClick={abrir}>
            {cerrado ? "Mercado cerrado" : `Abrir ${lado === "buy" ? "compra" : "venta"} en demo`}
          </button>
        </div>
      )}
      {nota}

      {vivas.map((o) => <Abierta key={`${o.id}:${o.sl}:${o.tp}`} o={o} dig={dig} alResultado={setResultado} />)}

      <section className="flex flex-col gap-1 border-t border-borde pt-2.5 text-[12px] text-tenue">
        <b className="text-texto">Lo que va midiendo</b>
        <Medida nombre="Operaciones cerradas" valor={`${r.n} · ${r.ganadas} ganadas, ${r.perdidas} perdidas, ${r.be} BE`} />
        <Medida nombre="Resultado" valor={`${conSigno(r.usd)} USD · ${conSigno(r.r, 1)} R`} />
        <Medida nombre="Reentradas a menos de 5 min" valor={r.reentradas} aviso />
        <Medida nombre="SL ampliados" valor={r.slAmpliados} aviso />
        <Medida nombre="BE antes de +1 R" valor={r.beTempranos} aviso />
        <Medida nombre="Cierres a mano" valor={r.aMano} aviso />
        <Medida nombre="Días con una sola operación" valor={`${r.diasUna} de ${r.dias}`} />
        {r.sinTocar.n > 0 && (
          <p className="m-0 mt-1">En {r.sinTocar.n} {r.sinTocar.n === 1 ? "operación" : "operaciones"}, sin tocar el SL ni el TP originales: <b className={color(r.sinTocar.usd)}>{conSigno(r.sinTocar.usd)} USD</b>. Lo que hiciste: <b className={color(r.sinTocar.real)}>{conSigno(r.sinTocar.real)} USD</b>.</p>
        )}
      </section>

      {cerradas.length > 0 && (
        <section className="flex flex-col gap-1 border-t border-borde pt-2.5 text-[11.5px] text-tenue">
          <b className="text-[12px] text-texto">Últimas</b>
          {cerradas.map((o) => (
            <div key={o.id} className="flex items-baseline justify-between gap-2">
              <span>{FECHA.format(new Date(o.cerrada * 1000))} · {o.lado === 1 ? "compra" : "venta"} {o.simbolo} · {FINAL[o.final] ?? o.final}{o.sombra ? ` · sin tocar ${conSigno(o.sombra.usd, 0)}` : ""}</span>
              <b className={`font-mono ${color(o.usd)}`}>{conSigno(o.usd)}</b>
            </div>
          ))}
        </section>
      )}

      {!demo.perdida && (
        <section className="flex flex-col gap-2 border-t border-borde pt-2.5 text-[12px] text-tenue">
          {demo.recargas > 0 && <span>Recargas hasta ahora: {demo.recargas}</span>}
          {recargar ? <Empezar alResultado={(x) => { setResultado(x); setRecargar(false); }} titulo="Empezar de nuevo (lo que está abierto se pierde)" />
            : <button className={BOTON} onClick={() => setRecargar(true)}>Recargar créditos</button>}
        </section>
      )}
    </div>
  );
}
