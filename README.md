# navno-server

## Install

```
pnpm add @navikt/navno-server
```

## Use

```ts
// server/metrics.ts
import { Counter, Registry } from '@prometheus-io/client';

export const registry = new Registry();
export const searches = new Counter({ name: 'searches_total', help: 'Searches made', registers: [registry] });
```

```ts
// server/app.ts
import { internal, traceRoutes } from '@navikt/navno-server';
import { Hono } from 'hono';
import { registry } from './metrics.ts';
import { search } from './search.ts';

const app = new Hono();

app.use(traceRoutes());
app.route('/internal', internal({ registry }));
app.route('/sok/api/search', search);

export default app;
```

```ts
// server/main.ts
import { serve } from '@navikt/navno-server';
import app from './app.ts';

serve(app, { port: 3000 });
```

```yaml
# .nais/config.yml
liveness:
  path: /internal/alive
readiness:
  path: /internal/ready
prometheus:
  enabled: true
  path: /internal/metrics
```

```console
$ NODE_ENV=production node server/main.ts &
{"level":"info","time":"2026-11-19T08:19:35.606Z",…,"port":3000,"message":"Server listening"}

$ curl localhost:3000/internal/alive
OK

$ curl localhost:3000/internal/ready
OK

$ curl -s localhost:3000/internal/metrics | grep searches_total
# HELP searches_total Searches made
# TYPE searches_total counter
searches_total 0
```

## `serve`

```ts
serve(app, {
	port: 3000,
	onShutdown: () => job.stop(),
	closeDelay: 1_000, // default
	drainTimeout: 10_000, // default
	serverOptions: { keepAliveTimeout: 15_000 }, // default
	overrideGlobalObjects: true, // default
});
```

```console
$ NODE_ENV=production node server/main.ts &
{"level":"info","time":"2026-11-19T08:19:38.203Z",…,"port":3000,"message":"Server listening"}

$ curl -si localhost:3000/internal/alive | grep -i keep-alive
Connection: keep-alive
Keep-Alive: timeout=15

$ kill $!; curl -si localhost:3000/internal/alive | grep -i connection; wait $!; echo "exit $?"
{"level":"info","time":"2026-11-19T08:19:39.615Z",…,"signal":"SIGTERM","message":"Server shutting down"}
Connection: close
{"level":"info","time":"2026-11-19T08:19:40.616Z",…,"message":"Shutdown complete"}
exit 0
```

- [Graceful shutdown and keep-alive](docs/graceful-shutdown.md)

## `internal`

```ts
app.route('/internal', internal({ registry, ready: () => offices.loaded }));
```

```console
$ curl -w ' %{http_code}\n' localhost:3000/internal/ready
Not ready 503
```

## `traceRoutes`

```ts
app.use(traceRoutes());
app.get('/users/:id', (c) => c.text(c.req.param('id')));

// /users/42      → /users/:id
// /wp-login.php  → /*
```

## `createUpstreamClient`

```
pnpm add @itsy/corgi @prometheus-io/client
```

```ts
// server/upstream.ts
import { createUpstreamClient } from '@navikt/navno-server/upstream';
import { registry } from './metrics.ts';

export const upstreamClient = createUpstreamClient({ registry, prefix: 'navno_search_' });
```

```ts
// server/search.ts
import { logger } from '@navikt/navno-logger';
import { failureOf } from '@navikt/navno-server/upstream';
import { Hono } from 'hono';
import { upstreamClient } from './upstream.ts';

const searchApi = upstreamClient('search-api', { timeout: 4000, baseURL: process.env.SEARCH_API_URL });

export const search = new Hono().get('/', async (c) => {
	try {
		return c.json(await searchApi.get<{ hits: string[] }>('/search', { query: { q: c.req.query('q') } }));
	} catch (e) {
		logger.error('Search failed', failureOf(e));
		return c.json({ error: 'Search failed' }, 502);
	}
});
```

```console
$ SEARCH_API_URL=http://localhost:4000 NODE_ENV=production node server/main.ts &
{"level":"info","time":"2026-11-19T08:19:43.953Z",…,"port":3000,"message":"Server listening"}

$ curl 'localhost:3000/sok/api/search?q=dagpenger'
{"hits":["Dagpenger"]}

$ curl -s localhost:3000/internal/metrics | grep -e 'requests_total{' -e 'seconds_count'
navno_search_upstream_requests_total{upstream="search-api",status="2xx"} 1
navno_search_upstream_request_duration_seconds_count{upstream="search-api"} 1
```

```ts
createUpstreamClient({
	registry,
	prefix: 'navno_search_',
	buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], // default
});
```

## Develop

```
pnpm test
pnpm lint
pnpm format
pnpm build
```

## Release

```diff
 	"name": "@navikt/navno-server",
-	"version": "1.0.0",
+	"version": "1.0.1",
```
