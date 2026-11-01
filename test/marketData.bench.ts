// Benchmark local, sin red ni cuentas: node test/marketData.bench.ts
import { performance } from "node:perf_hooks";
import type { Candle } from "../src/binance.ts";
import { MarketHub } from "../src/market.ts";

for (const cantidad of [1500, 6000]) {
  for (const clientes of [1, 6]) {
    for (const cache of [false, true]) {
      const velas: Candle[] = Array.from({ length: cantidad }, (_, i) => {
        const t = 1_700_000_000 + i * 60, p = 100 + Math.sin(i / 7) * 2 + i * 0.01;
        return { t, t_ms: t * 1000, close_time: (t + 60) * 1000 - 1, o: p, h: p + 2, l: p - 2, c: p + 0.5, v: 10, vb: 5, trades: 10, closed: i < cantidad - 1 };
      });
      const hub = Object.assign(Object.create(MarketHub.prototype), { serie: () => velas, graficos: new Map() });
      for (let i = 0; i < 5; i++) hub.grafico("BTCUSDT", "1m", 2);
      const cuadros = 80, inicio = performance.now();
      for (let i = 0; i < cuadros; i++) {
        velas[velas.length - 1].c += 0.0001;  // un tick nuevo en cada cuadro
        for (let j = 0; j < clientes; j++) {
          if (!cache) hub.graficos.clear();
          hub.revisionVista("BTCUSDT", "1m");
          hub.grafico("BTCUSDT", "1m", 2);
        }
      }
      const ms = performance.now() - inicio;
      console.log(JSON.stringify({ velas: cantidad, clientes, cache, cuadros, total_ms: +ms.toFixed(2), ms_por_cuadro: +(ms / cuadros).toFixed(3) }));
    }
  }
}
