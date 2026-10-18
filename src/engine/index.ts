import type { ModelId, PlanRequest, PlanResult } from './types';
import { runStandard } from './standard';
import { runFree, runMixed } from './models';

export * from './types';

export const MODEL_ORDER: ModelId[] = ['free', 'standard', 'mixed'];

export function runModel(model: ModelId, req: PlanRequest): PlanResult {
  switch (model) {
    case 'free':
      return runFree(req);
    case 'standard':
      return runStandard(req);
    case 'mixed':
      return runMixed(req);
  }
}
