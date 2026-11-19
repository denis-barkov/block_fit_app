import distance from '@turf/distance';
import type { Coordinate } from './contracts';

export function metres(a: Coordinate, b: Coordinate) {
  return distance([a.lng,a.lat],[b.lng,b.lat],{units:'meters'});
}
