import { useEffect,useRef,useState } from 'react';
import type { LngLatBoundsLike, Map as MapInstance, Marker } from 'maplibre-gl';
import circle from '@turf/circle';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { isInServiceArea, mapArea, pinOutsideServiceArea } from '../../config/map-area';
import { pilot } from '../../config/settings';
import type { Coordinate } from '../contracts';

export type Pin = Coordinate & {
  id:string; label:string; kind:'equipment'|'candidate'|'synthetic'|'private'|'reference';
  covered?:boolean; short?:string; onSelect?:()=>void; onMove?:(point:Coordinate)=>void; selected?:boolean;
};
type Props={pins:Pin[]; overlays?:{point:Coordinate;radius:number}[]; onPick?:(point:Coordinate)=>void; label:string;overview?:boolean;initialCenter?:Coordinate};
const valid=(point:Coordinate)=>Number.isFinite(point.lat)&&Number.isFinite(point.lng);
const extent = ({west,south,east,north}: typeof mapArea.cityOverview): LngLatBoundsLike => [[west,south],[east,north]];
export default function MapView({pins,overlays=[],onPick,label,overview,initialCenter=pilot.center}: Props) {
  const container=useRef<HTMLDivElement>(null);
  const map=useRef<MapInstance|null>(null);
  const module=useRef<typeof import('maplibre-gl')|null>(null);
  const pick=useRef(onPick);
  pick.current=onPick;
  const [ready,setReady]=useState(false);
  const [unavailable,setUnavailable]=useState(false);
  const [regional,setRegional]=useState(false);
  const [outside,setOutside]=useState(false);
  function selectPoint(point: Coordinate, select: (value: Coordinate)=>void) {
    const accepted=isInServiceArea(point);
    setOutside(!accepted);
    if(accepted) select({lat:point.lat,lng:point.lng});
    return accepted;
  }
  function changeExtent() {
    map.current?.fitBounds(extent(regional?pilot.demoOverview:mapArea.cityOverview),{padding:28,maxZoom:14.5,duration:0});
    setOutside(false);
    setRegional(!regional);
  }
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
        center:[initialCenter.lng,initialCenter.lat],zoom:14,
        maxBounds:extent(mapArea.panBounds),scrollZoom:false,
      });
      const limitZoom = () => {
        const cityCamera=view.cameraForBounds(extent(mapArea.cityOverview),{padding:28});
        if (cityCamera?.zoom !== undefined) view.setMinZoom(cityCamera.zoom);
      };
      limitZoom();
      view.on('resize',limitZoom);
      if(overview) view.fitBounds(extent(pilot.demoOverview),{padding:28,maxZoom:14.5,duration:0});
      map.current=view;
      view.addControl(new lib.NavigationControl({showCompass:false}),'top-right');
      view.on('load',()=>{
        clearTimeout(timer);
        loaded=true;
        setUnavailable(false);
        view.addSource('coverage',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
        view.addLayer({id:'coverage',type:'fill',source:'coverage',paint:{'fill-color':coverageColor,'fill-opacity':.19}});
        view.addSource('service-boundary',{type:'geojson',data:mapArea.serviceBoundary});
        view.addLayer({id:'service-boundary',type:'line',source:'service-boundary',
          paint:{'line-color':coverageColor,'line-width':2.5}});
        setReady(true);
      });
      view.on('click',event=>{if (pick.current) selectPoint(event.lngLat,pick.current);});
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
      marker.on('dragend',()=>{
        if (pin.onMove && !selectPoint(marker.getLngLat(),pin.onMove)) marker.setLngLat([pin.lng,pin.lat]);
      });
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
    {ready && !unavailable && <button type="button" className="button absolute top-2 left-2 z-10"
      onClick={changeExtent}>{regional?'Show Forest Hills demo':'Show all five boroughs'}</button>}
    {ready && !unavailable && !outside && <p className="pointer-events-none absolute bottom-10 right-2 rounded-control bg-paper px-2 py-1 text-xs">
      {mapArea.name} pin area
    </p>}
    {outside && <p role="status" className="absolute bottom-10 left-2 z-10 rounded-control bg-paper px-2 py-1 text-sm">
      {pinOutsideServiceArea}
    </p>}
    {!ready && <div className="absolute inset-0 grid place-content-center bg-canvas px-5 text-center muted" role="status">
      {unavailable?'Map unavailable. Use the lists or coordinate fields.':'Loading neighborhood map…'}
    </div>}
  </div>;
}
