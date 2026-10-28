/// <reference lib="webworker" />
// Runs one packing model for a whole shipment off the main thread; the planner starts one worker per model.
import { runShipment, type ModelId, type SearchProgress, type ShipmentRequest, type ShipmentResult } from './index';

export type WorkerRequest = { model: ModelId; req: ShipmentRequest };
export type WorkerResponse =
  | { type: 'progress'; model: ModelId; progress: SearchProgress }
  | { type: 'result'; result: ShipmentResult }
  | { type: 'error'; model: ModelId; message: string };

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { model, req } = ev.data;
  try {
    const result = runShipment(model, req, (progress) => post({ type: 'progress', model, progress }));
    post({ type: 'result', result });
  } catch (err) {
    post({ type: 'error', model, message: String(err) });
  }
};
