// Categorical colours for SKUs (by position in the shipment order) and alternating tier colours.
const SKU_PALETTE = ['#2f6db5', '#d9822b', '#3a9a5b', '#c2453d', '#7d5bb5', '#1f9aa3', '#b5892f', '#c45c95', '#5f7d2f', '#4a5bd0', '#a8582c', '#2f8f7a'];
const TIER_PALETTE = ['#2f6db5', '#7fa8d8'];

export const skuColor = (index: number) => SKU_PALETTE[((index % SKU_PALETTE.length) + SKU_PALETTE.length) % SKU_PALETTE.length];
export const tierColor = (tier: number) => TIER_PALETTE[tier % 2];
