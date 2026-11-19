import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { PublicEquipment } from '../contracts';
import { useTransientNotice } from './common';
import { locationText, mapsLinks } from './travel-maps';

export const mapsHandoff = 'Maps receives the destination pin. Choose a starting point there.';

export default function DestinationActions({site}:{site:PublicEquipment}) {
  const [mode,setMode]=useState<'transit'|'driving'>('transit');
  const [manualCopy,setManualCopy]=useState(false);
  const [notice,setNotice]=useTransientNotice();
  const links=mapsLinks(site,mode);
  return <div className="space-y-2 text-sm">
    {site.fixture && <p className="muted">Illustrative demo pin. Equipment at this location is fictional.</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!!links.length && !site.fixture && <label className="font-semibold">Directions mode
        <select className="ml-2 inline-block! w-auto!" value={mode} onChange={event=>setMode(event.target.value==='driving'?'driving':'transit')}>
          <option value="transit">Transit</option><option value="driving">Driving</option>
        </select>
      </label>}
      {links.map(link=><a key={link.name} className="button" href={link.href} target="_blank" rel="noreferrer">
        {site.fixture?`View pin in ${link.name}`:link.name}
      </a>)}
      <button className="button gap-2" onClick={()=>void (async()=>{
        try {
          await navigator.clipboard.writeText(locationText(site));
          setManualCopy(false);setNotice('Location copied.');
        } catch {
          setNotice('');setManualCopy(true);
        }
      })()}><Copy className="action-icon" aria-hidden="true"/> Copy location</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {manualCopy && <label className="grid gap-1 font-semibold">Select and copy this location
      <textarea readOnly value={locationText(site)} onFocus={event=>event.target.select()}/>
    </label>}
  </div>;
}
