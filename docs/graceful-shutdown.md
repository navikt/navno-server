# Graceful shutdown and keep-alive

How the navno team's Node servers stop without losing requests, and how long they keep connections open.
[`serve()`](../src/serve.ts) does all of it. An app that uses `serve()` adds nothing of its own: no signal handlers, no
sleeps, no timeouts. An app that can't use it yet follows the same rules.

This is where the behaviour is decided, so that it isn't decided again in each app. Every rule has its reason and what
shows it: a source to read, or a test in this repository that fails when the claim stops being true. A change to a rule
starts with a change to what shows it.

Checked on 18 November 2026 with Node 26.13 and `@hono/node-server` 2.1.6, against Nais as its documentation and source
were that day. [Not settled](#not-settled) lists what couldn't be checked.

## What happens when a pod stops

| Time     | Who        | What                                                                                                                                                                      |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 s      | Kubernetes | Marks the pod as terminating. It leaves the Service's endpoints, so the ingress and other apps get no new connections to it. That takes a moment to reach all of them.    |
| 0–5 s    | Nais       | Nothing, on purpose: the pod's `preStop` hook is a 5 s sleep. The server knows nothing yet and answers as before.                                                         |
| 5 s      | Kubernetes | Sends SIGTERM.                                                                                                                                                            |
| 5–6 s    | `serve()`  | Calls `onShutdown`. Goes on answering, and every answer says `Connection: close`, so a client that is using a connection closes it and opens its next one to another pod. |
| 6 s      | `serve()`  | Stops listening, and closes the connections that are idle.                                                                                                                |
| from 6 s | `serve()`  | Answers the requests still in progress, and closes each connection when its request is answered. Exits with 0 after the last.                                             |
| 15 s     | `serve()`  | Gives up on what is still running: logs a warning and exits with 1.                                                                                                       |
| 30 s     | Kubernetes | Sends SIGKILL to a process that is still there.                                                                                                                           |

With no request in progress, the pod is gone 6 s after it was marked.

## Why each step is there

### 1. The wait before SIGTERM is Nais's, not the app's

Kubernetes begins to stop a pod and takes it out of the Service's endpoints at the same time
([Termination of Pods][k8s-termination]), so a server that closed at once would refuse connections the ingress was
still sending it. The answer is a wait before the signal, and Nais has one: a pod whose manifest sets no `preStopHook`
gets a hook that sleeps for 5 s before SIGTERM ([`defaultPreStopHook` in naiserator][naiserator-prestop],
[Nais on termination][nais-termination]). It is Kubernetes's own sleep, run by the kubelet, so it needs nothing from
the image.

So:

- the app doesn't sleep before it closes
- the manifest sets no `preStopHook`, which would replace the 5 s
- `/ready` doesn't begin to fail on SIGTERM: a terminating pod's endpoint is not ready whatever its probe answers
  ([Termination of Pods][k8s-termination])

### 2. An open connection can only be told on an answer: `Connection: close` for 1 s

The wait keeps new connections away from the pod. It does nothing about the connections that are open already, and
other apps have those. An app that calls this one through service discovery keeps its connections to the pod and goes
on using them, with no way of seeing that the pod is leaving.

HTTP/1.1 gives a server one way to end such a connection without the client losing a request to it: an answer that
says `Connection: close` ([RFC 9112, 9.6][rfc-teardown]). The other way is to close the connection while it is idle,
and that can meet a request the client sent a moment before ([RFC 9112, 9.5][rfc-timeouts]). The request gets no answer
(`node.test.ts`: _a request sent as the server closes its idle connection gets no answer_), and Node's `fetch` hands the
error to its caller rather than trying again.

So for the first second after SIGTERM, `serve()` answers as before, and every answer says `Connection: close`
(`serve.test.ts`: _goes on answering during the close delay_). Node closes a connection when it has sent such an answer
(`node.test.ts`: _an answer with Connection: close ends its connection_), and the client opens its next one, which the
Service gives to another pod. A connection that sends nothing during the second is closed when it is over.

Measured on one machine: a client with six kept-alive connections, each sending a request and then pausing, against
the server in `test/serve.fixture.ts`, with SIGTERM in the middle of the traffic. The numbers are how many of 200 stops
lost at least one request, which is one that ended in a connection error on a connection that had been used before.
It was measured once, by hand. The tests named above are what holds the behaviour in place.

| The server, from SIGTERM                 | `http.Agent`, pauses of 0–10 ms | `http.Agent`, 0–200 ms | `fetch`, 0–10 ms | `fetch`, 0–200 ms |
| ---------------------------------------- | ------------------------------- | ---------------------- | ---------------- | ----------------- |
| `Connection: close`, and closes at once  | 81                              | 11                     | 103              | 6                 |
| `Connection: close` for 1 s, then closes | 0                               | 0                      | 0                | 0                 |

The first row is `closeDelay: 0`: the idle connections are closed at the signal, which is also what `server.close()`
does by itself. That is fine for a server whose only client is a load balancer that has already stopped sending. Ours
have other apps as clients too.

The second also gives the ingress one more second to catch up, should 5 s not be enough for it
([Not settled](#not-settled)).

### 3. `server.close()` leaves connections open, so they are closed as they go idle

After the second, `serve()` calls `server.close()`. That stops the listening and closes the connections that are idle
at that moment ([`server.close()`][node-close]). A connection with a request in progress is left alone, and when the
request is answered it goes back to waiting for the next one. It takes further requests, and `close()` isn't done until
it has been idle for the keep-alive timeout (`node.test.ts`: _close() leaves a connection that was answering open_).
With 15 s of keep-alive, the 10 s the server has to stop run out first.

A request that came after SIGTERM closes its own connection, with `Connection: close`. One that began before SIGTERM
is answered the usual way. So `serve()` calls `server.closeIdleConnections()` every 50 ms until `close()` is done,
which ends such a connection once its request is answered (`node.test.ts`: _closeIdleConnections() ends such a
connection_, `serve.test.ts`: _on SIGTERM, answers the request in progress and then exits with 0_).

`server.closeAllConnections()` and `process.exit()` are not for this: both cut the requests in progress.

### 4. 10 s, then exit with 1

A pod has 30 s from when it is marked until SIGKILL (`terminationGracePeriodSeconds`, which none of our manifests set), and
Nais's sleep has taken 5 of them when SIGTERM comes. Our servers are meant to answer within milliseconds, so what is
still running 10 s after SIGTERM is taken to be stuck. `serve()` ends it itself rather than leave it for the SIGKILL
15 s later, so that the log has a warning that says so and the exit code is 1 (`serve.test.ts`: _cuts off a request
that outlasts the drain timeout_).

The 10 s count from SIGTERM, and the first second is part of them. A `drainTimeout` above 25 s needs a
`terminationGracePeriodSeconds` to match.

### 5. `onShutdown` is for what would start new work

`onShutdown` is called at SIGTERM and waited for before the exit. It is for timers, scheduled jobs and watchers:
things that would otherwise start work in a process that is on its way out. Requests are still being answered when it
runs, for a second or more, so it leaves alone what they need. An `onShutdown` that throws is logged and doesn't keep
the server from stopping, and one that never finishes is given up on after the 10 s.

The app doesn't listen for SIGTERM or SIGINT itself. Two handlers race to exit, and the one that wins decides whether
the requests in progress are answered.

## Keep-alive: 15 s

A server has to keep an idle connection longer than the client at its other end does. Only the client knows whether a
request is on its way, so the client has to be the one that closes, or the request meets a closed connection
([RFC 9112, 9.5][rfc-timeouts]).

What is at the other end of our servers' connections, and how long each keeps one that is idle:

| Client                                             | Keeps an idle connection                                                | From                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The ingress: HAProxy, which replaced nginx in 2026 | A few seconds: every 5 s it closes half of those it has, by its default | [`pool-purge-delay`][haproxy-purge], [Nais's ingress reference][nais-ingress] |
| Wonderwall, the login sidecar                      | 5 s                                                                     | [its transport][wonderwall-transport]                                         |
| Another Node app, with `fetch`                     | 2 s less than the server says in `Keep-Alive: timeout=15`, so 13 s      | Measured with Node 26.13                                                      |
| Another Node app, with `http` and no agent set     | 5 s, or 1 s less than the server says when that is shorter              | Measured with Node 26.13, [`agentKeepAliveTimeoutBuffer`][node-agent]         |

Node's own keep-alive timeout is 5 s, 6 s in effect ([`keepAliveTimeoutBuffer`][node-buffer]). That is a second more
than Wonderwall's and less than the ingress can keep a connection, so with it the server would at times be the one to
close.

15 s is three times what Wonderwall keeps, and three of the ingress's rounds: by its default, about one in eight of
the connections it had idle is still open by then. The server is the one to close those, which loses a request only if
the ingress sends one on the connection at that moment. `fetch` and Node's default `http` agent go by what the server
says, so they close first whatever the number is.

It was 65 s, from when the ingress was nginx and kept idle connections for 60 s. No proxy in front keeps one that long
now. Don't put 65 s back, and don't set other timeouts to match the keep-alive.

`serve()` sets it (`serve.test.ts`: _keeps idle connections for 15 s_). It plays no part when the server stops: the
idle connections are closed then, as above.

## `headersTimeout`: leave it alone

`headersTimeout` is how long a request's headers get to arrive once they have begun to, 60 s unless set
([`server.headersTimeout`][node-headers-timeout]). It is there so that a client can't hold a connection by sending its
headers a byte at a time. It doesn't time a connection that is idle between two requests (`node.test.ts`: _headersTimeout
times a request whose headers have begun to arrive, not an idle connection_): with `headersTimeout` at 0.3 s and
keep-alive at 5 s, a connection that has been idle for a second takes its next request, while a request that stops
halfway through its headers is answered 408.

The advice to set it above `keepAliveTimeout`, most often as `headersTimeout: 66_000`, is from a bug. From Node 10.15.2,
in February 2019, the time was counted from the end of the previous request on the connection. A connection that had
been idle for longer than `headersTimeout`, 40 s then, was cut when its next request came, whatever `keepAliveTimeout`
said, and a load balancer in front answered 502 ([nodejs/node#27363][node-issue]). Setting `headersTimeout` above
`keepAliveTimeout` got around it. The bug was fixed in Node 12.19 and 13.13, in 2020, and isn't in any release line
since ([nodejs/node#32329][node-fix]). We run Node 24 and later.

`serve()` doesn't set `headersTimeout`. An app with a reason of its own to change how long headers may take passes it
in `serverOptions`. The same goes for `requestTimeout`, which is 300 s.

## Changes that look right and aren't

| Change                                                           | Why not                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `headersTimeout: 66_000`, or any value "above the keep-alive"    | It gets around a bug that was fixed in 2020. [`headersTimeout`](#headerstimeout-leave-it-alone)                          |
| A sleep in the app before it closes, for the ingress to catch up | Nais sleeps for 5 s before SIGTERM. `closeDelay` is there for another reason and isn't where to add to that. [1][]       |
| `preStopHook` in the manifest                                    | It replaces Nais's sleep instead of adding to it. [1][]                                                                  |
| `/ready` answering 503 after SIGTERM                             | A terminating pod is not ready whatever its probe answers. [1][]                                                         |
| `closeDelay: 0`, to stop a second sooner                         | Other apps lose requests on the connections they have open. [2][]                                                        |
| `server.close()` and nothing more                                | A connection that was answering stays open and takes more requests, so the server can be there until it is killed. [3][] |
| `server.closeAllConnections()` or `process.exit()` on SIGTERM    | It cuts the requests in progress. [3][]                                                                                  |
| A `drainTimeout` above 25 s                                      | SIGKILL comes first, unless `terminationGracePeriodSeconds` is raised with it. [4][]                                     |
| The app's own handler for SIGTERM or SIGINT                      | Two handlers race to exit. What the app has to stop goes in `onShutdown`. [5][]                                          |
| `keepAliveTimeout: 65_000`, for the load balancer                | It was for nginx, which kept idle connections for 60 s. The ingress is HAProxy now. [Keep-alive](#keep-alive-15-s)       |
| A `keepAliveTimeout` below 15 s, or Node's own 5 s               | It is too close to the 5 s that Wonderwall and the ingress count in. [Keep-alive](#keep-alive-15-s)                      |

[1]: #1-the-wait-before-sigterm-is-naiss-not-the-apps
[2]: #2-an-open-connection-can-only-be-told-on-an-answer-connection-close-for-1-s
[3]: #3-serverclose-leaves-connections-open-so-they-are-closed-as-they-go-idle
[4]: #4-10-s-then-exit-with-1
[5]: #5-onshutdown-is-for-what-would-start-new-work

## Not settled

- **Whether the ingress is always done with a pod 5 s after it is marked.** The HAProxy ingress controller applies
  changes from Kubernetes on an interval, 5 s unless set otherwise ([`--sync-period`][haproxy-sync]), and how Nais has
  set it isn't public. If it is 5 s, a pod can be sent new connections until about the time SIGTERM comes. `serve()`
  answers for one more second. After that a new connection is refused, and what the ingress does with a refused
  connection depends on settings that aren't public either. The ingress's `haproxy_backend_connection_errors_total` for
  an app during a rollout would show it ([Nais's ingress reference][nais-ingress]). If it happens, it is Nais's sleep
  that is too short for its ingress, and that is for Nais to hear about. It isn't a reason to sleep in the app.
- **Whether 15 s outlasts the ingress.** What the ingress does with idle connections is known from HAProxy's defaults,
  not from how Nais has set it. If it keeps them for longer than those say, the server closes more of them first, and
  some of those closes meet a request. It would show as errors for the app in the ingress's metrics at times when no
  pod is stopping ([Nais's ingress reference][nais-ingress]).
- **Node 24.** The tests have been run on Node 26.13. `engines` allows 24, which the decorator and navno-search run.
- **Connections that aren't a request and its answer.** Nothing here is thought through for WebSockets, server-sent
  events or HTTP/2. An answer that is still streaming 10 s after SIGTERM is cut.

## The tests

They are in the package's repository, under `test/`. The published package has this document and the build.

- [`test/node.test.ts`](../test/node.test.ts) tests Node's own HTTP server, not this package: what `headersTimeout` times,
  what `close()` leaves open, what `Connection: close` does. When one of them fails after a Node upgrade, Node has
  changed, and this document and `serve()` can change with it.
- [`test/serve.test.ts`](../test/serve.test.ts) starts a server as a process of its own, sends it real signals, and reads
  what it did from its log, its answers and its exit code. Each test has been seen to fail with its behaviour taken out
  of `serve()`.

## Sources

- Kubernetes: [Termination of Pods][k8s-termination]
- Nais: [Handles termination gracefully][nais-termination], [Ingress reference][nais-ingress],
  [`defaultPreStopHook` in naiserator][naiserator-prestop],
  [the documentation's change from nginx to HAProxy][nais-haproxy-change]
- HAProxy: [`pool-purge-delay`][haproxy-purge], [`http-reuse`][haproxy-reuse], and the ingress controller's
  [`--sync-period`][haproxy-sync]
- Wonderwall: [the transport it calls the app with][wonderwall-transport]
- Node: [`server.close()`][node-close], [`server.headersTimeout`][node-headers-timeout],
  [`server.keepAliveTimeoutBuffer`][node-buffer], [`http.Agent`][node-agent], [nodejs/node#27363][node-issue],
  [nodejs/node#32329][node-fix]
- HTTP/1.1: RFC 9112, [9.5 Failures and Timeouts][rfc-timeouts] and [9.6 Tear-down][rfc-teardown]

[k8s-termination]: https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/#pod-termination-flow
[nais-termination]: https://doc.nais.io/workloads/explanations/good-practices/#handles-termination-gracefully
[nais-ingress]: https://doc.nais.io/workloads/application/reference/ingress/
[nais-haproxy-change]: https://github.com/nais/doc/pull/855
[naiserator-prestop]: https://github.com/nais/naiserator/blob/0cff2fdc5c9dcbcba4a6e674882223b4a7d015ea/pkg/resourcecreator/pod/pod.go#L434-L444
[haproxy-purge]: https://docs.haproxy.org/3.0/configuration.html#5.2-pool-purge-delay
[haproxy-reuse]: https://docs.haproxy.org/3.0/configuration.html#4.2-http-reuse
[haproxy-sync]: https://github.com/haproxytech/kubernetes-ingress/blob/master/documentation/controller.md#--sync-period
[wonderwall-transport]: https://github.com/nais/wonderwall/blob/ca77435d6a0d4e7172ce96dc0bae4cbb796286a8/internal/http/transport.go
[node-close]: https://nodejs.org/api/http.html#serverclosecallback
[node-headers-timeout]: https://nodejs.org/api/http.html#serverheaderstimeout
[node-buffer]: https://nodejs.org/api/http.html#serverkeepalivetimeoutbuffer
[node-agent]: https://nodejs.org/api/http.html#new-agentoptions
[node-issue]: https://github.com/nodejs/node/issues/27363
[node-fix]: https://github.com/nodejs/node/pull/32329
[rfc-timeouts]: https://www.rfc-editor.org/rfc/rfc9112#section-9.5
[rfc-teardown]: https://www.rfc-editor.org/rfc/rfc9112#section-9.6
