import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import { fmtNum } from "../lib/format.js";
import { Logo, TIPO, decimales, fuenteDe, nombreDe, tipoDe } from "../lib/mercados.jsx";

// Los grupos de la lista, en este orden.
const GRUPOS = [["contexto", "Contexto"], ["indice", "Índices"], ["cripto", "Cripto"], ["materia", "Materias primas"], ["divisa", "Divisas"]];
const FILTROS = [["todos", "Todos"], ["alza", "Al alza"], ["baja", "A la baja"]];
const CLAVE = "terminal-cripto:lista";

/** Volumen corto, en es-CL: 333,7 mil o 1,2 M. */
const vol = (v) => (v >= 1e6 ? `${fmtNum(v / 1e6, 1)} M` : v >= 1e3 ? `${fmtNum(v / 1e3, 1)} mil` : fmtNum(v, 0));
const signo = (x, d) => `${x >= 0 ? "+" : "−"}${fmtNum(Math.abs(x), d)}`;

/** La lista de seguimiento: pestanas (todos, al alza, a la baja), un
 *  buscador, los mercados agrupados por tipo (los grupos se pliegan), cada uno con su
 *  minigrafica de 24 h, el precio, el cambio y el % del dia; abajo, la ficha del
 *  elegido con el arco del rango de hoy. */
export default function Lista({ cfg, symbol, onSymbol }) {
  const [datos, setDatos] = useState(null);
  const [filtro, setFiltro] = useState("todos");
  const [q, setQ] = useState("");
  const [plegados, setPlegados] = useState(() => { try { return JSON.parse(localStorage.getItem(CLAVE) || "{}").plegados ?? []; } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(CLAVE, JSON.stringify({ plegados })); } catch { /* sin almacenamiento */ } }, [plegados]);
  useEffect(() => {
    let vivo = true;
    const pedir = () => fetch("/api/lista").then((r) => r.json()).then((d) => { if (vivo) setDatos(d); }).catch(() => {});
    pedir();
    const t = setInterval(pedir, 5000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  const filas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (datos ?? []).filter((x) => x.last !== null)
      .filter((x) => filtro === "todos" || (filtro === "alza" ? x.change_pct >= 0 : x.change_pct < 0))
      .filter((x) => !t || [x.symbol, nombreDe(cfg, x.symbol), fuenteDe(cfg, x.symbol)].some((c) => c.toLowerCase().includes(t)));
  }, [datos, filtro, q, cfg]);
  const grupos = GRUPOS.map(([id, nombre]) => [id, nombre, filas.filter((x) => tipoDe(cfg, x.symbol) === id)]).filter(([, , f]) => f.length);
  const elegido = datos?.find((x) => x.symbol === symbol) ?? null;
  const total = (datos ?? []).filter((x) => x.last !== null).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 px-3 pt-2.5">
        <div className="flex flex-1 rounded-lg bg-panel-2 p-0.5">
          {FILTROS.map(([id, nombre]) => (
            <button key={id} onClick={() => setFiltro(id)}
                    className={`flex-1 cursor-pointer rounded-md border-0 py-1.5 text-[12px] font-medium ${filtro === id ? "bg-panel-3 text-texto shadow-[inset_0_0_0_1px_var(--borde)]" : "bg-transparent text-tenue hover:text-texto"}`}>
              {nombre}
            </button>
          ))}
        </div>
      </div>
      <label className="mx-3 mt-2 flex flex-none items-center gap-2 rounded-md bg-panel-2 px-2.5 py-1.5 text-apagado focus-within:shadow-[inset_0_0_0_1px_var(--borde)]">
        <Icon name="buscar" size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar símbolo o nombre" spellCheck={false}
               className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[12px] text-texto outline-none placeholder:text-apagado" />
      </label>
      <div className="grid flex-none grid-cols-[1fr_64px_92px_58px] items-center gap-2 border-b border-borde px-3 pt-2 pb-1.5 text-[10.5px] text-apagado">
        <span>Mercado</span>
        <span className="text-center">24 h</span>
        <span className="text-right">Último</span>
        <span className="text-right">% día</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!datos && <p className="px-3.5 text-tenue">Cargando…</p>}
        {grupos.map(([id, titulo, xs]) => {
          const plegado = plegados.includes(id);
          return (
            <section key={id}>
              <button onClick={() => setPlegados((p) => (plegado ? p.filter((x) => x !== id) : [...p, id]))}
                      className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 pt-2.5 pb-1 text-left text-[11.5px] text-tenue hover:text-texto">
                <Icon name="chevron" size={10} className={`transition-transform ${plegado ? "" : "rotate-90"}`} />
                {titulo} <span className="font-mono text-[10.5px] text-apagado">{xs.length}</span>
              </button>
              {!plegado && xs.map((x) => {
                const dec = decimales(x.symbol, x.last);
                const sube = (x.change_pct ?? 0) >= 0;
                const activo = x.symbol === symbol;
                const tipo = tipoDe(cfg, x.symbol), nombre = nombreDe(cfg, x.symbol);
                return (
                  <button key={x.symbol} onClick={() => onSymbol(x.symbol)}
                          className={`relative grid w-full cursor-pointer grid-cols-[1fr_64px_92px_58px] items-center gap-2 border-0 px-3 py-2 text-left
                                      ${activo ? "bg-panel-3" : "bg-transparent hover:bg-hover"}`}>
                    {activo && <i className="absolute inset-y-0 left-0 w-0.5 bg-texto" />}
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Logo tipo={tipo} nombre={nombre} />
                      <span className="min-w-0">
                        <b className="block truncate text-[12.5px] font-semibold text-texto">{nombre}</b>
                        <small className="block truncate text-[11px] text-apagado">{fuenteDe(cfg, x.symbol)}</small>
                      </span>
                    </span>
                    <Mini puntos={x.puntos} sube={sube} />
                    <span className="text-right font-mono tabular-nums">
                      <span className="block text-[12.5px] text-texto">{fmtNum(x.last, dec)}</span>
                      <span className={`block text-[10.5px] ${sube ? "text-sube" : "text-baja"}`}>{x.cambio !== null ? signo(x.cambio, dec) : ""}</span>
                    </span>
                    <span className={`text-right font-mono text-[11.5px] tabular-nums ${sube ? "text-sube" : "text-baja"}`}>
                      {Number.isFinite(x.change_pct) ? `${signo(x.change_pct, 2)} %` : "—"}
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      <div className="flex flex-none justify-between border-t border-borde px-3 py-1.5 text-[10.5px] text-apagado">
        <span>Precios · 24 h</span>
        <span>{total} {total === 1 ? "símbolo" : "símbolos"}</span>
      </div>
      {elegido && <Ficha x={elegido} cfg={cfg} />}
    </div>
  );
}

/** La minigrafica de las ultimas 24 h. */
function Mini({ puntos, sube }) {
  if (!puntos?.length) return <span />;
  const min = Math.min(...puntos), max = Math.max(...puntos), r = max - min || 1;
  const d = puntos.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, puntos.length - 1)) * 64},${20 - ((v - min) / r) * 18}`).join("");
  return (
    <svg width="64" height="22" viewBox="0 0 64 22" className={sube ? "text-sube" : "text-baja"} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** La ficha del elegido: el arco del rango de hoy (de la apertura a
 *  ahora, coloreado), el precio grande, el cambio de hoy y la rueda de hoy. */
function Ficha({ x, cfg }) {
  const dec = decimales(x.symbol, x.last);
  const sube = (x.change_pct ?? 0) >= 0;
  const d = x.dia;
  const tipo = tipoDe(cfg, x.symbol), nombre = nombreDe(cfg, x.symbol);
  const rango = d && d.h > d.l ? d.h - d.l : null;
  const en = (p) => Math.min(1, Math.max(0, (p - d.l) / rango));
  // El arco: 240 grados, abierto abajo; 0 = minimo del dia, 1 = maximo.
  const R = 46, CX = 60, CY = 56;
  const punto = (f) => { const a = ((210 - 240 * f) * Math.PI) / 180; return [CX + R * Math.cos(a), CY - R * Math.sin(a)]; };
  const arco = (f0, f1) => {
    const [x0, y0] = punto(f0), [x1, y1] = punto(f1);
    return `M${x0},${y0} A${R},${R} 0 ${Math.abs(f1 - f0) * 240 > 180 ? 1 : 0} 1 ${x1},${y1}`;
  };
  const fa = rango ? en(d.o) : null, fu = rango ? en(x.last) : null;
  return (
    <div className="flex-none border-t border-borde">
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <Logo tipo={tipo} nombre={nombre} tam="size-8 text-[13px]" />
        <span className="min-w-0">
          <b className="block truncate text-[14px] font-semibold">{nombre}</b>
          <small className="block truncate text-[11px] text-apagado">{fuenteDe(cfg, x.symbol)} · {TIPO[tipo]}</small>
        </span>
      </div>
      <div className="flex items-center gap-3 px-3 pt-2 pb-1">
        {rango !== null && (
          <svg width="120" height="104" viewBox="0 0 120 104" className="flex-none" aria-label={`${fmtNum(fu * 100, 0)} % del rango de hoy`}>
            <path d={arco(0, 1)} fill="none" stroke="var(--panel-3)" strokeWidth="7" strokeLinecap="round" />
            {Math.abs(fu - fa) > 0.005 && (
              <path d={arco(Math.min(fa, fu), Math.max(fa, fu))} fill="none" stroke={sube ? "var(--sube)" : "var(--baja)"} strokeWidth="7" strokeLinecap="round" />
            )}
            <circle cx={punto(fu)[0]} cy={punto(fu)[1]} r="4.5" fill="var(--texto)" stroke="var(--panel)" strokeWidth="2" />
            <text x="60" y="44" textAnchor="middle" className="fill-apagado font-mono text-[8.5px] font-semibold tracking-[.1em]">HOY</text>
            <text x="60" y="61" textAnchor="middle" className={`font-mono text-[13px] font-semibold ${sube ? "fill-sube" : "fill-baja"}`}>
              {Number.isFinite(x.change_pct) ? `${signo(x.change_pct, 2)} %` : "—"}
            </text>
            <text x="60" y="75" textAnchor="middle" className="fill-tenue font-mono text-[8.5px]">{fmtNum(fu * 100, 0)} % del rango</text>
          </svg>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[22px] leading-tight font-semibold tracking-tight text-texto tabular-nums">{fmtNum(x.last, dec)}</div>
          <div className={`font-mono text-[11.5px] tabular-nums ${sube ? "text-sube" : "text-baja"}`}>{x.cambio !== null ? `${signo(x.cambio, dec)} hoy` : ""}</div>
          {d && (
            <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
              {[["Apertura", fmtNum(d.o, dec)], ["Máximo", fmtNum(d.h, dec)], ["Mínimo", fmtNum(d.l, dec)], ["Volumen", d.v ? vol(d.v) : "—"]].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-tenue">{k}</dt>
                  <dd className="m-0 text-right font-mono text-texto tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      {rango !== null && (
        <p className="m-0 flex items-center gap-2 px-3 pb-2.5 text-[10.5px] text-apagado">
          <i className={`h-0.5 w-3 rounded ${sube ? "bg-sube" : "bg-baja"}`} />De la apertura a ahora, en el rango de hoy
        </p>
      )}
    </div>
  );
}
