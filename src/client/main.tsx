import { lazy, Suspense, useEffect,useState, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { category,type Category } from '../contracts';
import { api,AuthForm,Feedback,message,Modal,PasswordForm,useAction,type User } from './common';
import Public from './Public';
const Resident=lazy(()=>import('./Resident'));
const City=lazy(()=>import('./City'));

type Page='/'|'/requests'|'/city';
function readPage(): Page {
  const path=location.pathname;
  return path==='/requests'||path==='/city'?path:'/';
}
function App() {
  const [page,setPage]=useState(readPage);
  const [user,setUser]=useState<User|null|undefined>();
  const [contact,setContact]=useState<string|null>(null);
  const [modal,setModal]=useState<'auth'|'password'|null>(null);
  const [error,setError]=useState('');
  const action=useAction();
  function session() {
    setError('');
    void api<{user:User|null}>('/me').then(value=>setUser(value.user))
      .catch(error=>{setError(message(error));setUser(null);});
  }
  useEffect(()=>{
    session();
    void api<{contact:string|null}>('/config').then(value=>setContact(value.contact)).catch(()=>{});
    const change=()=>setPage(readPage());
    window.addEventListener('popstate',change);
    return ()=>window.removeEventListener('popstate',change);
  },[]);
  function navigate(path:Page,value?:Category) {
    history.pushState(null,'',path+(value?`?category=${encodeURIComponent(value)}`:''));
    setPage(path);
    window.scrollTo(0,0);
  }
  function link(event:MouseEvent<HTMLAnchorElement>,path:Page) {
    if(event.button!==0||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
    event.preventDefault();navigate(path);
  }
  const selected=category.safeParse(new URLSearchParams(location.search).get('category'));
  function request(value:Category) {
    navigate('/requests',value);
    if(!user)setModal('auth');
  }
  return <>
    <a className="sr-only focus:not-sr-only focus:fixed focus:z-40 focus:bg-paper focus:p-3" href="#main">Skip to content</a>
    <header className="border-b border-line bg-ink text-white">
      <div className="shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
        <a href="/" onClick={event=>link(event,'/')} className="flex items-center gap-2 text-xl font-bold">
          <span className="grid size-9 place-items-center rounded-control bg-brand text-sm" aria-hidden="true">BF</span> BlockFit NYC
        </a>
        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-semibold">
          <a href="/" className="py-2" aria-current={page==='/'?'page':undefined} onClick={event=>link(event,'/')}>Explore equipment</a>
          {!user && <a href="/requests" className="py-2" onClick={event=>link(event,'/requests')}>My requests</a>}
          {user?.role==='resident' && <a href="/requests" className="py-2" aria-current={page==='/requests'?'page':undefined}
            onClick={event=>link(event,'/requests')}>My requests</a>}
          {user?.role==='staff' && <a href="/city" className="py-2" aria-current={page==='/city'?'page':undefined}
            onClick={event=>link(event,'/city')}>City workspace</a>}
          {user && <><button className="py-2" onClick={()=>setModal('password')}>Account</button>
            <button className="py-2" disabled={action.busy} onClick={()=>void action.run(async()=>{
              await api('/auth/sign-out','POST',{});setUser(null);navigate('/');
            })}>Sign out</button></>}
        </nav>
      </div>
    </header>
    <div className="border-b border-line bg-mint"><p className="shell py-2 text-xs">NYCEDC project concept · Demonstration data · Requests inform planning discussion.</p></div>
    <div id="main" tabIndex={-1}>
      {(error || action.error) && <div className="shell"><Feedback error={error||action.error}/><button className="button" onClick={session}>Retry session</button></div>}
      {page==='/' ? <Public request={request}/> : <Suspense fallback={<p className="shell py-8" role="status">Loading workspace…</p>}>
        {user===undefined ? <p className="shell py-8" role="status">Checking your session…</p>
          : page==='/requests'&&user?.role==='resident' ? <Resident initialCategory={selected.success?selected.data:'pull-up'}/>
          : page==='/city'&&user?.role==='staff' ? <City/>
          : <main className="shell py-10">
            <section className="panel max-w-xl space-y-3"><h1>{page==='/city'?'City workspace':'My requests'}</h1>
              <p className="muted">{user?'This page requires a different account role.':page==='/city'?'Sign in with your staff account.':
                selected.success?`Sign in to request equipment near your private location.`:'Sign in to manage equipment requests.'}</p>
              {!user && <button className="button primary" onClick={()=>setModal('auth')}>Sign in</button>}
            </section>
          </main>}
      </Suspense>}
    </div>
    <footer className="mt-4 border-t border-line"><div className="shell flex flex-wrap justify-between gap-3 py-6 text-sm muted">
      <p>BlockFit NYC · Outdoor fitness access and investment planning</p>
      <a className="font-bold" href="/city" onClick={event=>link(event,'/city')}>Staff access</a>
    </div></footer>
    {modal==='auth' && <Modal title={page==='/city'?'Staff access':'Access your resident account'} onClose={()=>setModal(null)}>
      <AuthForm registration={page!=='/city'} contact={contact} onUser={value=>{setUser(value);setModal(null);if(value.role==='staff'&&page!=='/city')navigate('/city');}}/>
    </Modal>}
    {modal==='password' && user && <Modal title="Account and password" onClose={()=>setModal(null)}>
      <p className="mb-4 muted">{user.name} · {user.email}</p><PasswordForm/>
    </Modal>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
