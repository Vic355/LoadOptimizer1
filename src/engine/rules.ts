import type { ModelId } from './types';

/**
 * Optimizer rules that the admin can change on the Model rules page. Fixed for every model:
 * cartons stay inside the truck, never overlap, the bottom layer is filled across the width
 * first, and every carton is fully supported (interlock patterns may use interlockMinSupport).
 */
export interface ModelRules {
  /** Build one-carton-deep tiers across the full width, from the cab to the door. */
  tiers: boolean;
  /** Load lines in shipment order (fixed quantities first, then "fill max" lines). */
  lineOrder: boolean;
  /** Offset alternate layers of a tier so joints do not line up. */
  interlock: boolean;
  /** Lowest share of a carton's base that must rest on cartons below in an interlock pattern. */
  interlockMinSupport: number;
  /** Other SKUs in a tier: none, only to fill a tier (same product group first), or freely. */
  mixing: 'none' | 'fill' | 'free';
  /** upright: turn around the vertical axis only; sku: follow each SKU's "may lie on side"; any: every direction. */
  rotation: 'upright' | 'sku' | 'any';
  respectSafeStack: boolean;
  /** Prefer heavier SKUs at the bottom and lighter ones on top. */
  heavyBottom: boolean;
  /** Widest empty space (cm) a tier pattern may leave beside or behind a carton; 0 means no limit. */
  maxGapCm: number;
  /** Rank plans by the stability check first and carton count second. */
  safetyFirst: boolean;
  /** Search time for this model. */
  searchSeconds: number;
}

export const DEFAULT_RULES: Record<ModelId, ModelRules> = {
  free: {
    tiers: false,
    lineOrder: false,
    interlock: false,
    interlockMinSupport: 0.6,
    mixing: 'free',
    rotation: 'any',
    respectSafeStack: false,
    heavyBottom: true,
    maxGapCm: 0,
    safetyFirst: false,
    searchSeconds: 3,
  },
  standard: {
    tiers: true,
    lineOrder: true,
    interlock: true,
    interlockMinSupport: 0.6,
    mixing: 'fill',
    rotation: 'sku',
    respectSafeStack: true,
    heavyBottom: true,
    maxGapCm: 10,
    safetyFirst: true,
    searchSeconds: 2,
  },
  mixed: {
    tiers: true,
    lineOrder: true,
    interlock: true,
    interlockMinSupport: 0.6,
    mixing: 'free',
    rotation: 'sku',
    respectSafeStack: true,
    heavyBottom: true,
    maxGapCm: 10,
    safetyFirst: false,
    searchSeconds: 3,
  },
};

/** Fills in fields missing from rules saved by an older version. */
export function withDefaults(model: ModelId, rules: Partial<ModelRules> | null | undefined): ModelRules {
  return { ...DEFAULT_RULES[model], ...(rules ?? {}) };
}
