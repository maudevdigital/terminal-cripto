// Iconos SVG propios (sin emojis ni librerias). Heredan el color del texto.
const PATHS = {
  sonido: (<><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" /><path d="M10.8 5.6a3.4 3.4 0 0 1 0 4.8M12.6 3.8a6 6 0 0 1 0 8.4" /></>),
  silencio: (<><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" /><path d="M11 6l3.5 4M14.5 6L11 10" /></>),
  vline: (<><path d="M8 2v12" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></>),
  rayo: (<><path d="M3 12L14 3" /><circle cx="3" cy="12" r="1.6" fill="currentColor" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></>),
  extendida: (<><path d="M1.5 13.5l13-11" /><circle cx="5.5" cy="10.1" r="1.6" fill="currentColor" /><circle cx="10.5" cy="5.9" r="1.6" fill="currentColor" /></>),
  rayoH: (<><path d="M4 8h10.5" /><circle cx="4" cy="8" r="1.6" fill="currentColor" /></>),
  cruz: (<><path d="M8 2v12M2 8h12" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></>),
  info: (<><path d="M2.5 12.5l8-7" /><circle cx="2.5" cy="12.5" r="1.4" fill="currentColor" /><circle cx="10.5" cy="5.5" r="1.4" fill="currentColor" /><path d="M11.5 9.5h3M13 8v3" /></>),
  fib: (<><path d="M2 3h12M2 6.3h12M2 9.6h12M2 13h12" /><path d="M3 13L13 3" strokeDasharray="1.5 1.8" /></>),
  medir: (<><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 4.5v7M6.3 6.2L8 4.5l1.7 1.7M4.5 8h7M9.8 6.3L11.5 8l-1.7 1.7" /></>),
  regla: (<><path d="M2.5 11L11 2.5l2.5 2.5L5 13.5z" /><path d="M5 8.5l1.3 1.3M7 6.5l1.3 1.3M9 4.5l1.3 1.3" /></>),
  texto: (<><path d="M3.5 4V3h9v1M8 3v10M6.3 13h3.4" /></>),
  borrador: (<><path d="M9.5 2.8l3.7 3.7-6.6 6.6H3.3L2 11.8a1.5 1.5 0 0 1 0-2.1z" /><path d="M6 6.3l3.7 3.7M6.6 13.1h7" /></>),
  seguir: (<><path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" /><path d="M9 4l3 3" /><path d="M11 12.5h3M12.5 11v3" /></>),
  plegar: <path d="M8 4L4 8l4 4M12 4L8 8l4 4" />,
  desplegar: <path d="M8 4l4 4-4 4M4 4l4 4-4 4" />,
  demo: (<><circle cx="8" cy="8" r="5.8" /><circle cx="8" cy="8" r="3.3" /><path d="M8 6.4v3.2" /></>),
  lista: (<><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></>),
  capas: (<><path d="M8 2.5l5.5 2.8L8 8.1 2.5 5.3z" /><path d="M2.5 8l5.5 2.8L13.5 8" /><path d="M2.5 10.7l5.5 2.8 5.5-2.8" /></>),
  operar: (<><path d="M4.5 2.5v11M11.5 2.5v11" /><rect x="3" y="5" width="3" height="5" rx=".6" /><rect x="10" y="4" width="3" height="4.5" rx=".6" /></>),
  check: <path d="M3.5 8.5l3 3 6-7" />,
  buscar: (<><circle cx="7" cy="7" r="4.5" /><path d="M10.4 10.4l3.6 3.6" /></>),
  estrella: <path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z" />,
  estrellaLlena: <path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z" fill="currentColor" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  dot: <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />,
  alert: (<><path d="M8 2.5L14.5 13.5h-13z" /><path d="M8 6.5v3.2M8 11.6v.1" /></>),
  copy: (<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>),
  target: (<><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /></>),
  chevron: <path d="M6 4l4 4-4 4" />,
  logo: (<><path d="M3 12V6" /><path d="M8 13V3" /><path d="M13 10V5" /></>),
  expandir: (<><path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5L9 7" /><path d="M2.5 13.5L7 9" /></>),
  contraer: (<><path d="M13.5 6.5h-4v-4" /><path d="M2.5 9.5h4v4" /><path d="M9.5 6.5L14 2" /><path d="M6.5 9.5L2 14" /></>),
  todo: (<><path d="M2.5 8h11" /><path d="M5 5.5L2.5 8 5 10.5" /><path d="M11 5.5l2.5 2.5-2.5 2.5" /></>),
  cursor: <path d="M4 2.5l8 5.2-3.6.9 2 3.9-1.6.8-2-3.9L4 12z" />,
  hline: (<><path d="M1.5 8h13" /><circle cx="8" cy="8" r="1.6" /></>),
  linea: (<><path d="M3 13L13 3" /><circle cx="3" cy="13" r="1.6" /><circle cx="13" cy="3" r="1.6" /></>),
  rect: (<><rect x="2.5" y="3.5" width="11" height="9" rx="1" /><path d="M2.5 8h11" strokeDasharray="2 1.6" /></>),
  mover: (<><path d="M8 1.8v12.4M1.8 8h12.4" /><path d="M6 3.8L8 1.8l2 2M6 12.2l2 2 2-2M3.8 6L1.8 8l2 2M12.2 6l2 2-2 2" /></>),
  borrar: (<><path d="M6 13.5h7" /><path d="M2.6 10.4l6.9-6.9 3 3-5.4 5.4H5z" /></>),
  iman: (<><path d="M3.5 3v5a4.5 4.5 0 0 0 9 0V3" /><path d="M3.5 5.5h2.5M10 5.5h2.5" /><path d="M6 3v5a2 2 0 0 0 4 0V3" /></>),
  papelera: (<><path d="M2.5 4.5h11" /><path d="M6 4.5V3h4v1.5" /><path d="M4 4.5l.7 9h6.6l.7-9" /></>),
  candado: (<><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.3" /><path d="M5.5 7.2V5.2a2.5 2.5 0 0 1 5 0v2" /></>),
  candadoAbierto: (<><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.3" /><path d="M5.5 7.2V5.2a2.5 2.5 0 0 1 4.9-.7" /></>),
  calendario: (<><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /><path d="M5 9h1.5M9.5 9H11M5 11.5h1.5" /></>),
  historial: (<><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" /><path d="M2.4 2.6v2.8h2.8" /><path d="M8 5.2v3l2.1 1.3" /></>),
  play: <path d="M5 3.2v9.6L12.8 8z" fill="currentColor" />,
  pausa: (<><path d="M5.5 3.5v9" /><path d="M10.5 3.5v9" /></>),
  avanzar: (<><path d="M3.5 3.5v9L10 8z" fill="currentColor" /><path d="M12.5 3.5v9" /></>),
  replay: (<><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" /><path d="M2.4 2.6v2.8h2.8" /><path d="M7 5.6v4.8L10.6 8z" fill="currentColor" /></>),
  visible: (<><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>),
  oculto: (<><path d="M2.5 2.5l11 11" /><path d="M6.4 3.7A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4" /><path d="M10.1 11.9A6 6 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11.2 11.2 0 0 1 2.4-2.9" /></>),
};

export default function Icon({ name, size = 14, className = "" }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

