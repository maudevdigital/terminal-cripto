// Google Sheets con una API simulada: el acceso firmado, las pestanas, que solo se
// agreguen las operaciones nuevas, que las columnas propias (Setup, Nota, Leccion)
// nunca se escriban y los colores de los resultados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import type { Operacion } from "../src/historial.ts";
import { metricas } from "../src/historial.ts";
import { COLUMNAS, filaOperacion, filasResumen, Sheets } from "../src/sheets.ts";

const op = (ticket: number, resultado: number): Operacion => ({
  ticket, simbolo: "BTCUSD", lado: "compra", volumen: 0.1, apertura: Date.UTC(2026, 9, 19, 12), cierre: Date.UTC(2026, 9, 19, 15),
  entrada: 80_000, salida: 81_000, slInicial: 79_000, tp: null, bruto: resultado + 2, costos: -2, resultado,
  riesgo: 100, r: resultado / 100, pips: 1000, cerradaPor: "tp", minutos: 180, desdeTerminal: true,
});

test("la fila de una operacion llena solo las columnas de la terminal", () => {
  const f = filaOperacion(op(7, 98));
  assert.equal(f.length, 18);
  assert.equal(COLUMNAS.length, 21);
  assert.deepEqual(COLUMNAS.slice(18), ["Setup", "Nota", "Lección"]);
  assert.equal(f[0], "7");
  assert.equal(f[11], 98);
  assert.equal(f[15], "TP");
  assert.equal(f[17], "sí");
});

test("el resumen explica cada metrica en castellano", () => {
  const filas = filasResumen(metricas([op(1, 98), op(2, -50)]), null, "USD");
  const fila = (nombre: string) => filas.find((x) => x[0] === nombre)!;
  assert.deepEqual(filas[0], ["Métrica", "Valor", "Cómo se lee"]);
  assert.equal(fila("% ganadoras")[1], "50 %");
  assert.equal(fila("Resultado neto")[1], "48,00 USD");
  assert.match(fila("Factor de beneficio")[2], /por cada 1 perdido/);
});

/** Una API de Google Sheets simulada: guarda las pestanas, los metadatos y cada llamada. */
function googleFalso(pestanas: any[], tickets: { valor: string[][] }, metadatos: any[] = []) {
  const llamadas: { metodo: string; url: string; cuerpo: any }[] = [];
  const hoja = (id: number) => pestanas.find((p) => p.properties.sheetId === id);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string, o: any = {}) => {
    const cuerpo = typeof o.body === "string" ? JSON.parse(o.body) : o.body instanceof URLSearchParams ? Object.fromEntries(o.body) : undefined;
    llamadas.push({ metodo: o.method ?? "GET", url: String(url), cuerpo });
    const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "TOKEN", expires_in: 3600 });
    if (String(url).includes("sheets(properties(sheetId")) return ok({ properties: { locale: "en_US" }, developerMetadata: metadatos, sheets: pestanas });
    if (String(url).endsWith(":batchUpdate")) {
      const replies = (cuerpo.requests ?? []).map((r: any, i: number) => {
        if (r.createDeveloperMetadata) metadatos.push({ metadataId: 7, ...r.createDeveloperMetadata.developerMetadata });
        // Las reglas de color quedan guardadas como en Google (se agregan arriba).
        if (r.deleteConditionalFormatRule) hoja(r.deleteConditionalFormatRule.sheetId).conditionalFormats.splice(r.deleteConditionalFormatRule.index, 1);
        if (r.addConditionalFormatRule) {
          const h = hoja(r.addConditionalFormatRule.rule.ranges[0].sheetId);
          (h.conditionalFormats ??= []).splice(r.addConditionalFormatRule.index ?? 0, 0, structuredClone(r.addConditionalFormatRule.rule));
        }
        if (!r.addSheet) return {};
        const p = { sheetId: 10 + i, title: r.addSheet.properties.title };
        pestanas.push({ properties: p });
        return { addSheet: { properties: p } };
      });
      return ok({ replies });
    }
    if (String(url).includes("A2%3AA") || String(url).includes("!A2:A")) return ok({ values: tickets.valor });
    return ok({});
  }) as typeof fetch;
  return { llamadas, restaurar: () => { globalThis.fetch = fetchOriginal; } };
}

/** Una cuenta de servicio de prueba (con su clave) en la configuracion. */
function cuentaDePrueba() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "sheets-"));
  const cred = join(dir, "cuenta.json");
  writeFileSync(cred, JSON.stringify({ client_email: "terminal@proyecto.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  const antes = { cred: config.GOOGLE_CREDENCIALES, id: config.SHEETS_ID };
  config.GOOGLE_CREDENCIALES = cred;
  config.SHEETS_ID = "PLANILLA";
  return { publicKey, restaurar: () => { config.GOOGLE_CREDENCIALES = antes.cred; config.SHEETS_ID = antes.id; } };
}

const pedidos = (llamadas: any[], clave: string) =>
  llamadas.flatMap((l) => (l.cuerpo?.requests ?? []).filter((r: any) => r[clave]).map((r: any) => r[clave]));

test("sincroniza contra la API: acceso firmado, pestanas nuevas y solo filas nuevas", async () => {
  const cuenta = cuentaDePrueba();
  const tickets = { valor: [] as string[][] };
  const g = googleFalso([{ properties: { sheetId: 0, title: "Hoja 1" } }], tickets);
  const { llamadas } = g;
  try {
    const s = new Sheets();
    assert.equal(s.estado.configurado, true);
    const datos = { operaciones: [op(1, 98), op(2, -50)], dias: [], metricas: metricas([op(1, 98), op(2, -50)]), riesgo: null, moneda: "USD" };
    await s.sincronizar(datos);
    assert.equal(s.estado.error, null, s.estado.error ?? "");
    assert.equal(s.estado.filas, 2);

    // El acceso es un JWT firmado con la clave de la cuenta de servicio.
    const token = llamadas.find((l) => l.url.startsWith("https://oauth2.googleapis.com/token"))!;
    assert.equal(token.cuerpo.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [cab, cuerpo, firma] = token.cuerpo.assertion.split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${cab}.${cuerpo}`).verify(cuenta.publicKey, Buffer.from(firma, "base64url")));
    assert.equal(JSON.parse(Buffer.from(cuerpo, "base64url").toString()).scope, "https://www.googleapis.com/auth/spreadsheets");

    // Crea las tres pestanas, escribe los encabezados y agrega las dos operaciones.
    const alta = llamadas.find((l) => l.cuerpo?.requests?.[0]?.addSheet)!;
    assert.deepEqual(alta.cuerpo.requests.map((r: any) => r.addSheet.properties.title), ["Operaciones", "Días", "Resumen"]);
    const encabezado = llamadas.find((l) => l.metodo === "PUT")!;
    assert.deepEqual(encabezado.cuerpo.values[0], COLUMNAS);
    const agregado = llamadas.find((l) => l.url.includes(":append"))!;
    assert.equal(agregado.cuerpo.values.length, 2);
    assert.ok(agregado.cuerpo.values.every((f: unknown[]) => f.length === 18), "nunca escribe Setup, Nota ni Leccion");
    assert.ok(pedidos(llamadas, "addChart").length, "crea los graficos");
    // La pestana vacia que trae la planilla nueva se borra; queda en castellano.
    assert.deepEqual(pedidos(llamadas, "deleteSheet"), [{ sheetId: 0 }]);
    assert.equal(pedidos(llamadas, "updateSpreadsheetProperties")[0].properties.locale, "es_CL");
    assert.deepEqual(pedidos(llamadas, "updateSheetProperties").filter((r: any) => r.fields === "index")
      .map((r: any) => r.properties.index), [0, 1, 2]);
    assert.match(s.estado.url!, /#gid=12$/, "Abrir lleva al Resumen");
    const valores = llamadas.find((l) => l.url.endsWith("/values:batchUpdate"))!;
    assert.deepEqual(valores.cuerpo.data.map((d: any) => d.range), ["'Días'!A1", "'Resumen'!A1", "'Resumen'!E1", "'Resumen'!J1"]);

    // Los resultados con color: fondo y negrita en Resultado; TP y SL en "Cerrada por".
    const colores = pedidos(llamadas, "addConditionalFormatRule").map((r: any) => r.rule);
    const en = (c0: number) => colores.filter((r: any) => r.ranges[0].sheetId === 10 && r.ranges[0].startColumnIndex === c0);
    assert.deepEqual(en(11).map((r: any) => r.booleanRule.condition.type).sort(), ["NUMBER_GREATER", "NUMBER_LESS"]);
    assert.ok(en(11).every((r: any) => r.booleanRule.format.backgroundColor && r.booleanRule.format.textFormat.bold));
    assert.deepEqual(en(15).map((r: any) => r.booleanRule.condition.values[0].userEnteredValue).sort(), ["SL", "TP", "stop out"]);
    assert.deepEqual(pedidos(llamadas, "createDeveloperMetadata")[0].developerMetadata.metadataValue, "2");

    // Segunda vez: las dos ya estan en la planilla; llega una nueva y solo esa se agrega.
    tickets.valor = [["1"], ["2"]];
    llamadas.length = 0;
    await s.sincronizar({ ...datos, operaciones: [...datos.operaciones, op(3, 30)] });
    const segunda = llamadas.filter((l) => l.url.includes(":append"));
    assert.equal(segunda.length, 1);
    assert.deepEqual(segunda[0].cuerpo.values.map((f: unknown[]) => f[0]), ["3"]);
    assert.ok(!pedidos(llamadas, "addSheet").length, "no vuelve a crear pestanas");
    assert.ok(!pedidos(llamadas, "addConditionalFormatRule").length, "los colores ya estan: no se repiten");
    assert.equal(s.estado.filas, 3);
  } finally {
    g.restaurar();
    cuenta.restaurar();
  }
});

test("una planilla de antes se repinta una vez, sin tocar las reglas propias", async () => {
  const cuenta = cuentaDePrueba();
  const vieja = (sheetId: number, c0: number, c1: number, type: string, f0 = 1) => ({
    ranges: [{ sheetId, startRowIndex: f0, startColumnIndex: c0, endColumnIndex: c1 }],
    booleanRule: { condition: { type, values: [{ userEnteredValue: "0" }] }, format: { textFormat: {} } },
  });
  const tuya = { ranges: [{ sheetId: 1, startColumnIndex: 0, endColumnIndex: 1 }],
    booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "revisar" }] }, format: {} } };
  const g = googleFalso([
    { properties: { sheetId: 3, title: "Resumen" }, charts: [{ chartId: 1 }] },
    // Insertar filas al principio las corrio a la fila 368: ya no pintaban nada.
    { properties: { sheetId: 1, title: "Operaciones" }, conditionalFormats: [vieja(1, 11, 13, "NUMBER_LESS", 367), vieja(1, 11, 13, "NUMBER_GREATER", 367), tuya] },
    { properties: { sheetId: 2, title: "Días" }, conditionalFormats: [vieja(2, 3, 4, "NUMBER_LESS"), vieja(2, 3, 4, "NUMBER_GREATER")] },
  ], { valor: [["1"]] });
  try {
    const s = new Sheets();
    await s.sincronizar({ operaciones: [op(1, 98)], dias: [], metricas: metricas([op(1, 98)]), riesgo: null, moneda: "USD" });
    assert.equal(s.estado.error, null, s.estado.error ?? "");
    // Se borran las dos viejas de cada pestana (de la ultima a la primera); la tuya queda.
    assert.deepEqual(pedidos(g.llamadas, "deleteConditionalFormatRule"),
      [{ sheetId: 1, index: 1 }, { sheetId: 1, index: 0 }, { sheetId: 2, index: 1 }, { sheetId: 2, index: 0 }]);
    assert.equal(pedidos(g.llamadas, "addConditionalFormatRule").length, 9);
    assert.ok(!pedidos(g.llamadas, "deleteSheet").length, "no toca pestanas");
    // Las agrega escribiendo sobre filas vacias: insertar filas correria los colores.
    assert.ok(!g.llamadas.some((l) => l.url.includes("INSERT_ROWS")));
  } finally {
    g.restaurar();
    cuenta.restaurar();
  }
});

test("si la planilla crece mas alla de los colores, se rehacen", async () => {
  const cuenta = cuentaDePrueba();
  // Version al dia, pero las reglas llegan hasta la fila 3 y hay 5 operaciones.
  const corta = (sheetId: number, c0: number, c1: number, condition: any) => ({
    ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 3, startColumnIndex: c0, endColumnIndex: c1 }],
    booleanRule: { condition, format: {} },
  });
  const cero = (type: string) => ({ type, values: [{ userEnteredValue: "0" }] });
  const texto = (t: string) => ({ type: "TEXT_EQ", values: [{ userEnteredValue: t }] });
  const g = googleFalso([
    { properties: { sheetId: 3, title: "Resumen" }, charts: [{ chartId: 1 }] },
    { properties: { sheetId: 1, title: "Operaciones" }, conditionalFormats: [
      corta(1, 11, 12, cero("NUMBER_GREATER")), corta(1, 11, 12, cero("NUMBER_LESS")), corta(1, 12, 14, cero("NUMBER_GREATER")),
      corta(1, 12, 14, cero("NUMBER_LESS")), corta(1, 15, 16, texto("TP")), corta(1, 15, 16, texto("SL")), corta(1, 15, 16, texto("stop out")),
    ] },
    { properties: { sheetId: 2, title: "Días" }, conditionalFormats: [corta(2, 3, 4, cero("NUMBER_GREATER")), corta(2, 3, 4, cero("NUMBER_LESS"))] },
  ], { valor: [["1"], ["2"], ["3"], ["4"], ["5"]] }, [{ metadataId: 7, metadataKey: "terminal-formato", metadataValue: "2" }]);
  try {
    const s = new Sheets();
    const ops = [1, 2, 3, 4, 5].map((t) => op(t, 10));
    await s.sincronizar({ operaciones: ops, dias: [], metricas: metricas(ops), riesgo: null, moneda: "USD" });
    assert.equal(s.estado.error, null, s.estado.error ?? "");
    // Se rehacen las de las dos pestanas (7 de Operaciones y 2 de Dias).
    assert.equal(pedidos(g.llamadas, "deleteConditionalFormatRule").length, 9, "las cortas se rehacen");
    assert.equal(pedidos(g.llamadas, "addConditionalFormatRule").length, 9);
    // Con los colores al dia, la sincronizacion siguiente no los toca.
    g.llamadas.length = 0;
    await s.sincronizar({ operaciones: ops, dias: [], metricas: metricas(ops), riesgo: null, moneda: "USD" });
    assert.ok(!pedidos(g.llamadas, "addConditionalFormatRule").length);
  } finally {
    g.restaurar();
    cuenta.restaurar();
  }
});
