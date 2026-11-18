import { useEffect,useRef,useState } from 'react';
import type { Map as MapInstance, Marker } from 'maplibre-gl';
import circle from '@turf/circle';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { pilot } from '../../config/settings';
import type { Coordinate } from '../contracts';

export type Pin = Coordinate & {
  id:string; label:string; kind:'equipment'|'candidate'|'synthetic'|'private'|'reference';
  covered?:boolean; short?:string; onSelect?:()=>void; onMove?:(point:Coordinate)=>void; selected?:boolean;
};
type Props={pins:Pin[]; overlays?:{point:Coordinate;radius:number}[]; onPick?:(point:Coordinate)=>void; label:string;overview?:boolean};
const valid=(point:Coordinate)=>Number.isFinite(point.lat)&&Number.isFinite(point.lng);
export default function MapView({pins,overlays=[],onPick,label,overview}: Props) {
  const container=useRef<HTMLDivElement>(null);
  const map=useRef<MapInstance|null>(null);
  const module=useRef<typeof import('maplibre-gl')|null>(null);
  const pick=useRef(onPick);
  pick.current=onPick;
  const [ready,setReady]=useState(false);
  const [unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    let mounted=true;
    let timer:ReturnType<typeof setTimeout>;
    void import('maplibre-gl').then(lib=>{
      if (!mounted || !container.current) return;
      let loaded=false;
      const coverageColor=getComputedStyle(container.current).getPropertyValue('--color-brand').trim();
      module.current=lib;
      lib.setWorkerUrl(new URL(mapWorkerUrl,window.location.href).href);
      const view=new lib.Map({
        container:container.current,style:'https://tiles.openfreemap.org/styles/liberty',
        center:[pilot.center.lng,pilot.center.lat],zoom:14,
        maxBounds:[[pilot.bounds.west-.01,pilot.bounds.south-.01],[pilot.bounds.east+.01,pilot.bounds.north+.01]],
        scrollZoom:false,
      });
      if(overview) {
        const {west,south,east,north}=pilot.demoOverview;
        view.fitBounds([[west,south],[east,north]],{padding:28,maxZoom:14.5,duration:0});
      }
      map.current=view;
      view.addControl(new lib.NavigationControl({showCompass:false}),'top-right');
      view.on('load',()=>{
        clearTimeout(timer);
        loaded=true;
        setUnavailable(false);
        view.addSource('coverage',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
        view.addLayer({id:'coverage',type:'fill',source:'coverage',paint:{'fill-color':coverageColor,'fill-opacity':.19}});
        setReady(true);
      });
      view.on('click',event=>pick.current?.({lng:event.lngLat.lng,lat:event.lngLat.lat}));
      view.on('error',()=>{if (!loaded) setUnavailable(true);});
      timer=setTimeout(()=>{if (!loaded) setUnavailable(true);},9000);
    }).catch(()=>{if(mounted)setUnavailable(true);});
    return ()=>{mounted=false;clearTimeout(timer);map.current?.remove();map.current=null;};
  },[]);
  useEffect(()=>{
    const view=map.current;
    const lib=module.current;
    if (!view || !lib || unavailable) return;
    const markers:Marker[]=[];
    for (const pin of pins.filter(valid)) {
      const node=document.createElement(pin.onSelect || pin.onMove ? 'button' : 'span');
      if (node instanceof HTMLButtonElement) node.type='button';
      node.className='map-marker'; node.dataset.kind=pin.kind;
      if(pin.covered)node.dataset.covered='true';
      node.setAttribute('aria-label',pin.label);
      if (pin.onSelect) node.setAttribute('aria-pressed',String(!!pin.selected));
      node.textContent=pin.short ?? '';
      node.addEventListener('click',event=>{event.stopPropagation();pin.onSelect?.();});
      const marker=new lib.Marker({element:node,draggable:!!pin.onMove}).setLngLat([pin.lng,pin.lat]).addTo(view);
      marker.on('dragend',()=>pin.onMove?.(marker.getLngLat()));
      markers.push(marker);
    }
    return ()=>markers.forEach(marker=>marker.remove());
  },[pins,ready,unavailable]);
  useEffect(()=>{
    map.current?.getSource<import('maplibre-gl').GeoJSONSource>('coverage')?.setData({
      type:'FeatureCollection',features:overlays.filter(x=>valid(x.point))
        .map(({point,radius})=>circle([point.lng,point.lat],radius/1000,{steps:48})),
    });
  },[overlays,ready]);
  return <div className="map-frame" role="region" aria-label={label}>
    <div ref={container} className="absolute inset-0" aria-hidden={unavailable||undefined}/>
    {!ready && <div className="absolute inset-0 grid place-content-center bg-canvas px-5 text-center muted" role="status">
      {unavailable?'Map unavailable. Use the lists or coordinate fields.':'Loading neighborhood map…'}
    </div>}
  </div>;
}
