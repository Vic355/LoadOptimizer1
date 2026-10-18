/// <reference lib="webworker" />
// Runs the packing models off the main thread so the screen never freezes.
import { MODEL_ORDER, runModel, type PlanRequest, type PlanResult } from './index';

export type WorkerResponse = { type: 'result'; result: PlanResult } | { type: 'done' } | { type: 'error'; message: string };

self.onmessage = (ev: MessageEvent<PlanRequest>) => {
  try {
    for (const model of MODEL_ORDER) {
      const result = runModel(model, ev.data);
      (self as unknown as Worker).postMessage({ type: 'result', result } satisfies WorkerResponse);
    }
    (self as unknown as Worker).postMessage({ type: 'done' } satisfies WorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: String(err) } satisfies WorkerResponse);
  }
};
