import type { ModelId } from './types';

/**
 * Forces and material values for the stability check, in units of g (gravity). The defaults are
 * the road-transport values of EN 12195-1; raise them to plan for rougher roads or driving.
 */
export interface PhysicsRules {
  /** Push towards the cab when braking. */
  brakeG: number;
  /** Push towards the door when speeding up. */
  accelG: number;
  /** Push sideways in curves and lane changes. */
  sideG: number;
  /** Upward jolt from bumps; it makes cartons lighter for a moment, so they slide and tip more easily. */
  bumpG: number;
  /** Friction between cartons (0.4 to 0.6 for cardboard). A carton slides when the push exceeds friction. */
  friction: number;
  /** Free room (cm) a carton may shift into before it counts as able to slide. */
  slideGapCm: number;
}

export const DEFAULT_PHYSICS: PhysicsRules = { brakeG: 0.8, accelG: 0.5, sideG: 0.5, bumpG: 0, friction: 0.4, slideGapCm: 10 };

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
  /** Where loading starts: tiers are built from the cab towards the door, or from the door towards the cab. */
  fillFrom: 'cab' | 'door';
  physics: PhysicsRules;
  /** Search time for this model. */
  searchSeconds: number;
}

export const DEFAULT_RULES: Record<ModelId, ModelRules> = {
  free: {
    // Bebas builds tiers too (one carton deep, across the width), so loaders get a count and a
    // picture per tier; rotation and mixing stay free.
    tiers: true,
    lineOrder: false,
    interlock: false,
    interlockMinSupport: 0.6,
    mixing: 'free',
    rotation: 'any',
    respectSafeStack: false,
    heavyBottom: true,
    maxGapCm: 0,
    safetyFirst: false,
    fillFrom: 'cab',
    physics: DEFAULT_PHYSICS,
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
    fillFrom: 'cab',
    physics: DEFAULT_PHYSICS,
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
    fillFrom: 'cab',
    physics: DEFAULT_PHYSICS,
    searchSeconds: 3,
  },
};

/** Fills in fields missing from rules saved by an older version. */
export function withDefaults(model: ModelId, rules: Partial<ModelRules> | null | undefined): ModelRules {
  const base = DEFAULT_RULES[model];
  return { ...base, ...(rules ?? {}), physics: { ...base.physics, ...(rules?.physics ?? {}) } };
}
