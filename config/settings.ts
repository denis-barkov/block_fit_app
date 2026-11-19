export const defaultCategory = 'pull-up';
export const feedback = { confirmationMs:10_000 };
export const catalogLimits = {nameMin:2,nameMax:80,description:500,reason:240,pending:5,daily:10,page:50,matches:5};
const demoNeighborhood = 'Forest Hills';
export const pilot = {
  neighborhood: demoNeighborhood,
  name: `${demoNeighborhood}, Queens`,
  center: { lat: 40.7202, lng: -73.8470 },
  demoOverview: { south: 40.712, north: 40.739, west: -73.879, east: -73.825 },
};
export const planning = {
  radius: 200, minRadius: 50, maxRadius: 1000, horizon: 10, maxHorizon: 50,
  budget: 2_000_000, maxBudget: 1_000_000_000_00, combination: 3,
};
export const limits = {
  inventory: 200, demand: 2000, text: 500, shortText: 100, bodyBytes: 24_000,
  minPassword: 15, maxPassword: 128,
};
export const ai = {
  inputTokens: 2000, outputTokens: 1000,
  cacheDays: 7, cacheEntries: 100, outputWords: 220, inputBytes: 12_000,
  cooldownMs:{staff:5_000,resident:5_000}, reservationMs:120_000, providerTimeoutMs:25_000,
};
// Keep staff payloads well below Luna's context and reserve room for structured replies.
export const staffComparisonAI = {
  explanation:{inputTokens:40_000,inputBytes:160_000,outputTokens:1_800,sectionChars:600,detailOptions:8},
  goal:{inputTokens:16_000,inputBytes:64_000,batchOptions:16,outputPerOption:200,outputOverhead:500,parallelBatches:4},
  sizeHeadroom:.85,
};
