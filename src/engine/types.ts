// Engine data types. All lengths are in centimetres, weights in kilograms.
// Axes: x runs along the truck length from the cab (x = 0) to the door,
// y runs across the width, z runs up from the floor.

export type ModelId = 'free' | 'standard' | 'mixed';

export type Packaging = 'carton' | 'bale';

export interface EngineSku {
  id: number;
  code: string;
  name: string;
  length: number;
  width: number;
  height: number;
  weight: number;
  /** Maximum height from the floor that a stack containing this SKU may reach. */
  safeStackHeight: number;
  /** When false the carton must stay upright (only rotated around the vertical axis). */
  canLieDown: boolean;
  /** Plastic-wrapped bales cannot carry cartons on top of them. */
  packaging: Packaging;
}

export interface EngineLine {
  sku: EngineSku;
  /** Requested quantity; null means "fill as many as fit". */
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
  /** Time budget for the search-based models, in milliseconds. */
  timeBudgetMs?: number;
  /** Segment depth used to group boxes into pseudo-tiers for the free model. */
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
  /** Grid size for uniform tiers (standard model); absent for mixed tiers. */
  columns?: number;
  layers?: number;
  /** True when the tier is a full grid of a single SKU. */
  uniform: boolean;
}

export interface PlanResult {
  model: ModelId;
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
