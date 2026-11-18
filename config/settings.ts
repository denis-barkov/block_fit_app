export const categories = {
  'pull-up': 'Pull-up bars', parallel: 'Parallel bars', 'sit-up': 'Sit-up benches',
} as const;
export const pilot = {
  name: 'Forest Hills, Queens',
  center: { lat: 40.7202, lng: -73.8470 },
  demoOverview: { south: 40.713, north: 40.729, west: -73.856, east: -73.839 },
  bounds: { south: 40.706, north: 40.733, west: -73.865, east: -73.828 },
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
  model: 'gpt-5.4-mini', daily: 150, inputTokens: 2000, outputTokens: 1000,
  cacheDays: 7, cacheEntries: 100, outputWords: 220, inputBytes: 12_000,
};
