import { z } from 'zod';
import { isInServiceArea, pinOutsideServiceArea } from '../config/map-area.ts';
import { catalogLimits, limits, planning } from '../config/settings.ts';

export const category = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type Category = z.infer<typeof category>;
const controls=/\p{Cc}/u;
const catalogText=z.string().refine(value=>!controls.test(value),'Remove control characters.').transform(value=>value.trim());
export const typeName=catalogText.transform(value=>value.replace(/\s+/gu,' '))
  .pipe(z.string().min(catalogLimits.nameMin).max(catalogLimits.nameMax));
export const typeNameKey=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase().toLowerCase();
export const typeFields=z.object({name:typeName,description:catalogText.pipe(z.string().max(catalogLimits.description)).default('')}).strict();
export const typeUpdate=typeFields.extend({active:z.boolean(),version:z.number().int().positive(),labelCorrection:z.literal(true).optional()}).strict();
export const typeDecision=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),name:typeName}).strict(),
  z.object({action:z.literal('match'),category}).strict(),
  z.object({action:z.literal('reject'),reason:catalogText.pipe(z.string().min(1).max(catalogLimits.reason))}).strict(),
]);
export type EquipmentType={id:string;name:string;description:string;active:boolean};
export type StaffEquipmentType=EquipmentType&{version:number};
export function matchingTypes(types:EquipmentType[],name:string,exclude?:string) {
  const key=typeNameKey(name);
  if(key.length<catalogLimits.nameMin) return [];
  return types.filter(type=>type.id!==exclude&&typeNameKey(type.name).includes(key)).slice(0,catalogLimits.matches);
}
export type TypeProposal={
  id:string;name:string;description:string;submittedAt:string;status:'pending'|'approved'|'rejected'|'withdrawn';
};
export type ResidentProposal=TypeProposal&{
  categoryName:string|null;decidedAt:string|null;reason:string|null;requestId:string|null;reusedRequest:boolean;
};
export const coordinate = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});
export type Coordinate = z.infer<typeof coordinate>;
export const shortText = z.string().trim().max(limits.shortText);
const text = z.string().trim().max(limits.text);
const id = z.string().min(1).max(64);
const httpUrl = z.url({ protocol: /^https?$/ }).max(limits.text)
  .refine(value => !new URL(value).username && !new URL(value).password);
const savedLocationInput = coordinate.extend({ label: shortText, useForRequests: z.boolean().optional(),
  confirmed: z.literal(true).optional() }).strict();
const activeRequests = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const locationInput = savedLocationInput.refine(isInServiceArea,pinOutsideServiceArea);
export const moveLocationInput = savedLocationInput.extend({ activeRequests }).refine(isInServiceArea,pinOutsideServiceArea);
const requestDetails = z.object({
  note: text, suggestion: text, point: coordinate.refine(isInServiceArea,pinOutsideServiceArea).nullable(),
});
export const requestInput = requestDetails.extend({category}).strict();
export const proposalInput=requestDetails.extend({...typeFields.shape,submissionKey:z.uuid()}).strict();
const namedPoint = coordinate.extend({ name: shortText.min(1) });
export const parkInput = namedPoint.extend({ externalId: shortText, source: text, hours: shortText, cityMaintained:z.boolean() }).strict();
export const equipmentInput = namedPoint.extend({
  category, parkId: id.nullable(), condition: z.enum(['unknown','usable','unusable']),
  access: z.enum(['unknown','public','restricted']), source: text,
  verifiedOn: z.iso.date().nullable(), visible: z.boolean(),
}).strict().refine(value => !value.verifiedOn || (value.source && value.verifiedOn <= new Date().toISOString().slice(0,10)),
  'Verification needs a source and a date no later than today.');
const cents = z.number().int().min(0).max(planning.maxBudget);
const amount = z.object({ low: cents, base: cents, high: cents }).strict()
  .refine(({ low, base, high }) => low <= base && base <= high, 'Enter costs in low, base, high order.').nullable();
export const upfrontKeys = ['equipment','installation','preparation','accessibility'] as const;
export const costKeys = [...upfrontKeys, 'maintenance', 'replacement'] as const;
export const costs = z.object({
  equipment: amount, installation: amount, preparation: amount, accessibility: amount,
  maintenance: amount, replacement: amount, interval: z.number().int().min(1).max(planning.maxHorizon).nullable(),
  replacementPlan: z.enum(['none','scheduled','unknown']), source: text,
}).strict();
export type Costs = z.infer<typeof costs>;
export const optionalDate=z.preprocess(value=>value===undefined||value===''?null:value,z.iso.date().nullable());
export const candidateInput = namedPoint.extend({
  category, parkId: id.nullable(), feasibility: z.enum(['unreviewed','suitable-for-comparison','excluded']),
  costs, notes: text, projectUrl: httpUrl.nullable(), estimatedStart:optionalDate, estimatedReady:optionalDate,
}).strict().refine(value=>!value.estimatedStart||!value.estimatedReady||value.estimatedStart<=value.estimatedReady,
  'Estimated start must be on or before the ready date.');
export const scenarioInput = z.object({
  category, radius: z.number().int().min(planning.minRadius).max(planning.maxRadius),
  budget: cents, horizon: z.number().int().min(1).max(planning.maxHorizon),
  selected: z.array(id).max(limits.inventory).refine(ids => new Set(ids).size === ids.length),
  selectedOnly:z.boolean().optional(),
}).strict().refine(value=>!value.selectedOnly||value.selected.length>0,'Select a candidate for a selected-sites comparison.')
  .refine(value=>value.selectedOnly||value.selected.length<=planning.combination,'Select fewer sites for a combination.');
export type Scenario = z.infer<typeof scenarioInput>;
export type Park = z.infer<typeof parkInput> & { id: string; fixture?: boolean };
type TypeReference={categoryName:string;categoryActive:boolean};
export type Equipment = z.infer<typeof equipmentInput> & TypeReference & { id: string; fixture?: boolean };
type CandidateFields=z.infer<typeof candidateInput>;
export type Candidate = Omit<CandidateFields,'estimatedStart'|'estimatedReady'> & TypeReference &
  { id:string;fixture?:boolean;estimatedStart?:string|null;estimatedReady?:string|null };
export type PublicEquipment = Omit<Equipment, 'parkId' | 'visible'> & { park: { name: string; hours: string; cityMaintained: boolean } | null };
export type Demand = z.infer<typeof requestInput> & TypeReference & Coordinate & {
  id: string; status: 'recorded' | 'withdrawn'; createdAt: string; confirmedAt: string;
};
export type SavedLocation = Coordinate & { label: string; useForRequests: boolean };
export const explanationSchema = z.object({
  summary: z.string(), tradeoffs: z.string(), checks: z.string(),
  highlightedOptionIds: z.array(z.string()), referencedOptionIds: z.array(z.string()),
}).strict();
export type Explanation = z.infer<typeof explanationSchema>;
