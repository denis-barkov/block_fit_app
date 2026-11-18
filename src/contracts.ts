import { z } from 'zod';
import { categories, limits, pilot, planning } from '../config/settings.ts';

export const category = z.enum(Object.keys(categories) as [keyof typeof categories, ...(keyof typeof categories)[]]);
export type Category = z.infer<typeof category>;
export const coordinate = z.object({
  lat: z.number().finite().min(pilot.bounds.south).max(pilot.bounds.north),
  lng: z.number().finite().min(pilot.bounds.west).max(pilot.bounds.east),
});
export type Coordinate = z.infer<typeof coordinate>;
export const shortText = z.string().trim().max(limits.shortText);
const text = z.string().trim().max(limits.text);
const id = z.string().min(1).max(64);
const httpUrl = z.url({ protocol: /^https?$/ }).max(limits.text)
  .refine(value => !new URL(value).username && !new URL(value).password);
export const locationInput = coordinate.extend({ label: shortText, confirmed: z.literal(true) }).strict();
export const requestInput = z.object({
  category, note: text, suggestion: text, point: coordinate.nullable(),
}).strict();
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
export const candidateInput = namedPoint.extend({
  category, parkId: id.nullable(), feasibility: z.enum(['unreviewed','suitable-for-comparison','excluded']),
  costs, notes: text, projectUrl: httpUrl.nullable(),
}).strict();
export const scenarioInput = z.object({
  category, radius: z.number().int().min(planning.minRadius).max(planning.maxRadius),
  budget: cents, horizon: z.number().int().min(1).max(planning.maxHorizon),
  selected: z.array(id).max(planning.combination).refine(ids => new Set(ids).size === ids.length),
}).strict();
export type Scenario = z.infer<typeof scenarioInput>;
export type Park = z.infer<typeof parkInput> & { id: string };
export type Equipment = z.infer<typeof equipmentInput> & { id: string };
export type Candidate = z.infer<typeof candidateInput> & { id: string };
export type PublicEquipment = Omit<Equipment, 'parkId' | 'visible'> & { park: { name: string; hours: string; cityMaintained: boolean } | null };
export type Demand = z.infer<typeof requestInput> & Coordinate & {
  id: string; status: 'recorded' | 'withdrawn'; createdAt: string; confirmedAt: string;
};
export type SavedLocation = Coordinate & { label: string };
export const explanationSchema = z.object({
  summary: z.string().max(1200), tradeoffs: z.string().max(1200),
  missing: z.string().max(1200), limitations: z.string().max(1200),
}).strict();
export type Explanation = z.infer<typeof explanationSchema>;
