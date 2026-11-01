# Sonidos de NinjaTrader

Copia aquí los `.wav` de NinjaTrader (en NinjaTrader 8 están en
`C:\Program Files\NinjaTrader 8\sounds`). Si NinjaTrader 8 está instalado en esta PC,
la terminal los toma de ahí sola y no hace falta copiarlos (en inglés; con
`SONIDOS_IDIOMA=es-ES` en el `.env`, la voz en castellano).

| Archivo | Cuándo suena |
|---|---|
| `OrderFilled.wav` | se ejecuta una orden (a mercado o una límite que se llena), o un cierre parcial |
| `StopFilled.wav` | toca el SL |
| `TargetFilled.wav` | toca el TP |
| `PositionClosed.wav` | se cierra a mano (NinjaTrader 8 no lo trae: suena `OrderFilled`) |
| `OrderPending.wav` | se pone una pendiente, o se mueve el SL o el TP |
| `OrderCanceled.wav` | se cancela una pendiente |

El que falte suena con el tono propio de la terminal. Estos archivos no van al repo.
