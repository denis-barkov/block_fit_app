import { categories, limits, pilot } from '../../config/settings';
import { scenarioInput, upfrontKeys } from '../contracts';
import { highlightExclusions, levels, ranking, type Comparison } from './planning';

const formatter = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0});
const money = (cents: number | null) => {
  if (cents === null) return null;
  if (!Number.isFinite(cents) || cents < 0 || cents > Number.MAX_SAFE_INTEGER) throw new Error('Invalid cost.');
  return formatter.format(cents/100);
};
const asCount = (count: number, max: number) => {
  if (!Number.isInteger(count) || count < 0 || count > max) throw new Error('Invalid count.');
  return count;
};
const dataKind = (synthetic: number, total: number) => total === 0 ? 'none'
  : synthetic === total ? 'synthetic' : synthetic > 0 ? 'mixed' : 'real';

export function comparisonSnapshot(result: Comparison) {
  const scenario = scenarioInput.parse(result.scenario);
  const siteNames = new Map(result.sites.map(({id,name}) => [id,name]));
  const optionId = (ids: string[]) => [...ids].sort().join(',');
  const highlightedOptionIds = result.highlighted.map(id => optionId(id.split(','))).sort();
  const demand = asCount(result.demandCount,limits.demand);
  const unmet = asCount(result.unmet,demand);
  const options = result.options.map(option => {
    const sites = [...option.ids].sort();
    const names = sites.map(id => {
      const name = siteNames.get(id);
      if (!name || name.length > limits.shortText || !id.length || id.length > 64 || id.includes(',')) {
        throw new Error('Invalid candidate label.');
      }
      return name;
    });
    const {base} = option.estimates;
    const count = asCount(option.count,unmet);
    const exclusions = highlightExclusions(option);
    return {
      id:optionId(sites), name:names.join(' + '), type:sites.length === 1 ? 'single site' : 'combination',
      ...(sites.length > 1 && {siteIds:sites}),
      newlyCovered:count,
      ...(sites.length > 1 && {overlap:asCount(option.overlap,count)}),
      upfront:levels.map(level => money(option.estimates[level].upfront)),
      lifecycle:levels.map(level => money(option.estimates[level].lifecycle)),
      fitsUpfrontBudget:levels.map(level => option.estimates[level].fits),
      baseLifecyclePerNewRequester:money(base.perRequester),
      ...(base.perRequester === null && {perRequesterUnavailable:count === 0 ? 'no additional coverage' : 'incomplete lifecycle cost'}),
      missing:[...new Set(option.missing.map(entry => entry.key))].sort(),
      feasibility:option.feasibility, sufficientCostData:base.lifecycle !== null,
      highlightEligible:exclusions.length === 0, highlightExclusions:exclusions,
    };
  }).sort((left,right) => left.id < right.id ? -1 : Number(left.id !== right.id));

  return {
    scenario:{
      category:categories[scenario.category], area:pilot.name, radiusMetres:scenario.radius,
      distance:'straight-line approximation', horizonYears:scenario.horizon,
      upfrontBudgetMinorUnits:scenario.budget, upfrontBudget:money(scenario.budget),
      demandData:dataKind(result.origins.filter(origin => origin.synthetic).length,result.origins.length),
      inventoryData:dataKind(result.existing.filter(pin => pin.fixture).length,result.existing.length),
      candidateData:dataKind(result.sites.filter(site => site.fixture).length,result.sites.length),
    },
    demand:{
      eligibleUniqueActiveRequesters:demand, alreadyServed:demand-unmet, baselineUnmet:unmet,
      definition:'Recorded requesters for the category, deduplicated by requester. Baseline uses verified, usable public equipment for that category. Unknown inventory may overstate unmet demand.',
    },
    coverageDefinition:'Previously unserved requesters inside an option radius. Combinations count the union once, including overlap.',
    costs:{
      currency:'USD', internalUnit:'cents', rangeOrder:levels,
      upfrontIncludes:upfrontKeys, lifecycleIncludes:['upfront','annual maintenance over horizon','scheduled replacements before horizon end'],
      assumptions:'Illustrative, undiscounted constant dollars. Null costs indicate incomplete components. Fits compares upfront cost only.',
    },
    ranking:{
      highlightedOptionIds,
      rule:ranking,
      tied:highlightedOptionIds.length > 1,
      screening:'Excluded sites cannot join combinations. Unreviewed options are provisional. Screening does not establish authorization.',
    },
    options,
  };
}
