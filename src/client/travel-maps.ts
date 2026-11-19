import { isInServiceArea } from '../../config/map-area';
import type { PublicEquipment } from '../contracts';

export const locationText = (site:PublicEquipment) => `${site.name}${site.fixture?' (illustrative demo location)':''}\n${site.lat}, ${site.lng}`;

export function mapsLinks(site:PublicEquipment,mode:'transit'|'driving') {
  if(!isInServiceArea(site)) return [];
  const point=`${site.lat},${site.lng}`;
  const google=new URL(site.fixture?'https://www.google.com/maps/search/':'https://www.google.com/maps/dir/');
  google.search=new URLSearchParams(site.fixture?{api:'1',query:point}:{api:'1',destination:point,travelmode:mode}).toString();
  const apple=new URL(site.fixture?'https://maps.apple.com/place':'https://maps.apple.com/directions');
  apple.search=new URLSearchParams(site.fixture?{coordinate:point}:{destination:point,mode}).toString();
  return [{name:'Google Maps',href:google.href},{name:'Apple Maps',href:apple.href}];
}
