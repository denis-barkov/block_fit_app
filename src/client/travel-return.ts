import { category, coordinate } from '../contracts';
import { isInServiceArea } from '../../config/map-area';
import { limits } from '../../config/settings';
import { z } from 'zod';

const key='blockfit-travel-return';
const handoff=z.object({
  category:z.union([category,z.literal('')]),query:z.string().max(limits.shortText),
  origin:coordinate.refine(isInServiceArea).nullable(),target:z.string().max(64).nullable(),
}).strict();
type Handoff=z.infer<typeof handoff>;

export function rememberTravel(handoff:Handoff) {
  try {sessionStorage.setItem(key,JSON.stringify(handoff));} catch {/* Browsing still works without storage. */}
}
export function takeTravel() {
  try {
    const stored=sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return stored?handoff.safeParse(JSON.parse(stored)).data:undefined;
  } catch {return undefined;}
}
export function clearTravel() {
  try {sessionStorage.removeItem(key);} catch {/* Storage can be disabled. */}
}
