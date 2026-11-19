import { Info } from 'lucide-react';
import { useEffect,useId,useRef,useState, type FormEvent, type ReactNode } from 'react';
import { categories, limits } from '../../config/settings';
import type { Category, Coordinate } from '../contracts';

export interface User { id:string; name:string; email:string; role:'staff'|'resident'; purpose?:string|null }
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api'+path,{method,headers:data === undefined ? {} : {'Content-Type':'application/json'},
    body:data === undefined ? undefined : JSON.stringify(data)});
  if (!response.ok) {
    if (response.status===401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('blockfit-session-expired'));
    const error = await response.json().catch(() => ({})) as {error?:string;message?:string};
    throw new Error(error.error || error.message || 'Something went wrong. Please try again.');
  }
  return (response.headers.get('Content-Type')?.includes('application/json') ? response.json() : response.text()) as Promise<T>;
}
export const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';
export function useAction() {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [status,setStatus] = useState('');
  const running = useRef(false);
  async function run(action: () => Promise<void>, success = '') {
    if (running.current) return;
    running.current=true;
    setBusy(true); setError(''); setStatus('');
    try { await action(); setStatus(success); }
    catch (error) { setError(message(error)); }
    finally { running.current=false; setBusy(false); }
  }
  return {busy,error,status,run};
}
export function Feedback({error,status}: {error?:string;status?:string}) {
  return <>{error && <p role="alert" className="mt-2 text-sm font-semibold">{error}</p>}
    {status && <p role="status" className="mt-2 text-sm font-semibold text-brand">{status}</p>}</>;
}
export function Field({label,children}: {label:string;children:ReactNode}) {
  return <label className="grid min-w-0 gap-1 text-sm font-semibold">{label}{children}</label>;
}
export function Categories({value,onChange,all=false}: {value:string;onChange:(value:Category|'')=>void;all?:boolean}) {
  return <select value={value} onChange={e=>onChange(e.target.value as Category|'')}>
    {all && <option value="">All equipment</option>}
    {Object.entries(categories).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
  </select>;
}
export function Coordinates({value,onChange}: {value:Coordinate;onChange:(value:Coordinate)=>void}) {
  return <div className="field-grid">
    <Field label="Latitude"><input type="number" step="any" min={-90} max={90}
      required value={Number.isNaN(value.lat)?'':value.lat} onChange={e=>onChange({...value,lat:e.target.valueAsNumber})}/></Field>
    <Field label="Longitude"><input type="number" step="any" min={-180} max={180}
      required value={Number.isNaN(value.lng)?'':value.lng} onChange={e=>onChange({...value,lng:e.target.valueAsNumber})}/></Field>
  </div>;
}
type Help = {label:string;content:ReactNode};

export function InfoHint({label,content,children}: Help & {children:ReactNode}) {
  const id=useId();
  const [open,setOpen]=useState(false);
  return <div className="min-w-0">
    <div className="flex items-center">
      {children}
      <button type="button" className="info-trigger" aria-label={label} title={label}
        aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>
        <Info aria-hidden="true" focusable="false"/>
      </button>
    </div>
    <div id={id} className="info-content" hidden={!open}>{content}</div>
  </div>;
}

export function Modal({title,onClose,children,help}: {title:string;onClose:()=>void;children:ReactNode;help?:Help}) {
  const ref=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  useEffect(()=>{
    const dialog=ref.current;
    dialog?.showModal();
    return ()=>dialog?.close();
  },[]);
  const heading=<h2 id={titleId}>{title}</h2>;
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}}
    className="panel m-auto w-[min(100%-2rem,36rem)] max-h-[90dvh] overflow-auto">
    <div className={`mb-4 flex justify-between gap-2 ${help?'items-start':'items-center'}`}>
      <div className="min-w-0 flex-1">{help?<InfoHint {...help}>{heading}</InfoHint>:heading}</div>
      <button type="button" className="button shrink-0" onClick={onClose} aria-label="Close dialog" autoFocus>Close</button>
    </div>
    {children}
  </dialog>;
}
export function AuthForm({onUser,contact,registration=true}: {onUser:(user:User)=>void;contact:string|null;registration?:boolean}) {
  const [mode,setMode]=useState<'in'|'up'|'help'>('in');
  const action=useAction();
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data=Object.fromEntries(new FormData(event.currentTarget));
    void action.run(async()=>{
      await api(`/auth/sign-${mode}/email`,'POST',data);
      const {user}=await api<{user:User|null}>('/me');
      if (!user) throw new Error('Sign-in could not be confirmed. Try again.');
      onUser(user);
    });
  }
  if (mode==='help') return <div className="space-y-3">
    <p>Contact us and include your login. Never send your password.</p>
    {contact ? <a className="button primary" href={`mailto:${contact}`}>Contact us</a> : <p className="muted">Ask your demonstration operator for help.</p>}
    <button className="button ml-2" onClick={()=>setMode('in')}>Back to sign in</button>
  </div>;
  return <form key={mode} onSubmit={submit} className="space-y-3">
    {mode==='up' && <Field label="Display name"><input name="name" autoComplete="name" required maxLength={limits.shortText}/></Field>}
    <Field label="Email"><input name="email" type="email" autoComplete="username" required maxLength={254}/></Field>
    <Field label="Password"><input name="password" type="password" autoComplete={mode==='up'?'new-password':'current-password'}
      required minLength={mode==='up'?limits.minPassword:undefined} maxLength={limits.maxPassword}/></Field>
    {mode==='up' && <><Field label="Confirm password"><input name="confirmation" type="password" autoComplete="new-password"
      minLength={limits.minPassword} maxLength={limits.maxPassword} required/></Field>
      <p className="muted text-sm">Use at least {limits.minPassword} characters. Your email is an unverified login identifier. No email will be sent.</p></>}
    <div className="flex flex-wrap gap-2">
      <button className="button primary" disabled={action.busy}>{mode==='in'?'Sign in':'Register'}</button>
      {registration && <button type="button" className="button" disabled={action.busy} onClick={()=>setMode(mode==='in'?'up':'in')}>
        {mode==='in'?'Create resident account':'Back to sign in'}</button>}
      {mode==='in' && <button type="button" className="button" onClick={()=>setMode('help')}>Forgot password?</button>}
    </div><Feedback error={action.error}/>
  </form>;
}
export function PasswordForm() {
  const action=useAction();
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    void action.run(async()=>{
      await api('/auth/change-password','POST',Object.fromEntries(new FormData(form)));
      form.reset();
    },'Password changed. Other sessions were signed out.');
  }
  return <form onSubmit={submit} className="space-y-3">
    {([['currentPassword','Current password'],['newPassword','New password'],['confirmation','Confirm new password']] as const)
      .map(([name,label])=><Field key={name} label={label}><input name={name} type="password" required
        autoComplete={name==='currentPassword'?'current-password':'new-password'} maxLength={limits.maxPassword}
        minLength={name==='currentPassword'?undefined:limits.minPassword}/></Field>)}
    <button className="button primary" disabled={action.busy}>Change password</button><Feedback {...action}/>
  </form>;
}
