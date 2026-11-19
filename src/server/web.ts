import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { AuthConfig } from './auth';

export interface Env extends AuthConfig {
  ASSETS: Fetcher;
  CONTACT_EMAIL?: string;
  DEPLOYMENT?: string;
  AI_ENABLED?: string;

  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_REASONING_EFFORT?: string;
}
export type App = { Bindings: Env; Variables: { user: {id:string; name:string; email:string; role:string; purpose?:string|null}; requestId:string } };
export function problem(status: 400|401|403|404|409|413|429|502|503, message: string): never {
  throw new HTTPException(status,{message});
}
export async function body<T>(c: Context<App>, schema: ZodType<T>) {
  const raw = await c.req.json().catch(() => problem(400,'Send a JSON request.'));
  const validation = schema.safeParse(raw);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    problem(400,issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);
  }
  return validation.data;
}
export function changed(result: D1Result, message = 'No matching record in that state.', status: 404|409 = 404) {
  if (!result.meta.changes) problem(status,message);
}
