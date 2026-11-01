# Puente MetaTrader 5 → Terminal Cripto

En Linux no existe la librería `MetaTrader5` de Python (es solo Windows), así que
el puente va al revés: **un EA dentro de MT5 escribe un JSON** y el terminal lo lee.

Es de **solo lectura**: el EA no manda órdenes, no modifica posiciones y no toca la
cuenta. Solo publica lo que ya está abierto: la cuenta, las posiciones, la
cotización de cada símbolo y, desde la v2, las **velas del broker** (la historia en
`MQL5\Files\cripto-terminal\velas\<símbolo>_<temporalidad>.json`, de M1 a MN1, y las
dos últimas velas de cada temporalidad dentro de `estado.json`, cada segundo).

## Instalación automática

`npm run dev` (o `npm start`) lo hace solo en Windows: copia el EA a
`MQL5\Experts\CriptoTerminal`, lo compila con MetaEditor si cambió, y si MT5 está
cerrado lo abre con el puente puesto en un gráfico de XAUUSD H1 (solo la primera
vez: después queda guardado en el perfil). Si MT5 ya estaba abierto con una versión
anterior del puente, el panel avisa: MT5 no recarga un EA recompilado mientras
corre, así que hay que reiniciarlo. `MT5_LANZAR=false` lo apaga.

## Instalación a mano

1. Abrí **MetaTrader 5** y entrá a tu cuenta.
2. `Herramientas → Editor MetaQuotes` (o F4). En el Navegador, `Expert Advisors`
   → **CriptoTerminalBridge.mq5** (ya está copiado ahí).
3. Abrilo y compilá con **F7**. Debe decir `0 errors, 0 warnings`.
4. Volvé al terminal, activá **AutoTrading** (Ctrl+E, el botón queda verde).
5. Arrastrá **CriptoTerminalBridge** desde el Navegador a cualquier gráfico y
   aceptá. En la esquina del gráfico queda la carita sonriente.

Listo. En la pestaña *Expertos* debería aparecer:

```
Bridge Terminal Cripto activo -> MQL5\Files\cripto-terminal\estado.json
```

## Parámetros del EA

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `InpArchivo` | `cripto-terminal\estado.json` | ruta dentro de `MQL5\Files` |
| `InpRefrescoMs` | `1000` | cada cuánto reescribe (mínimo 200 ms) |
| `InpSimbolos` | `BTCUSD,XAUUSD,XAGUSD,US30.cash,US100.cash,US500.cash` | símbolos a exportar; los que tengan posición se agregan solos |
| `InpVelasCarpeta` | `cripto-terminal\velas` | carpeta de la historia de velas, dentro de `MQL5\Files` |
| `InpVelasTF` | `M1,M5,M15,H1,H4,D1,W1,MN1` | temporalidades que se exportan |
| `InpVelasN` | `1000` | velas por archivo (como máximo: solo las que MT5 ya tiene, nunca le pide bajar años de historia) |
| `InpVelasCadaSeg` | `10` | cada cuánto revisa la historia; reescribe solo si hay una vela nueva |
| `InpHistorial` | `cripto-terminal\historial.json` | historial de la cuenta (v5), dentro de `MQL5\Files` |
| `InpHistorialDias` | `400` | días de historial que se exportan |

Desde la **v9** exporta también el **calendario económico de MT5** (el de MetaQuotes)
en `cripto-terminal\calendario.json`, cada 10 segundos y solo si cambió: de ayer a la
semana que viene, con el dato real, el estimado y el anterior de cada noticia. La
terminal lo usa para completar el dato real que el calendario de FTMO todavía no
publicó (en el calendario aparece con la marca *MT5*). Parámetros: `InpCalendario` y
`InpCalendarioSeg`.

Desde la **v5** el puente exporta también el **historial de la cuenta**: cada
entrada y cierre (con su motivo: SL, TP, a mano, stop out), comisiones, swap y
depósitos. Lo revisa cada 2 segundos y lo reescribe solo si hay algo nuevo. Con eso
la terminal arma el Historial, sus métricas y la cabina de riesgo de la cuenta de
fondeo. Sigue siendo de solo lectura: leer el historial no toca nada.

> Si ya tenías el EA compilado de antes, **recompilalo con F7**: esta versión
> publica además el **margen por lote** de cada símbolo (`OrderCalcMargin`, que
> solo calcula — no crea ni envía ninguna orden), y agrega XLMUSD y XRPUSD a la
> lista por defecto. Sin recompilar, el terminal estima el margen con
> `MT5_MARGIN_RATE_DEFAULT` del `.env` en lugar del dato real.

## Dónde lo busca el terminal

Autodetecta el `MQL5\Files\cripto-terminal\estado.json` en Windows
(`%APPDATA%\MetaQuotes\Terminal\<hash>\MQL5\Files`, expandiendo el hash de la
carpeta de datos) y en los prefijos de Wine más comunes. Si tu instalación está en
otro lado, ponelo en el `.env`:

```
MT5_STATE_FILE=/ruta/a/MQL5/Files/cripto-terminal/estado.json
MT5_SYMBOL_MAP=BTCUSDT:BTCUSD,ETHUSDT:ETHUSD,ADAUSDT:ADAUSD
MT5_MAX_AGE=15
MT5_TRADE_USD=1000
```

`MT5_SYMBOL_MAP` traduce el símbolo del terminal (Binance) al del bróker: FTMO
cotiza **ADAUSD**, no ADAUSDT.

`MT5_RISK_PCT` es el riesgo por operación en % del equity, para el **lotaje por
riesgo** del panel de zona: entrar en el centro de la zona con el stop del plan
arriesgando ese porcentaje. Además avisa si el **margen** deja poner ese lotaje —
en cripto FTMO el margen es el nocional completo aunque la cuenta diga
`leverage 30`, así que un stop muy cercano hace la operación imposible de poner
por margen, no por riesgo.

`MT5_TRADE_USD` es el tamaño fijo (no por riesgo) para el **volumen sugerido**
del panel de zona: cuántos lotes exponen ese monto en USD al precio actual. Con
el puente conectado usa el precio y el contrato reales de MT5; sin puente, cae a
`MT5_CONTRACT_SIZE` / `MT5_VOLUME_STEP` / `MT5_VOLUME_MIN` (especificación
estática sacada de MT5 → Market Watch → clic derecho → Especificación).

## Qué hace el terminal con eso

El panel **posición real** (tecla `p`) muestra la cuenta y cada posición del par
que estés mirando, y la cruza contra la zona de reincorporación:

- **riesgo real en dinero** desde la entrada al stop, y qué % del equity es;
- lo que MT5 muestra en la línea del S/L es la distancia **desde el precio actual**
  — acá aparecen los dos números por separado, para que no se confundan;
- si la entrada quedó **dentro de la zona** o si persiguió el impulso, y cuánto;
- si el stop cae **dentro del retroceso esperado** (donde el propio plan dice que
  el precio va a ir) o más allá de la zona;
- el R/R real contra el R/R del plan;
- **el mismo riesgo bien puesto**: cuántos lotes serían entrando en el centro de la
  zona con el stop del plan, arriesgando exactamente lo mismo;
- si la posición está dimensionada **lejos del `MT5_RISK_PCT`** que decidiste antes
  de entrar, y el **margen y nocional** que inmoviliza;
- si el **stop ya quedó en ganancia** (del lado bueno de la entrada): eso no es
  riesgo, es ganancia asegurada, y no suma al riesgo abierto de la cuenta;
- **cuánto cuesta sostenerla**: swap por día y a 30 días, sacado del swap
  realmente cobrado y los días que lleva abierta. En swing es lo que más pesa —
  corre todos los días y escala con el nocional, no con el riesgo.

Sin el EA corriendo el panel dice `SIN PUENTE` y el resto del terminal funciona
igual: la operación real es un extra, no una dependencia.

## Estado manual (sin MT5 abierto)

El lector acepta cualquier archivo con ese formato. Si escribís uno a mano con
`"source": "manual"`, el panel lo muestra con el rótulo **MANUAL · foto manual, no
en vivo**, y el EA lo reemplaza en cuanto arranque.


---

# EA operador: CriptoTerminalOperador

**Este sí opera**: ejecuta las órdenes de la pestaña **Operar** del terminal (abrir a
mercado o límite con SL y TP, cerrar total o parcial, modificar SL/TP, cancelar
pendientes). Funciona en cuentas reales, también FTMO. Cada orden la confirma una
persona en el panel y el EA la valida de nuevo antes de mandarla.

## Instalación

1. `npm run dev` lo copia a `MQL5\Experts\CriptoTerminal` y lo compila (no lo pone
   en ningún gráfico).
2. En MT5, arrastrá **CriptoTerminalOperador** a cualquier gráfico.
3. En *Parámetros de entrada*: **InpCuenta** = tu login. En 0 no opera nada.
4. Tildá *Permitir trading algorítmico* y activá **Algo Trading** en la barra.
5. En la pestaña *Expertos* debe decir `Operador Terminal Cripto activo · habilitado`.

MT5 lo guarda en el perfil: queda puesto para la próxima vez.

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `InpCuenta` | `0` | login habilitado; en 0 rechaza todo |
| `InpLoteMax` | `5.0` | volumen máximo por orden |
| `InpSlObligatorio` | `true` | no abre (ni deja quitar) sin stop loss |
| `InpVencimientoSeg` | `15` | una orden más vieja se descarta |
| `InpDesvioPuntos` | `50` | deslizamiento permitido a mercado |
| `InpMagic` | `770100` | marca de lo que se abre desde el terminal |

Protocolo, dentro de `MQL5\Files\cripto-terminal\operador`: el terminal escribe
`entrada\<id>.txt` (una `clave=valor` por línea), el EA la toma (moviéndola, así un
segundo operador no podría tomarla también), la valida, la ejecuta y deja
`salida\<id>.json` con el resultado. `estado.json` dice cada segundo si está vivo y
habilitado, y `hechas.txt` recuerda los ids ya ejecutados.

---

# EA ejecutor viejo: CriptoTerminalTrader

> Reemplazado por **CriptoTerminalOperador**. Era el ejecutor automático del plan
> (que ya no existe): el terminal no le escribe más órdenes.



**Este sí opera.** Es un archivo aparte del puente a propósito: `CriptoTerminalBridge`
sigue sin una sola función que pueda mandar una orden, y tú eliges cuál corres.

Lee `MQL5\Files\cripto-terminal\ordenes.txt` —que escribe el terminal— y ejecuta
lo que ahí se pide. Pero **valida todo de nuevo antes de mandar nada**: si el
proceso que escribe el archivo se cuelga, escribe mal o queda viejo, el EA se
niega solo.

## Guardas, en orden de importancia

| | |
|---|---|
| `InpSoloDemo` | **true por defecto**: si la cuenta no es DEMO, no opera. Es la protección contra correrlo por error en la real |
| `InpCuenta` | login habilitado. En **0 rechaza todo** — hay que ponerlo a mano |
| S/L obligatorio | una orden sin stop se rechaza; sin él no hay riesgo acotado |
| `InpRiesgoMaxPct` | el riesgo se **recalcula en el EA**, no se cree el del archivo. Si difieren más de 30 %, rechaza |
| `InpLoteMax` | tope de lote por orden |
| `InpPosicionesMax` | posiciones simultáneas de este EA (cuenta por `InpMagic`, no toca las tuyas) |
| vencimiento | una orden vieja se descarta: si el terminal se cuelga, no quedan órdenes zombi |
| idempotencia | cada `id` se ejecuta una sola vez, y se recuerda **entre reinicios** |

## Instalación

1. `F4` → compilá **CriptoTerminalTrader.mq5** con `F7`.
2. Arrastralo a un gráfico. Acá **sí** hay que tildar *Permitir comercio
   algorítmico* — es lo que el EA necesita para operar.
3. En *Parámetros de entrada*, poné `InpCuenta` con el login de la demo. Si lo
   dejás en 0 no hace nada, por diseño.
4. La pestaña **Expertos** dice si quedó activo:
   `Trader: ACTIVO en la cuenta <login> (DEMO)` o `Trader: INACTIVO -> <motivo>`.

## Del lado del terminal

En el `.env`:

```
TRADING_ACTIVO=true
TRADING_CUENTA=<login de la demo>
TRADING_RIESGO_PCT=0.5        # por operación
TRADING_RIESGO_TOTAL_PCT=1.5  # agregado
TRADING_MAX_POSICIONES=3
RIESGO_MAX_DEL_AIRE=25        # % del aire restante que puede gastar una operación
```

`TRADING_ACTIVO=false` deja todo en modo observación: detecta, anota, y no
escribe ninguna orden.

El tamaño sale del menor entre el riesgo objetivo y el aire que queda contra los
límites de la firma. Nunca se apuesta todo el margen restante: tocar un límite
termina la cuenta, no se recupera después.

## Sesiones (indicador)

`SesionesIFVG.mq5` dibuja las sesiones del mercado, como el indicador de sesiones
de TradingView: una caja por sesión, con su máximo y su mínimo, de los últimos 30
días. Las horas van en la hora de cada ciudad, con su horario de verano, y se
cambian en la configuración:

| Sesión | Horas (de su ciudad) |
|---|---|
| Sídney | 07:00–16:00 |
| Tokio | 09:00–18:00 |
| Londres | 08:00–17:00 |
| Nueva York | 09:30–16:00 (la bolsa) |

Se pasan a la hora del servidor: en FTMO el servidor va 7 horas delante de Nueva
York todo el año (`HorasServidorNY`), así que funciona también sin conexión. Solo dibuja;
no opera. Se instala en
`MQL5\Indicators\CriptoTerminal` y se arrastra al gráfico desde el Navegador
(sección Indicadores, no Asesores Expertos).
