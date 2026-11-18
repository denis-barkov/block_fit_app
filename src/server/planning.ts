import distance from '@turf/distance';
import { categories } from '../../config/settings';
import { costKeys, upfrontKeys, type Candidate, type Coordinate, type Costs, type Scenario } from '../contracts';

export type DemandOrigin = Coordinate & { id: string; synthetic: boolean };
const levels = ['low', 'base', 'high'] as const;
type Level = typeof levels[number];

export function metres(a: Coordinate, b: Coordinate) {
  return distance([a.lng,a.lat], [b.lng,b.lat], { units: 'meters' });
}
function sum(values: (number | null)[]) {
  return values.includes(null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
export function calculateCosts(costs: Costs, horizon: number, level: Level) {
  const amounts = Object.fromEntries(costKeys.map(key => [key, costs[key]?.[level] ?? null])) as Record<typeof costKeys[number], number | null>;
  const upfront = sum(upfrontKeys.map(key => amounts[key]));
  const events = costs.replacementPlan === 'none' ? 0
    : costs.replacementPlan === 'scheduled' && costs.interval !== null ? Math.ceil(horizon / costs.interval) - 1 : null;
  const maintenance = amounts.maintenance === null ? null : amounts.maintenance * horizon;
  const replacement = events === 0 ? 0 : events === null || amounts.replacement === null ? null : amounts.replacement * events;
  return { ...amounts, upfront, events, maintenanceTotal: maintenance, replacementTotal: replacement,
    lifecycle: sum([upfront, maintenance, replacement]) };
}

export function compare(scenario: Scenario, demand: DemandOrigin[], existing: Coordinate[], candidates: Candidate[]) {
  const requesters = [...new Map(demand.map(origin => [origin.id, origin])).values()];
  // Conservative bounding box for this pilot before doing spherical distance work.
  const latDelta = scenario.radius / 110_000;
  const lngDelta = scenario.radius / 80_000;
  const within = (a: Coordinate,b: Coordinate) =>
    Math.abs(a.lat-b.lat)<=latDelta && Math.abs(a.lng-b.lng)<=lngDelta && metres(a,b)<=scenario.radius;
  const unmet = requesters.filter(origin => !existing.some(pin => within(origin,pin)));
  const coverage = new Map(candidates.map(site => [site.id, unmet.filter(origin => within(origin,site)).map(origin => origin.id)]));
  const calculateOption = (sites: Candidate[]) => {
    const count = new Set(sites.flatMap(site => coverage.get(site.id) ?? [])).size;
    const estimates = Object.fromEntries(levels.map(level => {
      const costs = sites.map(site => calculateCosts(site.costs,scenario.horizon,level));
      const upfront = sum(costs.map(cost => cost.upfront));
      const lifecycle = sum(costs.map(cost => cost.lifecycle));
      return [level, { upfront, lifecycle, fits: upfront === null ? null : upfront <= scenario.budget,
        perRequester: count && lifecycle !== null ? lifecycle / count : null }];
    })) as Record<Level, { upfront: number | null; lifecycle: number | null; fits: boolean | null; perRequester: number | null }>;
    const feasibility = sites.some(site => site.feasibility === 'excluded') ? 'excluded'
      : sites.every(site => site.feasibility === 'suitable-for-comparison') ? 'suitable-for-comparison' : 'unreviewed';
    const missing = sites.flatMap(site => {
      const absent: string[] = [...upfrontKeys,'maintenance'].filter(key => site.costs[key as keyof Costs] === null);
      if (site.costs.replacementPlan === 'unknown') absent.push('replacement plan');
      if (site.costs.replacementPlan === 'scheduled' && site.costs.interval === null) absent.push('replacement interval');
      if (site.costs.replacementPlan === 'scheduled' && site.costs.interval !== null &&
          site.costs.interval < scenario.horizon && site.costs.replacement === null) absent.push('replacement cost');
      return absent.map(key => ({ site: site.id, key }));
    });
    return { ids: sites.map(site => site.id), count, estimates, feasibility, missing };
  };
  const selected = scenario.selected.map(id => candidates.find(site => site.id === id));
  if (selected.some(site => !site || site.feasibility === 'excluded')) return null;
  const options = [...candidates.map(site => calculateOption([site])),
    ...(selected.length > 1 ? [calculateOption(selected as Candidate[])] : [])];
  const qualified = options.filter(option => option.feasibility === 'suitable-for-comparison' &&
    option.estimates.base.fits && option.estimates.base.perRequester !== null);
  // Compare integer products to preserve ties without rounding cost per requester.
  type Option = typeof options[number];
  const relativeCost = (left: Option, right: Option) =>
    BigInt(left.estimates.base.lifecycle ?? 0)*BigInt(right.count) -
    BigInt(right.estimates.base.lifecycle ?? 0)*BigInt(left.count);
  const best = qualified.reduce<Option | undefined>((lowest,option) =>
    !lowest || relativeCost(option,lowest)<0n ? option : lowest,undefined);
  const highlighted = best ? qualified.filter(option=>relativeCost(option,best)===0n)
    .map(option=>option.ids.join(',')) : [];
  return { options, demandCount: requesters.length, unmet: unmet.length, highlighted };
}

export type Comparison = NonNullable<ReturnType<typeof compare>> & {
  scenario: Scenario; revision: number; calculatedAt: string; sites: Candidate[]; origins: (Coordinate & {synthetic: boolean})[];
  existing: Coordinate[]; inventorySources: string[];
};

export const interpretation = 'Recorded participation does not measure population need or verify unique people. Unknown inventory may overstate unmet demand. This comparison does not establish realized savings, land availability, or installation approval.';
const clean = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}\[\]()#+.!|<>~]/g, '\\$&');
const money = (cents: number | null) => cents === null ? 'N/A' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(cents/100);
export function makeBrief(result: Comparison, explanation?: import('../contracts').Explanation) {
  const { scenario } = result;
  const lines = [
    '# BlockFit NYC investment comparison', '',
    `Equipment: ${categories[scenario.category]} | Revision: ${result.revision} | Calculated: ${result.calculatedAt}`,
    `Radius: ${scenario.radius} m straight-line approximation | Horizon: ${scenario.horizon} years | Upfront budget: ${money(scenario.budget)}`,
    `Recorded demand: ${result.demandCount} | Unmet before installation: ${result.unmet}`, '',
    'Baseline uses currently listed, verified, usable equipment with confirmed public access.',
    ...result.inventorySources.map(source => `- Inventory source: ${clean(source)}`),
    'Costs are illustrative scenarios in undiscounted constant dollars. Replacement events at horizon end are excluded.',
    interpretation, '',
  ];
  for (const option of result.options) {
    const sites = result.sites.filter(site => option.ids.includes(site.id));
    lines.push(`## ${sites.map(site => clean(site.name)).join(' + ')}`, '',
      `Feasibility: ${option.feasibility} | Unique newly covered requesters: ${option.count}`);
    if (result.highlighted.includes(option.ids.join(','))) lines.push('Lowest modeled cost per newly covered requester.');
    for (const level of levels) {
      const estimate = option.estimates[level];
      lines.push(`- ${level}: upfront ${money(estimate.upfront)} (${estimate.fits === null ? 'unknown fit' : estimate.fits ? 'inside budget' : 'over budget'}), lifecycle ${money(estimate.lifecycle)}, per requester ${money(estimate.perRequester)}`);
    }
    for (const site of sites) {
      lines.push(`- ${clean(site.name)} source: ${clean(site.costs.source || 'Unknown')}`,
        `  - ${costKeys.map(key => `${key} low/base/high ${levels.map(level => money(site.costs[key]?.[level] ?? null)).join(' / ')}`).join('; ')}`,
        `  - Replacement plan: ${site.costs.replacementPlan} | Interval: ${site.costs.interval ?? 'N/A'} years`);
      if (site.notes) lines.push(`  - Notes: ${clean(site.notes)}`);
      if (site.projectUrl) lines.push(`  - [Public project reference](<${encodeURI(site.projectUrl).replace(/[<>]/g, encodeURIComponent)}>)`);
    }
    if (option.missing.length) lines.push(`- Missing inputs: ${[...new Set(option.missing.map(entry => entry.key))].join(', ')}`);
    lines.push('');
  }
  if (explanation) {
    lines.push('## AI explanation', '', ...Object.values(explanation).map(value => `- ${clean(value)}`));
  }
  return lines.join('\n') + '\n';
}
