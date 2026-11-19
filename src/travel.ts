import { travel } from '../config/travel';
import { isInServiceArea } from '../config/map-area';
import { metres } from './geo';
import type { Coordinate, PublicEquipment } from './contracts';

export const distanceNotice = 'Straight-line distance; the actual journey may be longer.';
export const mapNotice = 'Suggestions use mapped landmarks, not verified routes or live service. Confirm your journey in Maps.';

export const distanceBand = (metres: number) => travel.bands.find(band=>metres<=band.limit)?.label ?? travel.fartherLabel;
export const approxDistance = (metres: number) => new Intl.NumberFormat('en-US',{maximumFractionDigits:2})
  .format(metres/travel.metresPerMile)+' mi';

export function eligible(item: PublicEquipment) {
  return item.access==='public' && item.condition==='usable' && !!item.verifiedOn && isInServiceArea(item);
}

export function byDistance<T extends Coordinate & {id:string}>(items: T[], origin: Coordinate) {
  return items.map(site=>({site,distance:metres(origin,site)}))
    .sort((a,b)=>a.distance-b.distance || (a.site.id<b.site.id?-1:a.site.id>b.site.id?1:0));
}

export const landmarkModes = ['bus','rail'] as const;
export type LandmarkMode = typeof landmarkModes[number];
export type Landmark = Coordinate & {mode:LandmarkMode;name:string;featureId?:string};
export type Observations = Record<string,Landmark[]>;
export const originEndpoint = 'origin';

export function normalizeLandmarks(endpoint: Coordinate, points: Landmark[]) {
  const unique=new Map<string,Landmark>();
  for(const point of points) {
    const name=point.name.replace(/[\p{Cc}\p{Cf}]/gu,'').trim();
    if(!name || name.length>travel.map.nameLength || !landmarkModes.includes(point.mode) ||
      !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat)>90 ||
      Math.abs(point.lng)>180 || metres(endpoint,point)>travel.map.radius) continue;
    const lat=Number(point.lat.toFixed(travel.map.coordinateDecimals));
    const lng=Number(point.lng.toFixed(travel.map.coordinateDecimals));
    const {featureId}=point;
    const key=JSON.stringify([point.mode,...(featureId?[featureId]:[name,lat,lng])]);
    const normalized={name,mode:point.mode,lat,lng,...(featureId?{featureId}:{})};
    const previous=unique.get(key);
    if(!previous || JSON.stringify(normalized)<JSON.stringify(previous)) unique.set(key,normalized);
  }
  const sorted=byDistance([...unique].map(([id,point])=>({...point,id})),endpoint);
  return landmarkModes.flatMap(mode=>sorted.filter(({site})=>site.mode===mode)
    .slice(0,travel.map.perMode).map(({site:{id,...point}})=>point));
}

export const travelReasons = ['distance','equipment','comparison','mapped-rail','mapped-bus'] as const;
export type TravelReason = typeof travelReasons[number];
export type TravelSuggestion = {id:string;reason:TravelReason};
export type TravelResponse = {options:TravelSuggestion[];cached:boolean;evidence:'partial'|'unavailable'};

export const reasonText: Record<TravelReason,string> = {
  distance:'Compare this location using its straight-line distance from your pin.',
  equipment:'This listing matches your equipment search. Check the recorded condition and access details before deciding.',
  comparison:'Compare this option with the other matching locations and check directions in Maps.',
  'mapped-rail':'Rail landmarks are mapped near both pins. Transit may be worth checking in Maps.',
  'mapped-bus':'Bus landmarks are mapped near both pins. Transit may be worth checking in Maps.',
};
