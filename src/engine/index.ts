import type { ModelId } from './types';

export * from './types';
export { runModel } from './models';
export { DEFAULT_RULES, withDefaults, type ModelRules } from './rules';

/** Display order of the three models, side by side. */
export const MODEL_ORDER: ModelId[] = ['free', 'standard', 'mixed'];
