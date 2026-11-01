# Revisión técnica — 30 de octubre de 2026

Se revisaron el recorrido de los datos hasta el gráfico, los indicadores, las
temporalidades, el replay, las conexiones, los dibujos, la operativa y la interfaz
de escritorio y móvil. La base inicial aprobaba 123 pruebas, pero no cubría varios
de los fallos corregidos a continuación.

## Problemas corregidos

| Área | Problema encontrado | Resultado |
|---|---|---|
| Historial y replay | OHLC redondeado a dos decimales y volumen a enteros | Se conserva la precisión de la fuente. |
| Varios gráficos | Un mercado podía cambiar la precisión de los demás | Precisión por instancia; MT5 conserva sus dígitos oficiales. |
| Precios pequeños | La notación científica podía terminar en dos decimales | Se representan valores como `0,00000001`; los valores no finitos aparecen vacíos. |
| Datos en vivo | Mensajes atrasados podían hacer retroceder el cierre o reabrir una vela | Se comprueban tiempos y se conservan datos recibidos durante la resincronización. |
| Fuente e historial | Cambiar entre Yahoo y MT5 o corregir historia podía dejar un gráfico mezclado | El servidor detecta la revisión y envía una foto completa. |
| Reconexión | REST podía reemplazar datos más recientes; una petición fallida al salir del replay podía congelar el gráfico | Se descartan respuestas antiguas, se exige snapshot y se reintenta su recuperación. |
| Velas cerradas | Algunas correcciones no llegaban al gráfico | Se actualizan velas e indicadores históricos existentes. |
| Horarios | El desfase actual se aplicaba también al historial de otra estación | Los datos permanecen en UTC y las etiquetas usan la fecha histórica, incluidos cambios DST. |
| Temporalidades | `2d` y `2w` podían cambiar sus grupos al rotar el buffer | Periodos UTC estables, compartidos con el replay. |
| Replay | Temporalidades personalizadas podían avanzar o cerrarse incorrectamente | Agregación común; velas parciales sin datos posteriores al cursor; aviso explícito para mensual. |
| Dibujos | Medir o arrastrar atravesando un fin de semana contaba velas inexistentes | Se usan índices de vela para anchura y tiempo real para duración. |
| Fluidez | Repintados idénticos, recálculos repetidos y desplazamiento por cada tick | Actualizaciones incrementales, caché de indicadores y menos trabajo por cuadro. |
| Vista e historial cargado | Una resincronización podía reiniciar el zoom o borrar las velas ya cargadas | Se ancla la región por tiempo; con la misma fuente se conserva la historia y se recalculan sus indicadores. |
| Recursos | Algunas animaciones y listeners sobrevivían al gráfico | Limpieza al desmontar y cancelación de trabajos pendientes. |
| Operativa | Pasos de volumen como `0,25` se redondeaban mal | Se respeta el paso del instrumento. |
| Validación | Números negativos o inválidos podían convertirse en cierre total o eliminación de protección | Rechazo antes de ejecutar esas acciones. |
| Cuenta MT5 | Una cuenta configurada ausente podía sustituirse por otra | Se exige la cuenta elegida. |
| Ejecución MQL5 | Un parcial que superara el volumen restante podía terminar en cierre total | El Operador vuelve a validar volumen, paso y remanente antes de ejecutar. |
| Precisión del puente | Volúmenes y pasos se exportaban con cuatro decimales | Se conservan hasta ocho decimales en Bridge y respuestas del Operador. |
| Ejecutor antiguo | Un tipo desconocido podía interpretarse como venta; admitía comandos sin vencimiento | Trader rechaza tipos desconocidos y vencimientos ausentes o inválidos. |
| Binance | Fallos consultando órdenes podían parecer ausencia de SL; fallar el SL obligatorio podía informarse como éxito | Los fallos conservan su significado y la protección incompleta se identifica expresamente. |
| Reenvíos | Doble clic y respuestas inciertas favorecían pedidos repetidos | Exclusión de peticiones concurrentes y revisión explícita antes de otra apertura incierta. |
| Acceso | Snapshot y WebSocket incluían cuentas sin validar el origen | Se comprueban Host y Origin; se conservan desarrollo local y acceso remoto configurado. |
| Clientes lentos | El WebSocket podía acumular una cola de datos | Límite de cola, recuperación con snapshot y desconexión de clientes estancados. |
| Interfaz | Datos de otra vista durante cargas, buscador demasiado ancho y leyendas extensas en la grilla | Cargas explícitas, buscador móvil y leyendas compactas. |
| Estado de datos | Una cotización antigua se podía presentar como mercado cerrado | Se distingue falta de datos recientes del horario real del broker; Yahoo y USDT.D se identifican como retrasado y estimado. |

## Verificación reproducible

Resultado final: **195 pruebas aprobadas**, revisión de tipos y build correctos,
prueba de navegador aprobada y **cuatro fuentes MQL5 compiladas con cero errores
y cero advertencias**: Bridge, Operador, Trader y SesionesIFVG. Los registros del
compilador quedan en `.revision/*.compile.log`; los `.ex5` se generaron en la
carpeta `mt5/` del proyecto.

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:ui
node test/marketData.bench.ts
```

`test:ui` utiliza Chromium o Edge y un servidor local con datos sintéticos: 1500
velas por gráfico, seis mercados con distinta precisión, zoom con rueda,
interrupción y recuperación del WebSocket, buscador, cambio a móvil y bloqueo de
reenvío. No necesita credenciales. `CHROME_PATH` permite elegir el ejecutable.

Las capturas y las mediciones se guardan en `.revision/`: `escritorio.png`,
`seis-graficos.png`, `movil.png`, `apaisado.png` y `ui-resultados.json`.
El perfil de navegador y estos resultados locales quedan excluidos de Git.

El benchmark del backend compara el mismo cálculo con y sin reutilización entre
clientes. Con seis clientes de una misma vista se observó una reducción aproximada
de cinco a seis veces en el trabajo de indicadores. Esa medición no representa
los cuadros por segundo del navegador.

Última medición local, con cambios de precio y uso de la rueda, durante
aproximadamente dos segundos por escenario:

| Gráficos | Paquetes/s por gráfico | Cuadros | Intervalo p95 | Pausa máxima |
|---|---:|---:|---:|---:|
| 1 | 2,5 | 120 | 16,8 ms | 33,3 ms |
| 6 | 2,5 | 109 | 16,8 ms | 199,9 ms |
| 6, estrés | 10 | 102 | 33,4 ms | 33,4 ms |

La interacción habitual se acerca a 60 cuadros/s, pero la pausa aislada de unos
200 ms muestra que todavía no hay fluidez uniforme en todos los cuadros. Los
valores varían entre ejecuciones y se conservan en `ui-resultados.json`.

## Semántica de las temporalidades

Las personalizadas `nD` agrupan bloques de `n × 86400` segundos desde
`1970-01-01 00:00 UTC`; `nW`/`nS`, bloques de semanas desde el lunes
`1970-01-05 00:00 UTC`. Son periodos de calendario, no cantidades de sesiones
negociadas. Los huecos no se rellenan y no desplazan el siguiente periodo. Ampliar
historia puede completar la primera vela parcialmente cargada.

El replay usa las semanas del broker cuando existen. Si necesita construirlas
desde diarias, indica expresamente la agrupación UTC. El mensual requiere historia
por calendario y muestra un aviso en lugar de presentar un resultado incorrecto.

## Límites de lo comprobado

- La validación de interfaz se ejecuta en Chromium, con datos sintéticos. No
  certifica rendimiento en cada equipo ni el comportamiento de Safari en un
  dispositivo físico.
- No se ejecutaron operaciones reales. MetaEditor comprobó compilación; el
  comportamiento del broker y las integraciones se verificaron con pruebas y
  respuestas simuladas. Los asesores compilados en el proyecto no se instalaron
  ni se recargaron en una cuenta activa durante esta revisión.
- Binance recibe apertura y SL en peticiones separadas. Si acepta la apertura y
  rechaza el stop, puede existir exposición sin protección. La respuesta ahora
  indica `proteccion_incompleta`, `ejecutada:true` y la orden afectada; la interfaz
  exige revisar posiciones antes de otra apertura. No se compensa cerrando a
  ciegas una posición previa.
- La exclusión de pedidos concurrentes no es idempotencia durable entre reinicios,
  varias pestañas o clientes independientes.
- El ejecutor antiguo Trader no recibe órdenes de la aplicación actual. Su
  registro de ejecución ocurre después de enviar al broker; si se usa por fuera
  de esta aplicación, un reinicio en ese intervalo todavía puede repetir una
  orden. La operativa actual utiliza CriptoTerminalOperador.
- Yahoo mantiene su retraso y sus limitaciones de actualización de volumen.
  USDT.D sigue siendo una reconstrucción aproximada de CoinGecko.
- El build conserva un aviso por el tamaño del paquete JavaScript principal.
  Separar pantallas en carga diferida puede mejorar el arranque; las mediciones
  de interacción se registran aparte en `ui-resultados.json`.

Las comprobaciones reducen errores conocidos y dejan regresiones reproducibles;
no garantizan ausencia absoluta de fallos o interrupciones de proveedores externos.
