/// <reference lib="webworker" />
// Runs one packing model off the main thread; the planner starts one worker per model.
import { runModel, type ModelId, type PlanRequest, type PlanResult, type SearchProgress } from './index';

export type WorkerRequest = { model: ModelId; req: PlanRequest };
export type WorkerResponse =
  | { type: 'progress'; model: ModelId; progress: SearchProgress }
  | { type: 'result'; result: PlanResult }
  | { type: 'error'; model: ModelId; message: string };

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { model, req } = ev.data;
  try {
    const result = runModel(model, req, (progress) => post({ type: 'progress', model, progress }));
    post({ type: 'result', result });
  } catch (err) {
    post({ type: 'error', model, message: String(err) });
  }
};
