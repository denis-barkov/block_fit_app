import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import brooklynAndQueens from './brooklyn-queens.geojson.json' with {type:'json'};

const serviceBoroughs = brooklynAndQueens.features.map(({properties}) => properties.BoroName);

export const mapArea = {
  name: new Intl.ListFormat('en-US',{type:'conjunction'}).format(serviceBoroughs),
  pinBoroughs: new Intl.ListFormat('en-US',{type:'disjunction'}).format(serviceBoroughs),
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  initialZoom: 14,
  overviewMaxZoom: 14.5,
  fitPadding: 28,
  loadTimeoutMs: 9000,
  // The camera includes all five boroughs and leaves room for wide desktop viewports.
  cityOverview: { south: 40.49, north: 40.92, west: -74.26, east: -73.69 },
  panBounds: { south: 40.37, north: 41.02, west: -74.55, east: -73.40 },
  serviceBoundary: brooklynAndQueens as FeatureCollection<Polygon | MultiPolygon>,
};

export const pinOutsideServiceArea = `Choose a pin in ${mapArea.name}.`;

export function isInServiceArea({lat,lng}: {lat:number;lng:number}) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    mapArea.serviceBoundary.features.some(feature=>booleanPointInPolygon([lng,lat],feature));
}
