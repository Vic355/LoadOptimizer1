// Engine data types. All lengths are in centimetres, weights in kilograms.
// Axes: x runs along the truck length from the cab (x = 0) to the door,
// y runs across the width, z runs up from the floor.
import type { ModelRules } from './rules';

export type ModelId = 'free' | 'standard' | 'mixed';

export interface EngineSku {
  id: number;
  code: string;
  name: string;
  /** Planning size: measured outer size plus the SKU's size modifier. */
  length: number;
  width: number;
  height: number;
  weight: number;
  /** Most cartons a stack may hold, counted from the floor (Infinity when unlimited). */
  safeLayers: number;
  /** When false the carton stays upright unless a model's rotation rule allows any direction. */
  canLieDown: boolean;
  /** Product group, used to prefer like-for-like fillers in Standar. */
  group: string;
}

export interface EngineLine {
  sku: EngineSku;
  /** Requested quantity in packs; null means "fill as many as fit". */
  qty: number | null;
}

export interface EngineTruck {
  length: number;
  width: number;
  height: number;
}

export interface PlanRequest {
  truck: EngineTruck;
  lines: EngineLine[];
  rules: ModelRules;
  /** Overrides rules.searchSeconds (used by tests). */
  timeBudgetMs?: number;
  /** Segment depth used to group open-space Bebas loads into pseudo-tiers. */
  freeSegmentDepth?: number;
  seed?: number;
}

export interface PlacedBox {
  skuId: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  tier: number;
}

export interface Tier {
  /** 1-based tier number counted from the cab. */
  index: number;
  x0: number;
  depth: number;
  counts: Record<number, number>;
  total: number;
  /** Columns in the bottom layer and number of layers of the tier's main SKU. */
  columns?: number;
  layers?: number;
  /** Alternate layers are offset so joints do not line up. */
  interlocked?: boolean;
  /** True when the tier holds a single SKU. */
  uniform: boolean;
}

export interface PlanResult {
  model: ModelId;
  rules: ModelRules;
  boxes: PlacedBox[];
  tiers: Tier[];
  loaded: Record<number, number>;
  unplaced: Record<number, number>;
  totalCartons: number;
  loadedVolume: number;
  volumeUtilization: number;
  usedLength: number;
  totalWeight: number;
  plansEvaluated: number;
  elapsedMs: number;
  /** True when tiers are pseudo-tiers (fixed-depth segments) rather than real walls. */
  segmentTiers: boolean;
}

export interface SearchProgress {
  evaluated: number;
  bestCartons: number;
  /** 0..1 share of the time budget used. */
  fraction: number;
}
