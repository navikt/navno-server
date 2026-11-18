# AGENTS.md

The rules for changing navno-server. [README.md](README.md) shows how an app uses it.
[docs/graceful-shutdown.md](docs/graceful-shutdown.md) says how the team's servers stop and how long they keep
connections, and why.

## Commands

| Command       | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| `pnpm test`   | `node --test` on every `test/**/*.test.ts`. About ten seconds.                   |
| `pnpm lint`   | `oxfmt --check`, oxlint and `tsc --noEmit`. Run it before calling a change done. |
| `pnpm format` | oxfmt, Markdown included.                                                        |
| `pnpm build`  | tsdown, to `dist/`.                                                              |

## Shutdown and keep-alive

`docs/graceful-shutdown.md` is where it is decided how a server of ours stops and how long it keeps connections.
`src/serve.ts` does what it says, and the apps get it from `serve()`.

- Read the document before changing `serve.ts`, and before adding shutdown code, signal handlers, sleeps or HTTP
  timeouts to an app. Its table of changes that look right and aren't has `headersTimeout`, readiness on shutdown,
  `preStopHook` and `closeAllConnections()` in it.
- A rule changes in three places at once: the document, `serve.ts` and the tests. The document names what shows each
  rule, which is a source that can be read or a test that fails without it. A new or changed rule needs the same. That
  other servers do something, or that it is common, doesn't show it.
- `test/node.test.ts` tests Node, not this package. When a test there fails after a Node upgrade, a rule built on it may
  be out of date. Change the document and `serve.ts` with the test, rather than the test alone.
- Don't write another implementation in an app. What an app needs that `serve()` doesn't do becomes an option here.

## How the package is put together

- `serve()`, `internal()` and `traceRoutes()` are helpers that are used on their own, and nothing here creates the app.
  Where Vite serves `server/app.ts` in dev, `main.ts` only runs in production, so the routes and the tracing can't be
  `serve()`'s to add.
- The package keeps nothing of its own between calls. The app passes its metrics registry in: Vite runs the app's
  modules again when they change, and a registry here would outlive them.
- `hono`, `@hono/node-server` and `@navikt/navno-logger` are peer dependencies, so the app and the package use the same
  copy of each.
- `createUpstreamClient()` and `failureOf()` are an entry point of their own, `@navikt/navno-server/upstream`, and
  `src/index.ts` doesn't export them. They need `@itsy/corgi` and `@prometheus-io/client`, which are optional peer
  dependencies, so an app that only uses `serve()` installs neither.
- An upstream's name is a plain string, given where the app makes its client. The package never lists upstreams, so a
  new one is a line in the app and nothing here.
- The upstream metrics are `<prefix>upstream_requests_total` and `<prefix>upstream_request_duration_seconds`. Their
  names, labels and help texts are what the apps had of their own, and what their dashboards and alerts read. Don't
  rename them.
- It is published compiled. Two of the apps run their TypeScript as it is, and Node doesn't strip types in files under
  `node_modules`.
- Every version in `package.json` is exact, and pnpm installs only releases at least three days old
  (`minimumReleaseAge`).

## README

- The README is examples and nothing else: code an app can copy, and what running it prints. No paragraphs, tables or
  lists that explain. What needs explaining goes in the JSDoc, in this file or in the document.
- Its `ts` blocks type-check against the built package, and its `console` blocks are what the commands printed when
  they were run. Check them again when what they show changes.

## Tests

- Tests are in `test/`, not next to the code. `serve.test.ts` starts `serve.fixture.ts` as a process of its own and
  sends it real signals, since a signal and an exit can only be seen from outside.
- The logger doesn't wait for a line to be written, so the last lines a process logs before it exits can change places.
  No test relies on their order.
- Each test of `serve()` and of the upstream client has been seen to fail with its behaviour taken out of the source.
  Do the same for a new one.

## Release

A change reaches the apps when `version` in `package.json` is bumped: merging that to main publishes the version to
GitHub Packages.
