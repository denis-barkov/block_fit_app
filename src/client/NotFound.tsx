import SiteFooter from './SiteFooter';

export default function NotFound() {
  return <div className="flex min-h-dvh flex-col">
    <main className="shell grid w-full flex-1 place-items-center py-12 text-center">
      <section className="max-w-xl space-y-4" aria-labelledby="not-found-heading">
        <p className="text-6xl font-bold leading-none tracking-tight text-brand md:text-8xl" aria-hidden="true">404</p>
        <h1 id="not-found-heading">Page not found</h1>
        <p className="muted">Check the address or return to the equipment map.</p>
        <a className="button primary" href="/">Back to home</a>
      </section>
    </main>
    <SiteFooter/>
  </div>;
}
