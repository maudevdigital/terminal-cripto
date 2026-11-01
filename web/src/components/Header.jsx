import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { fmt, fmtNum, getDecimals } from "../lib/format.js";

// Un mercado de la cabecera (en el celular) y los estados de la derecha.
const PAR = "relative flex cursor-pointer items-baseline gap-[7px] whitespace-nowrap rounded-lg border px-2.5 py-[7px] transition-colors movil:px-[9px] movil:py-1.5";
const PAR_ACTIVO = "border-borde bg-panel-2";
const PAR_NORMAL = "border-transparent bg-transparent hover:bg-panel";
const CONEXION = "flex items-center gap-1.5 whitespace-nowrap text-[12px] text-tenue movil:text-[11.5px]";
const PUNTO = "size-[7px] rounded-full movil:size-2";
const PUNTO_VIVO = "bg-sube-fuerte shadow-[0_0_0_3px_rgba(var(--rgb-sube),.22)]";

export default function Header({ cfg, symbol, onSymbol, payload, conectado, sonidos, onSonidos, movil }) {
  const [ahora, setAhora] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setAhora(Date.now()), 1000); return () => clearInterval(t); }, []);
  const tickers = (payload && payload.tickers) || {};
  // Al cambiar de mercado, la foto anterior no describe la nueva vista.
  const actual = payload?.symbol === symbol ? payload : null;
  const feed = actual?.feed;
  const fuente = actual?.fuente;
  const vivo = conectado === true && (fuente?.broker
    ? fuente.ultimoDato && ahora - fuente.ultimoDato < 15000
    : !fuente && symbol !== "USDT.D" && feed?.stream_up && Math.max(ahora, feed.server_ms) - feed.last_event_ms < 15000);
  const estado = conectado === false ? "Sin conexión" : vivo ? "En vivo" : !actual ? "Cargando datos"
    : symbol === "USDT.D" ? "USDT.D estimada" : fuente && !fuente.broker ? "Datos con retraso" : "Sin datos recientes";
  // MT5: el puente publicando (verde), abriendose (amarillo) o sin el (gris).
  const br = actual?.broker;
  const lz = br && br.lanzador;
  const mt5 = br && br.disponible && br.vivo ? "vivo" : lz && ["buscando", "abriendo"].includes(lz.estado) ? "abriendo" : "";
  // La pestaña del navegador, como en TradingView: el activo, su precio y el % del dia.
  const tTit = tickers[symbol];
  const nombreTit = symbol === "USDT.D" ? "USDT.D" : cfg.mercados[symbol]?.nombre ?? symbol.replace("USDT", "");
  const decTit = symbol === "USDT.D" ? 3 : payload && symbol === payload.symbol ? getDecimals() : 2;
  const titulo = !tTit ? `${nombreTit} · Terminal`
    : `${nombreTit} ${fmt(tTit.last, decTit)}${Number.isFinite(tTit.change_pct) ? ` ${tTit.change_pct >= 0 ? "▲ +" : "▼ −"}${fmtNum(Math.abs(tTit.change_pct))} %` : ""}`;
  useEffect(() => { document.title = titulo; }, [titulo]);
  const mt5Titulo = br && br.disponible && br.vivo ? `MT5 conectado · ${br.cuenta?.servidor ?? ""}`
    : (lz && lz.detalle) || (lz && lz.estado === "abriendo" ? "Abriendo MetaTrader 5…" : "MT5 sin el puente: los índices salen de Yahoo");
  const nombreFuente = fuente?.nombre ?? (symbol === "USDT.D" ? "CoinGecko · estimada" : cfg.mercados[symbol]?.fuente ?? "Fuente pendiente");
  return (
    <header className="header flex h-[34px] flex-none items-center gap-3 border-b border-borde bg-fondo px-3 movil:h-auto movil:min-h-[62px] movil:flex-wrap movil:gap-x-3 movil:gap-y-0 movil:px-2.5 movil:py-1">
      <div className="flex items-center gap-[9px] font-[650] tracking-[.01em] movil:hidden">
        <span className="grid size-[22px] place-items-center rounded-md bg-texto text-fondo"><Icon name="logo" size={14} /></span>
        <span className="text-[13px]">Terminal</span>
      </div>
      {/* En la compu los mercados estan en la lista de seguimiento (rail, L); en el celular, aca. */}
      {movil ? (
      <nav aria-label="Mercados" className="order-first flex h-8 w-full flex-none gap-1 overflow-x-auto [scrollbar-width:none]">
        {cfg.usdtd && (
          <button className={`${PAR} ${symbol === "USDT.D" ? PAR_ACTIVO : PAR_NORMAL} mr-2 after:absolute after:inset-y-2 after:-right-[7px] after:w-px after:bg-borde`} onClick={() => onSymbol("USDT.D")}
                  title="Dominancia de USDT: si baja, el dinero entra a cripto">
            <span className="font-[650]">USDT.D</span>
            <span className="font-mono tabular-nums">{tickers["USDT.D"] ? `${fmtNum(tickers["USDT.D"].last, 3)}%` : "—"}</span>
            {tickers["USDT.D"]?.change_pct !== undefined && (
              <span className={`text-[11.5px] tabular-nums ${tickers["USDT.D"].change_pct <= 0 ? "text-sube" : "text-baja"}`}>
                {tickers["USDT.D"].change_pct >= 0 ? "+" : ""}{fmtNum(tickers["USDT.D"].change_pct)}%
              </span>
            )}
          </button>
        )}
        {cfg.symbols.map((s, k) => {
          const t = tickers[s];
          const m = cfg.mercados[s];
          const dec = payload && s === payload.symbol ? getDecimals() : t && t.last >= 100 ? 2 : t && t.last >= 0.1 ? 4 : 5;
          const chg = t && t.change_pct !== undefined ? t.change_pct : null;
          // Una raya separa los grupos: cripto, indices y materias primas.
          const otroGrupo = k > 0 && (m?.grupo ?? m?.tipo) !== (cfg.mercados[cfg.symbols[k - 1]]?.grupo ?? cfg.mercados[cfg.symbols[k - 1]]?.tipo);
          return (
            <button key={s} onClick={() => onSymbol(s)}
                    className={`${PAR} ${s === symbol ? PAR_ACTIVO : PAR_NORMAL}${otroGrupo ? " ml-2 before:absolute before:inset-y-2 before:-left-[7px] before:w-px before:bg-borde" : ""}`}
                    title={m?.tipo === "indice" ? `${s}: CFD de FTMO por MT5 (sin MT5, el futuro ${m.fuente} de Yahoo Finance)`
                      : m?.tipo === "materia" ? `${s}: perpetuo de Binance (FTMO: ${cfg.mt5_simbolos?.[s] ?? s})`
                      : m?.tipo === "divisa" ? `${m.nombre}: Yahoo Finance (${m.fuente}), con unos minutos de retraso` : undefined}>
              <span className="font-[650]">{m?.nombre ?? s.replace("USDT", "")}</span>
              <span className="font-mono tabular-nums">{t ? fmt(t.last, dec) : "—"}</span>
              {chg !== null && <span className={`text-[11.5px] tabular-nums ${chg >= 0 ? "text-sube" : "text-baja"}`}>{chg >= 0 ? "+" : ""}{fmtNum(chg)}%</span>}
            </button>
          );
        })}
      </nav>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[12px] text-tenue movil:text-[11.5px]" title={`Fuente del gráfico: ${nombreFuente}`}>
        {nombreFuente}
      </span>
      <button onClick={onSonidos}
              className={`grid size-[26px] cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-tenue hover:bg-hover hover:text-texto${sonidos ? "" : " opacity-55"}`}
              title={sonidos ? "Sonidos de la operativa (ejecutada, SL, TP, cerrada, movida): prendidos" : "Sonidos de la operativa: apagados"}
              aria-label={sonidos ? "Apagar los sonidos" : "Prender los sonidos"}>
        <Icon name={sonidos ? "sonido" : "silencio"} size={15} />
      </button>
      {br !== undefined && br !== null && (
        <div className={`${CONEXION} -mr-1.5`} title={mt5Titulo}>
          <span className={`${PUNTO} ${mt5 === "vivo" ? PUNTO_VIVO : mt5 === "abriendo" ? "bg-aviso-fuerte" : "bg-apagado"}`} />MT5
        </div>
      )}
      <div className={CONEXION} role="status" aria-live="polite" aria-label={estado} title={estado}>
        <span className={`${PUNTO} ${vivo ? PUNTO_VIVO : conectado === false ? "bg-baja-fuerte" : "bg-apagado"}`} />{estado}
      </div>
    </header>
  );
}
