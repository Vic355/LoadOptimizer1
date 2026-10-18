import type { ModelRules } from '../engine';
import { t } from '../i18n/id';

/** Plain-language bullet list of one model's rules, shown in the details panel. */
export function describeRules(r: ModelRules): string[] {
  const d = t.describeRules;
  const out = [r.tiers ? d.tiersOn : d.tiersOff, r.lineOrder ? d.lineOrderOn : d.lineOrderOff];
  if (r.tiers || r.interlock) out.push(r.interlock ? d.interlockOn(Math.round(r.interlockMinSupport * 100)) : d.interlockOff);
  if (r.tiers) out.push(d.mixing[r.mixing]);
  out.push(d.rotation[r.rotation], r.respectSafeStack ? d.safeOn : d.safeOff);
  if (r.heavyBottom) out.push(d.heavyOn);
  if (r.tiers && r.maxGapCm > 0) out.push(d.gap(r.maxGapCm));
  if (r.safetyFirst) out.push(d.safetyOn);
  out.push(d.search(r.searchSeconds));
  return out;
}
