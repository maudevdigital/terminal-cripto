// Paleta desk (grises neutros, velas verde/rojo, poco chrome). Un solo lugar
// para los colores del grafico; la interfaz usa los mismos en styles.css (:root).
export const C = {
  fondo: "#121316",         // el grafico
  panel: "#151619",
  panel2: "#1C1D20",
  borde: "#2A2B2F",
  grilla: "rgba(250,250,250,.04)",
  cruz: "#A1A1A1",
  texto: "#FAFAFA",
  tenue: "#A1A1A1",
  fondoEtiqueta: "rgba(21,22,25,.92)",   // detras de los rotulos sobre las velas
  oscuro: "#FAFAFA",        // etiquetas del eje y lo que tiene que resaltar
  sobreOscuro: "#121316",
  acento: "#C4A574",
  cruzLinea: "rgba(161,161,161,.5)",
  etiquetaCruz: "#3A3C42",              // las pildoras de la cruz en los ejes   // la cruz del cursor
  rotulo: "rgba(250,250,250,.5)",       // textos tenues sobre el grafico
  rgbSube: "34,171,148",                 // para las bandas del SL y el TP
  rgbBaja: "242,54,69",

  // Velas: alcistas verde, bajistas rojo (mechas del mismo tono).
  velaSube: "#22AB94",
  velaBaja: "#F23645",
  bordeSube: "#22AB94",
  bordeBaja: "#F23645",
  mecha: "#A1A1A1",

  sube: "#22AB94",
  baja: "#F23645",
  // Posiciones de MT5
  entrada: "#FAFAFA",
  objetivo: "#C4A574",      // ordenes pendientes (limite o stop)
  poc: "#E07A5F",
  vpCompra: "34,171,148",
  vpVenta: "242,54,69",

  // Momento del squeeze en area (rgb): el tono fuerte mientras acelera y uno palido
  // cuando pierde fuerza.
  squeeze: { sube: ["34,171,148", "74,138,128"], baja: ["242,54,69", "178,92,98"] },
  // Los puntos de compresion y el ADX del indicador de TradingView, en fondo oscuro.
  compresion: { "#FF9800": "#FF9800", "#787B86": "#787B86", "#2962FF": "#5B8DEF" },
  adx: { "#E8EAED": "#E8EAED", "#787B86": "#787B86" },

  // EMA 10 / 50 / 200
  emas: ["#C5C9D1", "#C4A574", "#8B7BB8"],
};

export const CAPAS = [
  { id: "sesiones", nombre: "Sesiones", ayuda: "Sídney, Tokio, Londres y Nueva York: una caja por sesión con su máximo y su mínimo (hasta 1H)" },
  { id: "volumen", nombre: "Perfil de volumen", ayuda: "Perfiles de volumen: el del rango visible (VPVR) y uno por sesión (VPSV), juntos o por separado" },
  { id: "fvg", nombre: "FVG", ayuda: "Fair Value Gaps de esta temporalidad: solo los que el precio no barrió. Si una vela cierra al otro lado del hueco, se invierte (IFVG); si solo la mecha lo atraviesa, desaparece. Los 8 FVG y los 4 IFVG más recientes" },
  { id: "estructura", nombre: "Estructura", ayuda: "Estructura de mercado: BOS a favor de la tendencia y CHoCH contra ella, por cierre, en dos niveles (swing de 50 velas e interna de 5); los giros HH/HL/LH/LL y el máximo y el mínimo del tramo (fuerte o débil)" },
  { id: "ob", nombre: "Order blocks", ayuda: "Order blocks con volumen: la vela de donde salió un impulso que rompió un máximo o mínimo de giro con cierre, solo si el impulso trajo más volumen que el promedio. Adentro, el volumen comprado y vendido. Se borran cuando una vela cierra al otro lado; más tenues si el precio ya volvió a tocarlos" },
  { id: "medias", nombre: "Medias", ayuda: "EMA 10, 50 y 200" },
  { id: "osc", nombre: "ADX + SQZ", ayuda: "El panel de abajo: el momento del squeeze en área (con los puntos de compresión) y el ADX con su nivel clave, en una sola escala" },
  { id: "posiciones", nombre: "Posiciones", ayuda: "Entrada, stop y objetivo de las posiciones abiertas en MT5 de este mercado (apagalas para grabar o compartir la pantalla)" },
];

// Vista inicial para estudiar estructura con tiempo: el precio conserva el espacio.
// Las capas de contexto y de volumen siguen disponibles en el menú.
export const CAPAS_INICIALES = { sesiones: false, volumen: false, fvg: true, estructura: true, ob: true, medias: false, osc: true, posiciones: true };

export const VISIBLE_BARS = 160;
