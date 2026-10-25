import { AnomalyBenchmark } from "../../src/anomaly-guard";
self.onmessage = (event: MessageEvent<{threshold: number}>) => {
  try { self.postMessage({ metrics: new AnomalyBenchmark().run(event.data.threshold) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
