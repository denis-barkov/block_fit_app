import { lazy,Suspense,useEffect,useRef,useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { category,type Category } from '../contracts';
import { loginLink,residentLogin,returnPath,staffHome,staffInventoryPage,staffLogin } from '../routes';
import { api,AuthForm,Feedback,message,Modal,PasswordForm,useAction,type User } from './common';
import Public from './Public';
const Resident=lazy(()=>import('./Resident'));
const City=lazy(()=>import('./City'));

const path=location.pathname.replace(/\/$/,'')||'/';
const staffPage=path===staffHome||path.startsWith(staffHome+'/');
const query=new URLSearchParams(location.search);
const selected=category.safeParse(query.get('category'));
const next=query.get('returnTo');

function App() {
  const [user,setUser]=useState<User|null|undefined>();
  const [contact,setContact]=useState<string|null>(null);
  const [accountOpen,setAccountOpen]=useState(false);
  const accountButton=useRef<HTMLButtonElement>(null);
  const [error,setError]=useState('');
  const [sessionCheck,recheck]=useState(0);
  const action=useAction();

  useEffect(()=>{
    let active=true;
    void api<{user:User|null}>('/me').then(({user})=>{
      if(!active)return;
      if(!user && staffPage && path!==staffLogin) {
        location.replace(loginLink('staff',path+location.search));return;
      }
      if(!user && path==='/requests') {
        location.replace(loginLink('resident',path+location.search));return;
      }
      setUser(user);
    }).catch(error=>{if(active)setError(message(error));});
    return ()=>{active=false;};
  },[sessionCheck]);
  useEffect(()=>{
    void api<{contact:string|null}>('/config').then(value=>setContact(value.contact)).catch(()=>{});
    const refresh=()=>{setAccountOpen(false);setUser(undefined);setError('');recheck(n=>n+1);};
    const restore=(event:PageTransitionEvent)=>{if(event.persisted)refresh();};
    const hide=(event:PageTransitionEvent)=>{
      if(event.persisted && (staffPage || path==='/requests')) document.getElementById('main')?.setAttribute('hidden','');
    };
    window.addEventListener('pagehide',hide);
    window.addEventListener('pageshow',restore);
    window.addEventListener('blockfit-session-expired',refresh);
    return ()=>{
      window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',restore);
    };
  },[]);

  useEffect(()=>{
    if(user!==undefined || error) document.getElementById('main')?.removeAttribute('hidden');
  },[user,error]);

  const signOut=()=>void action.run(async()=>{
    await api('/auth/sign-out','POST',{});
    setUser(undefined);
    location.replace(staffPage?staffLogin:'/');
  });
  const account = user && <div className="flex items-center gap-2">
    <button ref={accountButton} type="button" aria-label="Account" aria-haspopup="dialog" onClick={()=>setAccountOpen(true)}
      className="grid size-11 place-items-center rounded-full border border-mint bg-mint text-sm font-bold text-brand-dark hover:bg-white focus-visible:outline-white">
      <span aria-hidden="true">{initials(user.name)}</span>
    </button>
    <button className="min-h-11 px-1" disabled={action.busy} onClick={signOut}>Sign out</button>
  </div>;
  const mismatch=staffPage?user?.role==='resident':path==='/requests'&&user?.role==='staff';
  const signIn=(matched:User)=>{
    if(staffPage && matched.role==='resident') {setUser(matched);return;}
    location.replace(matched.role==='staff'&&matched.purpose==='automated-test'?staffHome:returnPath(matched.role,next));
  };
  const request=(value:Category)=>{location.assign(`/requests?category=${encodeURIComponent(value)}`);};

  return <>
    <a className="sr-only focus:not-sr-only focus:fixed focus:z-40 focus:bg-paper focus:p-3" href="#main">Skip to content</a>
    <header className={`border-b border-line text-white ${staffPage?'bg-workspace':'bg-ink'}`}>
      <div className="shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
        <a href={staffPage?staffHome:'/'} className="flex items-center gap-2 text-xl font-bold">
          <span className="grid size-9 place-items-center rounded-control bg-brand text-sm" aria-hidden="true">BF</span>
          {staffPage?'City workspace':'BlockFit NYC'}
        </a>
        <nav aria-label={staffPage?'Staff navigation':'Public navigation'} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-semibold">
          {staffPage ? <>
            {user?.role==='staff' && <>
              <a className="py-2" href={staffHome} aria-current={path===staffHome?'page':undefined}>Investment comparisons</a>
              {user.purpose!=='automated-test' && <a className="py-2" href={staffInventoryPage} aria-current={path===staffInventoryPage?'page':undefined}>Manage inventory</a>}
            </>}
            <a className="py-2" href="/">View public site</a>
          </>:<>
            <a href="/" className="py-2" aria-current={path==='/'?'page':undefined}>Explore equipment</a>
            {user===null && <a className="py-2" href={residentLogin}>Sign in / Register</a>}
            {user?.role==='resident' &&
              <a className="py-2" href="/requests" aria-current={path==='/requests'?'page':undefined}>My requests</a>}
            {user?.role==='staff' && <a className="py-2" href={staffHome}>Return to City workspace</a>}
          </>}
          {account}
        </nav>
      </div>
    </header>
    <div className="border-b border-line bg-mint"><p className="shell py-2 text-xs">NYCEDC project concept · Demonstration data · Requests inform planning discussion.</p></div>
    <div id="main" tabIndex={-1}>
      {(error || action.error) && <div className="shell"><Feedback error={error||action.error}/>
        {error && <button className="button" onClick={()=>{setError('');recheck(n=>n+1);}}>Retry session</button>}</div>}
      {user===undefined ? (!error && <p className="shell py-8" role="status">Checking your session…</p>) :
        mismatch ? <main className="shell py-10"><section className="panel max-w-xl space-y-3">
          <h1>{staffPage?'Staff access required':'Resident access required'}</h1>
          <p className="muted">{staffPage?'You’re signed in with a resident account. City workspace access requires a staff account.':'Your staff account can browse public equipment and open the City workspace.'}</p>
          <div className="flex flex-wrap gap-2">
            <a className="button" href="/">{staffPage?'View public site':'Explore equipment'}</a>
            <a className="button" href={staffPage?residentLogin:staffHome}>{staffPage?'Resident sign-in':'Return to City workspace'}</a>
            {staffPage && <button className="button primary" disabled={action.busy} onClick={signOut}>Sign out to switch accounts</button>}
          </div>
        </section></main> :
        path===(staffPage?staffLogin:residentLogin) ? (
          <main className="shell py-10"><section className="panel max-w-xl space-y-4">
            <h1>{staffPage?'City staff sign in':'Resident sign in'}</h1>
            <AuthForm registration={!staffPage} contact={contact} onUser={signIn}/>
          </section></main>
        ) : <Suspense fallback={<p className="shell py-8" role="status">Loading workspace…</p>}>
          {staffPage && user?.role==='staff' ? <City inventoryOnly={path===staffInventoryPage} testWorkspace={user.purpose==='automated-test'}/> :
            path==='/requests' && user?.role==='resident' ? <Resident initialCategory={selected.success?selected.data:'pull-up'}/> :
            <Public request={user?.role==='staff'?undefined:request}/>}
        </Suspense>}
    </div>
    {!staffPage && <footer className="mt-4 border-t border-line"><div className="shell flex flex-wrap justify-between gap-3 py-6 text-sm muted">
      <p>BlockFit NYC · Outdoor fitness access and investment planning</p>
      {user===null && <a className="font-bold" href={staffLogin}>City staff sign in</a>}
    </div></footer>}
    {accountOpen && user && <Modal title="Account" onClose={()=>{
      setAccountOpen(false);
      requestAnimationFrame(()=>accountButton.current?.focus());
    }}>
      <div className="mb-4 flex items-start gap-3">
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-full bg-mint text-sm font-bold text-brand-dark">{initials(user.name)}</span>
        <div className="min-w-0 break-words">
          <p className="text-xs font-bold text-brand-dark">{user.role==='staff'?'City staff':'Resident'}</p>
          <p className="font-bold">{user.name}</p>
          <p className="text-sm muted">{user.email}</p>
        </div>
      </div>
      {user.role==='resident' && <PasswordForm/>}
    </Modal>}
  </>;
}

function initials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const parts = words.length > 1 ? [words[0],words.at(-1)!] : words;
  return parts.map(word=>[...word][0]).join('').toLocaleUpperCase() || '?';
}

createRoot(document.getElementById('root')!).render(<App/>);
