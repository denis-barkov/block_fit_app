import { expect,it,vi } from 'vitest';
import type { Map as MapInstance } from 'maplibre-gl';
import { travel } from '../config/travel';
import { approxDistance, byDistance, distanceBand, normalizeLandmarks, type Landmark } from '../src/travel';
import { collectMapEvidence, mappedLandmark } from '../src/client/map-evidence';
import { locationText,mapsLinks } from '../src/client/travel-maps';
import type { PublicEquipment } from '../src/contracts';

const origin={lat:40.72,lng:-73.847};
const point={type:'Point',coordinates:[origin.lng,origin.lat]};
const station={geometry:point,properties:{class:'rail',subclass:'station',name:'Forest Hills'}};

it('classifies unrounded distances inclusively and breaks equal distances by stable ID',()=>{
  const [near,far,one]=travel.bands.map(band=>band.limit);
  expect([0,near,near+.0001,far,far+.0001,one,one+.0001].map(distanceBand))
    .toEqual(['Nearby','Nearby','A little farther','A little farther','Farther away','Farther away','Consider transportation']);
  expect(approxDistance(far+.0001)).toBe('0.5 mi');
  expect(byDistance([{...origin,id:'b'},{...origin,id:'a'}],origin).map(({site})=>site.id)).toEqual(['a','b']);
});

it('ignores arbitrary points and track geometry and bounds and deduplicates named stops',()=>{
  expect(mappedLandmark(station)).toEqual({...origin,mode:'rail',name:'Forest Hills'});
  expect(mappedLandmark({...station,geometry:{type:'LineString',coordinates:[point.coordinates,point.coordinates]}})).toBeUndefined();
  expect(mappedLandmark({...station,properties:{class:'rail',subclass:'subway',name:'Track'}})).toBeUndefined();
  expect(mappedLandmark({...station,properties:{class:'bus',subclass:'bus_stop'}})).toBeUndefined();
  const rail=mappedLandmark(station)!;
  const stops:Landmark[]=[rail,rail,{...rail,name:'\u0000 '},{...rail,name:'Far',lat:41},{...rail,lng:NaN},
    ...Array.from({length:5},(_,index)=>({...origin,mode:'bus' as const,name:`Bus ${index}`}))];
  expect(normalizeLandmarks(origin,stops).map(value=>value.name)).toEqual(['Bus 0','Bus 1','Bus 2','Forest Hills']);
});

it('falls back at low zoom and times out or aborts incomplete map loading',async()=>{
  vi.useFakeTimers();
  try {
    const fixture={getZoom:()=>travel.map.zoom,getSource:()=>({}),isSourceLoaded:()=>false,once:vi.fn(),off:vi.fn(),
      querySourceFeatures:vi.fn(()=>[station,station])};
    const map=fixture as unknown as MapInstance;
    const signal=new AbortController();
    expect(await collectMapEvidence({...fixture,getZoom:()=>10} as unknown as MapInstance,{origin},signal.signal)).toEqual({});
    const pending=collectMapEvidence(map,{origin,far:{lat:41,lng:-74}},signal.signal);
    await vi.advanceTimersByTimeAsync(travel.map.timeoutMs);
    expect(await pending).toMatchObject({origin:[{name:'Forest Hills'}],far:[]});
    const canceled=collectMapEvidence(map,{origin},signal.signal);
    signal.abort();
    expect(await canceled).toEqual({});
    expect(fixture.querySourceFeatures).toHaveBeenCalledTimes(1);
    expect(fixture.off).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
});

it('uses destination-only Maps URLs and labels fictional locations',()=>{
  const site={...origin,id:'id',name:'Site & park',fixture:false} as PublicEquipment;
  const links=mapsLinks(site,'transit').map(link=>new URL(link.href));
  expect(links.map(link=>link.hostname)).toEqual(['www.google.com','maps.apple.com']);
  expect(links.map(link=>link.searchParams.get('destination'))).toEqual(['40.72,-73.847','40.72,-73.847']);
  expect(links[0].searchParams.get('travelmode')).toBe('transit');
  expect(links[1].searchParams.get('mode')).toBe('transit');
  expect(links[0].searchParams.has('origin')).toBe(false);
  expect(links[1].searchParams.has('source')).toBe(false);
  expect(new URL(mapsLinks(site,'driving')[1].href).searchParams.get('mode')).toBe('driving');
  expect(mapsLinks({...site,lat:95},'transit')).toEqual([]);
  expect(mapsLinks({...site,fixture:true},'transit')[1].href).toContain('/place?');
  expect(locationText({...site,fixture:true})).toBe('Site & park (illustrative demo location)\n40.72, -73.847');
});
