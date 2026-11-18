# BlockFit production architecture

```mermaid
flowchart LR
    browser["Browser"]
    pages["Cloudflare Pages<br/>Assigned pages.dev hostname"]
    worker["Private Cloudflare Worker<br/>Application, Better Auth and static assets"]
    d1["Cloudflare D1"]
    openai["OpenAI API<br/>Optional staff explanations"]

    browser <-->|"HTTPS, same-origin requests and cookies"| pages
    pages <-->|"Private HTTP service binding"| worker
    worker <--> d1
    worker -.-> openai
```

Pages accepts the canonical project hostname and forwards every application path to the Worker through its service binding. The original Pages URL remains the request URL. Better Auth uses that same origin and issues host-only, secure session cookies. The Pages code forwards permitted application headers, normalizes same-origin redirects to the Pages hostname, and rejects unexpected redirect origins. The Worker also rejects requests addressed to any other hostname. Canonical aliases, cookies, and headers are covered by local Workerd and Better Auth tests.

The backend config disables the `workers.dev` route and Worker version preview URLs. The Pages ingress rejects Pages preview and deployment aliases; the canonical `pages.dev` hostname is the supported public endpoint. Both the public interface and the staff interface use this origin. Cloudflare Pages binds the Worker by its service name internally.

The Make workflow manages one Pages project, Worker and D1 database in the selected Cloudflare account. The protected manifest links their identities. Deploying updates the private Worker first, verifies its public routes are off, then publishes the Pages ingress. The D1 suspension switch blocks service via Pages while retaining data. Destruction removes Pages first and offers a separate D1 retention choice. [Pages service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) · [Workers routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
