// SAP carton data: "Material Description" texts such as "CCBOX;STD,PPSB,355L,215W,175H,K150/M150/".
// The three numbers before L, W and H are the carton's outer length, width and height in mm. The
// last part is the corrugated board grade: K = kraft liner and M = medium (the fluting paper), each
// in g/m² (so K150/M125 is a 150 gsm liner with a 125 gsm flute). It says how strong the board is,
// not the carton's volume or weight. Plain data only, so the seed, the migration and the import share it.

export type MaterialIssue =
  /** Dimensions with decimals (e.g. 466.5L): kept, but unusual for SAP carton data. */
  | 'decimal'
  /** Only a total grammage (e.g. "425", "550G", "550GSM") instead of liner and medium. */
  | 'gsm-only'
  /** Letters after the numbers (e.g. "150K/150M/"). */
  | 'reversed'
  /** A cut-off grade (e.g. "K275/M1", "K200/M", "K150/M15/M"). */
  | 'truncated'
  /** The liner has no K (e.g. "125/150M/1"). */
  | 'no-k'
  /** White kraft liner ("WK200/M150"): a valid grade, noted because it differs from the rest. */
  | 'white-kraft';

export interface MaterialInfo {
  length_cm: number;
  width_cm: number;
  height_cm: number;
  /** Carton code inside the text, e.g. "PPSB". */
  boxCode: string | null;
  /** Board grade as written, e.g. "K150/M150". */
  board: string | null;
  issues: MaterialIssue[];
}

// Each number starts after a separator, so the "1" of a carton code such as "LNL1,485L" is not read as part of it.
const DIMS = /(?:^|[,;])\s*(\d+(?:\.\d+)?)\s*L\s*,\s*(\d+(?:\.\d+)?)\s*W\s*,\s*(\d+(?:\.\d+)?)\s*H/i;
const mm = (s: string) => Number(s);

function boardIssues(board: string): MaterialIssue[] {
  const b = board.replace(/\/+$/, '').toUpperCase();
  if (/^\d+\s*(G|GSM)?$/.test(b)) return ['gsm-only'];
  if (/^\d+K\//.test(b)) return ['reversed'];
  if (/^WK\d+\/M\d+$/.test(b)) return ['white-kraft'];
  if (/^\d+\//.test(b)) return ['no-k'];
  const m = /^K(\d+)\/M(\d+)$/.exec(b);
  // Board papers are 100 gsm or more; a shorter number was cut off.
  if (m && Number(m[1]) >= 80 && Number(m[2]) >= 80) return [];
  return ['truncated'];
}

/** Reads the carton size (in cm) and board grade from a material description; null when there is no size. */
export function parseMaterialDescription(text: string): MaterialInfo | null {
  const m = DIMS.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const boxCode = before.split(/[,;]/).pop()?.trim() || null;
  const board = text.slice(m.index + m[0].length).replace(/^\s*,\s*/, '').trim() || null;
  const issues: MaterialIssue[] = [];
  if ([m[1], m[2], m[3]].some((s) => s.includes('.'))) issues.push('decimal');
  issues.push(...(board ? boardIssues(board) : (['truncated'] as MaterialIssue[])));
  return { length_cm: mm(m[1]) / 10, width_cm: mm(m[2]) / 10, height_cm: mm(m[3]) / 10, boxCode, board: board?.replace(/\/+$/, '') ?? null, issues };
}

/** Product group from the product name, used by Standar to fill a tier with like-for-like products. */
export function productGroup(name: string): string {
  const n = name.toLowerCase();
  if (/napkin|napki |luncheon|cocktail|coctail|dinner/.test(n)) return 'Napkin';
  if (/kitchen|towel|multifold|mfold|interfold|fold|hrt|medical roll/.test(n)) return 'Towel';
  if (/toilet|bathroom|jrt|srt|hbt|\bbr\b|roll/.test(n)) return 'Toilet';
  if (/hanky|handky/.test(n)) return 'Hanky';
  return 'Facial';
}

/**
 * Stack height used when a carton has no tested value: as many cartons as fit under a 250 cm roof,
 * i.e. no limit beyond the truck. Light tissue cartons are normally stacked to the roof; replace it
 * in Data Master where a SKU needs a lower limit.
 */
export const defaultSafeLayers = (heightCm: number) => Math.max(1, Math.floor(250 / heightCm));

/** One SAP row (SKU, description, carton number, material description) as SKU fields. */
export function skuFromSap(code: string, desc: string, cbox: string, material: string) {
  const info = parseMaterialDescription(material);
  if (!info) return null;
  const name = desc.replace(/\s+/g, ' ').trim();
  return {
    code: code.trim(),
    name,
    length_cm: info.length_cm,
    width_cm: info.width_cm,
    height_cm: info.height_cm,
    mod_length_cm: 0,
    mod_width_cm: 0,
    mod_height_cm: 0,
    weight_kg: null,
    safe_stack_layers: defaultSafeLayers(info.height_cm),
    max_top_load_kg: null,
    can_lie_down: 0,
    packaging: 'carton' as const,
    product_group: productGroup(name),
    active: 1,
    is_dummy: 0,
    cbox_code: cbox.trim() || null,
    board_grade: info.board,
    material_desc: material.trim(),
    issues: info.issues,
  };
}
