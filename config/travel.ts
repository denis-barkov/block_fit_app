const metresPerMile = 1609.344;

export const travel = {
  metresPerMile,
  bands: [
    {limit:0.25 * metresPerMile,label:'Nearby'},
    {limit:0.5 * metresPerMile,label:'A little farther'},
    {limit:metresPerMile,label:'Farther away'},
  ],
  fartherLabel:'Consider transportation',
  pool:6, shortlist:3, pageSize:100, visiblePageSize:24,
  map: {
    source:'openmaptiles', layer:'poi', zoom:14, radius:800, perMode:3,
    timeoutMs:8000, coordinateDecimals:5, nameLength:80, maxFeatures:1024, featureIdLength:32,
  },
  ai: { cooldownMs:15_000, daily:10, cacheMs:86_400_000, requestsPerWindow:30, shortlistWords:35, focusedWords:90 },
};
