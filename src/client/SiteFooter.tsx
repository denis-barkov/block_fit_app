import { appIdentity } from '../../config/app';
import { staffLogin } from '../routes';

export default function SiteFooter({staffSignIn=false}:{staffSignIn?:boolean}) {
  return <footer className="mt-4 border-t border-line">
    <div className="shell flex flex-wrap justify-between gap-3 py-6 text-sm muted">
      <p>{appIdentity.name} · {appIdentity.tagline}</p>
      {staffSignIn && <a className="font-bold" href={staffLogin}>City staff sign in</a>}
    </div>
  </footer>;
}
