/* Historial en Google Sheets, con una cuenta de servicio de Google.
 *
 * Una vez: en Google Cloud se crea un proyecto, se activa la API de Google Sheets
 * y se crea una cuenta de servicio con una clave JSON. Una planilla tuya (vacia)
 * se comparte con el mail de esa cuenta, como editor. En el .env:
 *   GOOGLE_CREDENCIALES=C:\ruta\a\la-clave.json
 *   SHEETS_ID=<el id que esta en la URL de la planilla>
 *
 * La terminal escribe tres pestanas:
 *   Operaciones  una fila por operacion cerrada. Las columnas Setup, Nota y
 *                Leccion son tuyas: nunca se tocan, y las filas no se reescriben.
 *   Dias         el resultado de cada dia y cuanto del limite diario se uso.
 *   Resumen      las metricas, cada una con como leerla, y graficos de la
 *                planilla (se actualizan solos con los datos).
 * Solo se mandan los numeros del historial; la clave nunca sale de tu PC. */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import type { Dia, Metricas, Operacion, Riesgo } from "./historial.ts";
import { getLogger } from "./log.ts";

const log = getLogger("sheets");
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const PESTANAS = ["Operaciones", "Días", "Resumen"] as const;
const PESTANAS_ORDEN = ["Resumen", "Operaciones", "Días"] as const;   // como quedan en la planilla
// La pestana que trae una planilla nueva, segun el idioma de la cuenta.
const POR_DEFECTO = ["Sheet1", "Hoja 1", "Hoja1"];
// Todo en castellano de Chile, como el resto de la terminal (1.234,56).
const LOCALE = "es_CL";
// Version de los colores de los resultados: al subirla, las planillas se repintan una vez.
const FORMATO = 2;
const CLAVE_FORMATO = "terminal-formato";
// Ganancia y perdida: fondo claro con el texto oscuro del mismo tono (se lee bien y
// el signo del numero sigue diciendo lo mismo sin color).
const GANA = { fondo: { red: 0.843, green: 0.945, blue: 0.89 }, texto: { red: 0.06, green: 0.42, blue: 0.27 } };
const PIERDE = { fondo: { red: 0.984, green: 0.871, blue: 0.859 }, texto: { red: 0.64, green: 0.165, blue: 0.133 } };
// Donde van los colores de la terminal (columnas) y cuantas reglas son.
const ZONAS: Record<string, [number, number]> = { Operaciones: [11, 16], "Días": [3, 4] };
const REGLAS: Record<string, number> = { Operaciones: 7, "Días": 2 };

/** Las reglas de color que puso la terminal en una pestana: se reconocen por la
 *  columna y la condicion, aunque Google las haya corrido de fila. */
function reglasPropias(s: any): { r: any; i: number }[] {
  const zona = ZONAS[s.properties?.title];
  if (!zona) return [];
  return (s.conditionalFormats ?? []).map((r: any, i: number) => ({ r, i })).filter(({ r }: { r: any }) => {
    const c = r.booleanRule?.condition;
    const valor = c?.values?.[0]?.userEnteredValue;
    const nuestra = ((c?.type === "NUMBER_GREATER" || c?.type === "NUMBER_LESS") && valor === "0")
      || (c?.type === "TEXT_EQ" && ["TP", "SL", "stop out"].includes(valor));
    return nuestra && (r.ranges ?? []).every((x: any) => x.startColumnIndex >= zona[0] && x.endColumnIndex <= zona[1]);
  });
}

export interface EstadoSheets {
  configurado: boolean;
  url: string | null;
  ultimo: number | null;        // ms de la ultima sincronizacion completa
  error: string | null;
  sincronizando: boolean;
  filas: number | null;         // operaciones que hay en la planilla
}

export interface DatosSheets {
  operaciones: Operacion[];
  dias: Dia[];
  metricas: Metricas;
  riesgo: Riesgo | null;
  moneda: string;
}

export const COLUMNAS = [
  "Ticket", "Apertura", "Cierre", "Mercado", "Lado", "Volumen", "Entrada", "Salida", "SL inicial", "TP",
  "Riesgo", "Resultado", "Resultado (R)", "Pips", "Costos", "Cerrada por", "Duración (min)", "Desde la terminal",
  "Setup", "Nota", "Lección",
];
const PROPIAS = 18;   // A..R las escribe la terminal; S..U son tuyas

const MOTIVO: Record<string, string> = { sl: "SL", tp: "TP", manual: "a mano", stop_out: "stop out", otro: "otro" };

const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });
const n2 = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaHora = (ms: number) => {
  const f = new Date(ms);
  const d2 = (x: number) => String(x).padStart(2, "0");
  return `${f.getFullYear()}-${d2(f.getMonth() + 1)}-${d2(f.getDate())} ${d2(f.getHours())}:${d2(f.getMinutes())}`;
};

/** La fila de una operacion en la pestana Operaciones (solo las columnas propias). */
export function filaOperacion(o: Operacion): (string | number)[] {
  return [
    String(o.ticket), fechaHora(o.apertura), fechaHora(o.cierre), o.simbolo, o.lado, o.volumen,
    o.entrada, o.salida, o.slInicial ?? "", o.tp ?? "", o.riesgo ?? "", o.resultado, o.r ?? "",
    o.pips ?? "", o.costos, MOTIVO[o.cerradaPor] ?? o.cerradaPor, o.minutos, o.desdeTerminal ? "sí" : "no",
  ];
}

/** Las metricas en castellano, cada una con como se lee. */
export function filasResumen(m: Metricas, riesgo: Riesgo | null, moneda: string): string[][] {
  const plata = (x: number | null) => (x === null ? "—" : `${n2.format(x)} ${moneda}`);
  const filas: string[][] = [
    ["Métrica", "Valor", "Cómo se lee"],
    ["Operaciones", String(m.operaciones), "cerradas en el historial exportado"],
    ["% ganadoras", m.pctGanadoras === null ? "—" : `${num.format(m.pctGanadoras)} %`, "de cada 10 operaciones, cuántas cerraron en positivo"],
    ["Resultado neto", plata(m.neto), "lo ganado menos lo perdido, con comisiones y swap"],
    ["Ganancia media", plata(m.gananciaMedia), "lo que deja en promedio una operación ganadora"],
    ["Pérdida media", plata(m.perdidaMedia), "lo que cuesta en promedio una operación perdedora"],
    ["Factor de beneficio", m.factorBeneficio === null ? "—" : num.format(m.factorBeneficio), "lo ganado por cada 1 perdido: más de 1 es ganar plata"],
    ["Expectativa", plata(m.expectativa), "lo que suma en promedio cada operación"],
    ["Expectativa en R", m.expectativaR === null ? "—" : `${num.format(m.expectativaR)} R`, `lo mismo en veces lo arriesgado (+0,3 R: cada operación suma el 30 % de su riesgo) · ${m.conR} con SL inicial`],
    ["Mejor operación", plata(m.mejor), ""],
    ["Peor operación", plata(m.peor), ""],
    ["Racha ganadora", String(m.rachaGanadora), "la mayor seguidilla de operaciones en positivo"],
    ["Racha perdedora", String(m.rachaPerdedora), "la mayor seguidilla de operaciones en negativo"],
    ["Caída máxima", `${plata(m.caidaMax)} (${num.format(m.caidaMaxPct)} %)`, "lo peor que bajó la cuenta desde un máximo"],
    ["Costos", plata(m.costos), "comisiones y swap pagados (negativo: lo que costaron)"],
    ["Duración media", m.minutosMedio === null ? "—" : `${num.format(m.minutosMedio)} min`, ""],
    ["Con SL desde la entrada", m.conSl === null ? "—" : `${num.format(m.conSl)} %`, "disciplina: operaciones que arrancaron con stop"],
    ["Cerradas por SL / TP / a mano", `${m.porMotivo.sl} / ${m.porMotivo.tp} / ${m.porMotivo.manual}`, m.porMotivo.stop_out ? `${m.porMotivo.stop_out} por stop out` : ""],
  ];
  if (riesgo) {
    filas.push(
      ["Balance inicial", plata(riesgo.inicial), "contra el que se miden los límites de la cuenta de fondeo"],
      ["Pérdida del día", riesgo.diaria ? `${plata(riesgo.diaria.usado)} de ${plata(riesgo.diaria.limite)}` : "—", "al momento de sincronizar"],
      ["Pérdida máxima", riesgo.maxima ? `${plata(riesgo.maxima.usado)} de ${plata(riesgo.maxima.limite)}` : "—", "desde el balance inicial"],
    );
  }
  return filas;
}

export class Sheets {
  estado: EstadoSheets = { configurado: false, url: null, ultimo: null, error: null, sincronizando: false, filas: null };
  private token: { valor: string; vence: number } | null = null;
  private pendiente: DatosSheets | null = null;
  private espera: ReturnType<typeof setTimeout> | null = null;
  private ultimoIntento = 0;

  constructor() {
    this.estado.configurado = Boolean(config.GOOGLE_CREDENCIALES && config.SHEETS_ID);
    this.estado.url = config.SHEETS_ID ? `https://docs.google.com/spreadsheets/d/${config.SHEETS_ID}/edit` : null;
  }

  /** Pide una sincronizacion: va enseguida si paso SHEETS_CADA desde la anterior;
   *  si no, cuando se cumpla (con los datos mas nuevos). */
  pedir(datos: DatosSheets, ya = false): void {
    if (!this.estado.configurado) return;
    this.pendiente = datos;
    if (this.estado.sincronizando || this.espera) return;
    const falta = ya ? 0 : Math.max(0, this.ultimoIntento + config.SHEETS_CADA * 1000 - Date.now());
    this.espera = setTimeout(() => {
      this.espera = null;
      const d = this.pendiente;
      this.pendiente = null;
      if (d) void this.sincronizar(d);
    }, falta);
    this.espera.unref?.();
  }

  private credenciales(): { client_email: string; private_key: string } {
    const c = JSON.parse(readFileSync(config.GOOGLE_CREDENCIALES, "utf8"));
    if (!c.client_email || !c.private_key) throw new Error("El JSON de GOOGLE_CREDENCIALES no es de una cuenta de servicio");
    return c;
  }

  /** Token de acceso: un JWT firmado con la clave de la cuenta de servicio. */
  private async acceso(): Promise<string> {
    if (this.token && Date.now() < this.token.vence - 60_000) return this.token.valor;
    const c = this.credenciales();
    const ahora = Math.floor(Date.now() / 1000);
    const b64 = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const firmado = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: c.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600,
    })}`;
    const firma = createSign("RSA-SHA256").update(firmado).sign(c.private_key).toString("base64url");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${firmado}.${firma}` }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google no dio acceso: ${j.error_description || j.error || r.status}`);
    this.token = { valor: j.access_token, vence: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.token.valor;
  }

  private async api(metodo: string, ruta: string, cuerpo?: unknown): Promise<any> {
    const r = await fetch(`${API}/${config.SHEETS_ID}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await this.acceso()}`, "Content-Type": "application/json" },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error?.message || `HTTP ${r.status}`;
      throw new Error(r.status === 403 ? `Sin permiso en la planilla: compartila con el mail de la cuenta de servicio (${msg})`
        : r.status === 404 ? `No existe la planilla ${config.SHEETS_ID}: revisá SHEETS_ID` : msg);
    }
    return j;
  }

  async sincronizar(d: DatosSheets): Promise<void> {
    if (!this.estado.configurado || this.estado.sincronizando) return;
    this.estado.sincronizando = true;
    this.ultimoIntento = Date.now();
    try {
      const ids = await this.pestanas();
      const hoja = (t: string) => encodeURIComponent(`'${t}'`);

      // Operaciones: solo se agregan las nuevas, abajo; lo escrito a mano no se toca.
      // Se escriben sobre las filas vacias, sin insertar filas: insertar corre hacia
      // abajo los colores (y cualquier regla) de la pestana.
      const col = await this.api("GET", `/values/${hoja("Operaciones")}!A2:A`);
      const hay = new Set<string>((col.values ?? []).map((f: string[]) => String(f[0] ?? "")));
      const nuevas = d.operaciones.filter((o) => !hay.has(String(o.ticket))).map(filaOperacion);
      if (nuevas.length) {
        await this.api("POST", `/values/${hoja("Operaciones")}!A1:R1:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
          { values: nuevas });
      }

      // Dias y Resumen se reescriben enteros: son solo de la terminal.
      const m = d.metricas;
      const diasFilas: (string | number)[][] = [
        ["Fecha", "Operaciones", "Ganadas", `Resultado (${d.moneda})`, `Balance al cierre (${d.moneda})`, "% del límite diario usado"],
        ...d.dias.map((x) => [x.fecha, x.operaciones, x.ganadas, x.resultado, x.balance, x.pctLimite ?? ""]),
      ];
      const mercados: (string | number)[][] = [["Mercado", "Operaciones", `Resultado (${d.moneda})`, "% ganadoras"],
        ...m.porMercado.map((x) => [x.simbolo, x.operaciones, x.neto, x.pctGanadoras])];
      const motivos: (string | number)[][] = [["Cerrada por", "Operaciones"],
        ...Object.entries(m.porMotivo).filter(([, n]) => n > 0).map(([k, n]) => [MOTIVO[k] ?? k, n])];
      await this.api("POST", "/values:batchClear", { ranges: ["'Días'!A:H", "'Resumen'!A:L"] });
      await this.api("POST", "/values:batchUpdate", {
        valueInputOption: "RAW",
        data: [
          { range: "'Días'!A1", values: diasFilas },
          { range: "'Resumen'!A1", values: filasResumen(m, d.riesgo, d.moneda) },
          { range: "'Resumen'!E1", values: mercados },
          { range: "'Resumen'!J1", values: motivos },
        ],
      });
      await this.revisarColores(ids, hay.size + nuevas.length, d.dias.length);
      await this.graficos(ids);
      this.estado = { ...this.estado, ultimo: Date.now(), error: null, filas: hay.size + nuevas.length };
      if (nuevas.length) log.info(`Google Sheets: ${nuevas.length} operaciones nuevas`);
    } catch (exc) {
      this.estado.error = exc instanceof Error ? exc.message : String(exc);
      log.warn(`Google Sheets: ${this.estado.error}`);
    } finally {
      this.estado.sincronizando = false;
      // Llego algo nuevo mientras sincronizaba: va en la proxima ventana.
      if (this.pendiente) this.pedir(this.pendiente);
    }
  }

  // Lo que ya tiene la planilla: pestanas (con sus reglas de color), graficos y la
  // version de los colores.
  private meta: { ids: Record<string, number>; graficos: number; hojas: any[]; marca: any | null } | null = null;

  /** Crea las pestanas que falten (con su formato) y devuelve sus ids. */
  private async pestanas(): Promise<Record<string, number>> {
    const info = await this.api("GET",
      "?fields=properties(locale),developerMetadata(metadataId,metadataKey,metadataValue),sheets(properties(sheetId,title),charts(chartId),conditionalFormats)");
    const ids: Record<string, number> = {};
    let graficos = 0;
    for (const s of info.sheets ?? []) {
      ids[s.properties.title] = s.properties.sheetId;
      if (s.properties.title === "Resumen") graficos = (s.charts ?? []).length;
    }
    const faltan = PESTANAS.filter((t) => ids[t] === undefined);
    if (faltan.length) {
      const r = await this.api("POST", ":batchUpdate", { requests: faltan.map((title) => ({ addSheet: { properties: { title } } })) });
      for (const rep of r.replies ?? []) ids[rep.addSheet.properties.title] = rep.addSheet.properties.sheetId;
      await this.formato(ids, faltan);
    }
    // Planilla recien armada (o todavia con su pestana por defecto): se acomoda una vez.
    const porDefecto = (info.sheets ?? []).filter((s: any) => POR_DEFECTO.includes(s.properties.title));
    if (faltan.length || porDefecto.length) await this.acomodar(ids, porDefecto);
    // Siempre es-CL: si la planilla quedo en otro idioma, se corrige.
    else if (info.properties?.locale !== LOCALE) {
      await this.api("POST", ":batchUpdate", { requests: [
        { updateSpreadsheetProperties: { properties: { locale: LOCALE }, fields: "locale" } },
      ] });
    }
    const marca = (info.developerMetadata ?? []).find((m: any) => m.metadataKey === CLAVE_FORMATO) ?? null;
    this.meta = { ids, graficos, hojas: info.sheets ?? [], marca };
    // "Abrir" lleva directo al Resumen.
    this.estado.url = `https://docs.google.com/spreadsheets/d/${config.SHEETS_ID}/edit#gid=${ids.Resumen}`;
    return ids;
  }

  /** La primera vez: borra la pestana vacia que trae toda planilla nueva ("Hoja 1"),
   *  deja Resumen, Operaciones y Dias adelante, pone la planilla en castellano (asi
   *  los numeros se ven 1.234,56, en es-CL) y da formato a los numeros. Una pestana por defecto
   *  con algo escrito no se toca. */
  private async acomodar(ids: Record<string, number>, porDefecto: any[]): Promise<void> {
    const req: any[] = [];
    for (const s of porDefecto) {
      const v = await this.api("GET", `/values/${encodeURIComponent(`'${s.properties.title}'`)}`);
      if (!(v.values ?? []).length && !(s.charts ?? []).length) req.push({ deleteSheet: { sheetId: s.properties.sheetId } });
    }
    PESTANAS_ORDEN.forEach((t, index) => req.push({
      updateSheetProperties: { properties: { sheetId: ids[t], index }, fields: "index" },
    }));
    const info = await this.api("GET", "?fields=properties(title,locale)");
    const sinTitulo = ["Untitled spreadsheet", "Hoja de cálculo sin título", ""].includes(info.properties?.title ?? "");
    req.push({
      updateSpreadsheetProperties: {
        properties: { locale: LOCALE, ...(sinTitulo ? { title: "Diario de trading · Terminal" } : {}) },
        fields: sinTitulo ? "locale,title" : "locale",
      },
    });
    // Formato de los numeros (el patron es el mismo en cualquier idioma).
    const numero = (sheetId: number, c0: number, c1: number, pattern: string) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
    const op = ids.Operaciones, dia = ids["Días"];
    req.push(
      numero(op, 5, 6, "0.00"),              // volumen
      numero(op, 6, 10, "#,##0.00###"),      // entrada, salida, SL inicial, TP
      numero(op, 10, 12, "#,##0.00"),        // riesgo y resultado
      numero(op, 12, 13, "+0.00;-0.00;0"),   // R
      numero(op, 13, 14, "#,##0.0"),         // pips
      numero(op, 14, 15, "#,##0.00"),        // costos
      numero(op, 16, 17, "#,##0"),           // duracion
      numero(dia, 3, 5, "#,##0.00"),         // resultado y balance
      numero(dia, 5, 6, "0.0"),              // % del limite
      numero(ids.Resumen, 6, 8, "#,##0.00"), // por mercado: resultado y % ganadoras
      ...PESTANAS.map((t) => ({
        autoResizeDimensions: { dimensions: { sheetId: ids[t], dimension: "COLUMNS", startIndex: 0, endIndex: 21 } },
      })),
    );
    await this.api("POST", ":batchUpdate", { requests: req });
    log.info("Google Sheets: planilla acomodada (pestañas, idioma y formato)");
  }

  /** Encabezados en negrita y fijos (los colores de los resultados van aparte). */
  private async formato(ids: Record<string, number>, nuevas: readonly string[]): Promise<void> {
    const req: any[] = [];
    for (const t of nuevas) {
      const sheetId = ids[t];
      req.push(
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.94, blue: 0.96 } } },
          fields: "userEnteredFormat(textFormat.bold,backgroundColor)" } },
      );
    }
    if (req.length) await this.api("POST", ":batchUpdate", { requests: req });
    if (nuevas.includes("Operaciones")) {
      await this.api("PUT", `/values/${encodeURIComponent("'Operaciones'")}!A1:U1?valueInputOption=RAW`, { values: [COLUMNAS] });
    }
  }

  /** Los resultados con color: fondo verde claro si gano y rojo claro si perdio, con
   *  el texto en un tono oscuro que se lee bien, en Resultado (en negrita), R y Pips
   *  de Operaciones y en el Resultado de Dias; en "Cerrada por", TP en verde y SL en
   *  rojo. Reemplaza las reglas de colores de una version anterior de la terminal
   *  (mismas columnas y condiciones); las que agregues tú no se tocan. */
  /** Los colores tienen que cubrir todas las filas con datos: se rehacen si son de
   *  una version anterior, si les falta alguna regla o si quedaron cortos o corridos
   *  (la planilla crecio, o alguien inserto filas arriba). */
  private async revisarColores(ids: Record<string, number>, filasOperaciones: number, filasDias: number): Promise<void> {
    const m = this.meta!;
    const cubre = (titulo: string, filas: number) => {
      const s = m.hojas.find((h: any) => h.properties.title === titulo);
      const propias = s ? reglasPropias(s) : [];
      return propias.length === REGLAS[titulo] && propias.every(({ r }) => (r.ranges ?? []).every((x: any) =>
        (x.startRowIndex ?? 0) <= 1 && (x.endRowIndex === undefined || x.endRowIndex >= filas + 1)));
    };
    if (Number(m.marca?.metadataValue ?? 0) >= FORMATO && cubre("Operaciones", filasOperaciones) && cubre("Días", filasDias)) return;
    await this.colores(ids, m.hojas, m.marca);
  }

  private async colores(ids: Record<string, number>, hojas: any[], marca: any | null): Promise<void> {
    const req: any[] = [];
    for (const s of hojas) {
      // De la ultima a la primera: los indices de las que quedan no se corren.
      for (const { i } of reglasPropias(s).reverse()) req.push({ deleteConditionalFormatRule: { sheetId: s.properties.sheetId, index: i } });
    }
    const regla = (sheetId: number, c0: number, c1: number, condition: any, color: any, negrita = false, fondo = true) => ({
      addConditionalFormatRule: { index: 0, rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 }],
        booleanRule: { condition, format: {
          ...(fondo ? { backgroundColor: color.fondo } : {}),
          textFormat: { foregroundColor: color.texto, bold: negrita },
        } },
      } },
    });
    const mayor = { type: "NUMBER_GREATER", values: [{ userEnteredValue: "0" }] };
    const menor = { type: "NUMBER_LESS", values: [{ userEnteredValue: "0" }] };
    const texto = (t: string) => ({ type: "TEXT_EQ", values: [{ userEnteredValue: t }] });
    const op = ids.Operaciones, dia = ids["Días"];
    req.push(
      regla(op, 11, 12, mayor, GANA, true), regla(op, 11, 12, menor, PIERDE, true),   // Resultado
      regla(op, 12, 14, mayor, GANA), regla(op, 12, 14, menor, PIERDE),               // R y pips
      regla(op, 15, 16, texto("TP"), GANA, true, false), regla(op, 15, 16, texto("SL"), PIERDE, true, false),
      regla(op, 15, 16, texto("stop out"), PIERDE, true),
      regla(dia, 3, 4, mayor, GANA, true), regla(dia, 3, 4, menor, PIERDE, true),     // resultado del dia
    );
    req.push(marca
      ? { updateDeveloperMetadata: {
          dataFilters: [{ developerMetadataLookup: { metadataId: marca.metadataId } }],
          developerMetadata: { metadataValue: String(FORMATO) }, fields: "metadataValue" } }
      : { createDeveloperMetadata: { developerMetadata: {
          metadataKey: CLAVE_FORMATO, metadataValue: String(FORMATO), location: { spreadsheet: true }, visibility: "DOCUMENT" } } });
    await this.api("POST", ":batchUpdate", { requests: req });
    log.info("Google Sheets: colores de los resultados aplicados");
  }

  /** Los graficos de la pestana Resumen, una sola vez (si se borran, se rehacen). */
  private async graficos(ids: Record<string, number>): Promise<void> {
    if (!this.meta || this.meta.graficos > 0) return;
    const rango = (sheetId: number, c0: number, f0 = 0, f1 = 3000) =>
      ({ sourceRange: { sources: [{ sheetId, startRowIndex: f0, endRowIndex: f1, startColumnIndex: c0, endColumnIndex: c0 + 1 }] } });
    const ancla = (fila: number, columna: number) =>
      ({ overlayPosition: { anchorCell: { sheetId: ids.Resumen, rowIndex: fila, columnIndex: columna }, widthPixels: 620, heightPixels: 300 } });
    const basico = (titulo: string, tipo: string, dominio: any, serie: any, pos: any, color: any) => ({
      addChart: { chart: { position: pos, spec: { title: titulo, basicChart: {
        chartType: tipo, legendPosition: "NO_LEGEND", headerCount: 1,
        domains: [{ domain: dominio }],
        series: [{ series: serie, targetAxis: "LEFT_AXIS", colorStyle: { rgbColor: color } }],
      } } } },
    });
    const azul = { red: 0.36, green: 0.55, blue: 0.95 }, verde = { red: 0.13, green: 0.6, blue: 0.4 };
    await this.api("POST", ":batchUpdate", { requests: [
      basico("Curva de la cuenta (balance al cierre de cada día)", "LINE", rango(ids["Días"], 0), rango(ids["Días"], 4), ancla(22, 0), azul),
      basico("Resultado de cada día", "COLUMN", rango(ids["Días"], 0), rango(ids["Días"], 3), ancla(22, 7), verde),
      basico("Resultado por mercado", "COLUMN", rango(ids.Resumen, 4, 0, 30), rango(ids.Resumen, 6, 0, 30), ancla(40, 0), azul),
      { addChart: { chart: { position: ancla(40, 7), spec: { title: "Cómo se reparten los resultados en R", histogramChart: {
        legendPosition: "NO_LEGEND", bucketSize: 0.5,
        series: [{ data: rango(ids.Operaciones, 12, 1, 5000), barColorStyle: { rgbColor: azul } }],
      } } } } },
    ] });
    this.meta.graficos = 4;
  }
}
