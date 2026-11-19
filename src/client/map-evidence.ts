import type { Map as MapInstance } from 'maplibre-gl';
import { travel } from '../../config/travel';
import { normalizeLandmarks, type Landmark, type Observations } from '../travel';
import type { Coordinate } from '../contracts';

export type Endpoints = Record<string,Coordinate>;
export type CollectEvidence = (points:Endpoints,signal:AbortSignal)=>Promise<Observations>;

export function mappedLandmark(feature: {geometry?:unknown;properties?:unknown;id?:string|number}): Landmark | undefined {
  const geometry=feature.geometry as {type?:string;coordinates?:unknown} | undefined;
  const data=feature.properties as {class?:string;subclass?:string;name?:string;name_en?:string;'name:en'?:string} | undefined;
  if(geometry?.type!=='Point' || !Array.isArray(geometry.coordinates) || !data) return;
  const [lng,lat]=geometry.coordinates;
  if(typeof lat!=='number' || typeof lng!=='number') return;
  const kind=data.subclass;
  const mode=data.class==='bus' && (kind==='bus_stop'||kind==='platform'||kind==='bus_station') ? 'bus'
    : (data.class==='rail'||data.class==='railway') && (kind==='station'||kind==='halt'||kind==='tram_stop'||kind==='stop'||(data.class==='railway'&&kind==='subway')) ? 'rail' : undefined;
  const name=[data.name_en,data['name:en'],data.name].find(value=>typeof value==='string'&&value.trim());
  const featureId=feature.id===undefined?'':String(feature.id);
  if(mode && name) return {lat,lng,mode,name,...(featureId&&featureId.length<=travel.map.featureIdLength?{featureId}:{})};
}

export async function collectMapEvidence(map:MapInstance,points:Endpoints,signal:AbortSignal):Promise<Observations> {
  const {source,layer,zoom,timeoutMs}=travel.map;
  if(signal.aborted || map.getZoom()<zoom || !map.getSource(source)) return {};
  if(!map.isSourceLoaded(source)) await new Promise<void>(resolve=>{
    const timer=setTimeout(done,timeoutMs);
    function done(){clearTimeout(timer);map.off('idle',done);signal.removeEventListener('abort',done);resolve();}
    map.once('idle',done);
    signal.addEventListener('abort',done,{once:true});
  });
  if(signal.aborted || map.getZoom()<zoom || !map.getSource(source)) return {};
  try {
    const landmarks=map.querySourceFeatures(source,{
      sourceLayer:layer,filter:['in',['get','class'],['literal',['bus','rail','railway']]],
    }).slice(0,travel.map.maxFeatures).flatMap(feature=>{
      const point=mappedLandmark(feature);
      return point?[point]:[];
    });
    return Object.fromEntries(Object.entries(points).map(([id,point])=>[id,normalizeLandmarks(point,landmarks)]));
  } catch { return {}; }
}
