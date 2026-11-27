# Effect browser and consumer gates delivery plan

Status: implementation-ready after two independent plan reviews and their
recorded corrections on 2026-11-26. Runtime qualification is not yet complete.
Owner: Engineering Foundation qualification maintainers.
Delivery: one Draft PR, two independent plan-review rounds, implementation,
independent code review, complete exact-head/base CI, owner squash and main CI.
Npm publication remains a separate workstream.

## Purpose and inspected baseline

PR #476 qualified the optional public Effect diagnostics API with pinned
TypeScript 7.0.2 and installed artifacts. This change qualifies its actual
consumer wiring and a real Node/browser boundary. Foundation-first means a
representative disposable consumer is sufficient; a production application is
not a prerequisite.

Inspected Engineering Foundation main:
8432a9737486384f894436bfd9242500e422fa5a.
Inspected Get Modular main:
a5f41853200aed26d692e89d768185013d629a12.

The GM session/communication recipes already cover native services, scoped
resources, bounded PubSub, callback-to-Stream and installed-package workload.
Reuse those public mechanisms. The new evidence concerns HTTP ingress,
actual browser execution, disconnect and complete consumer checking.

This work does not duplicate the LMU portable-document authoring reference.
Its Foundation delivery plan explicitly permits representative actual-browser
qualification before applications. LMU navigation PR #7 and EF baseline-write
fix #481 are independently owned; #481 is already in the inspected main.

## Selected approach and alternatives

Select one installed disposable consumer with three runtime boundaries:
SDK, backend and frontend. Keep tooling separate from production imports.
The same sources, package manifests and compiler-project authority feed
architecture checking, ordinary typechecking, Effect diagnostics and execution.

| Choice | Production/tool integration LOC | Qualification/fixture LOC | Estimate | U / N / C |
| --- | ---: | ---: | ---: | --- |
| Selected: existing Stack/FMS/Foundation gates, fixture-owned mandatory route, Node HTTP, programmatic Playwright Core | 0 public runtime; 200–350 consumer tooling/config | 1,000–1,600 runtime fixture and E2E | 3–5 engineer-days | 8 / 8 / 6 |
| New generic Effect project registry or gate capability | 600–1,000 reusable tooling | 800–1,400 | 6–9 engineer-days | 5 / 6 / 8 |
| Extend GM's specialized Chromium/CDP archive runner here | 0 public runtime; 250–450 integration | 1,100–1,700 | 4–6 engineer-days | 6 / 7 / 7 |

These are planning estimates, not measured implementation size or performance.
U is confidence, N expected reliability within this profile, C complexity,
each out of 10. The selected approach has no new public package, runtime
framework, capability schema, project registry, resolver or scheduler.

Node HTTP is a small qualification Host, not a new product backend stack.
Fastify is the organization's public HTTP reference, but adding its cohort here
would not strengthen the specific lifecycle/wire invariants under test.
Use a real Fastify adapter in a later Fastify-specific qualification if claimed.

A 500/1,000-module Effect scale spike remains separate until this integration
passes. Adding an unrelated scale claim would dilute the first missing boundary.
The additional useful scope here is protocol corruption, startup rejection,
reconnect, two-session isolation and mandatory-gate tampering.

## Dependency and execution profile

Reuse the already qualified exact five-package Effect cohort:
@effect/tsgo-linux-x64 0.73.4, @get-modular/core 0.8.0,
@get-modular/assembly 0.8.0, @get-modular/effect 0.1.1 and effect 4.1.4.
Keep its signature/payload admission and hermetic registry evidence unchanged.

Use existing esbuild 0.28.2 for a real browser bundle.
The only proposed new development-only browser driver is playwright-core
1.65.1, Node >=20. Its manifest declares no npm dependencies, but its
payload includes bundled utilities. Before executing the driver or installer,
inspect the exact published payload and selected entrypoints for any executed
TypeScript implementation; record artifact integrity and the admission result.
Upstream build-only TypeScript 6.0.3 is not runtime evidence and must not be run.
Do not assume an empty dependencies object proves absence of bundled compilers.
Its upstream browsers.json pins Chromium/headless-shell revision 1255,
browser version 159.0.8154.6. Install the pinned headless shell through its
official installer. Record the driver and actual browser version in evidence.
A missing browser fails the designated browser qualification; do not silently
skip, use an arbitrary system Chromium or substitute a DOM emulator.
Browser-download acquisition is explicit CI preparation and never production
runtime installation. Confirm native library requirements before selecting
the existing hosted runner step.

Every new implementation, test and tooling file is ordinary .ts and enters
a strict required TypeScript >=7.0.2 project. Repository integration scripts
enter the existing strict tooling inventory; readable consumer fixture files
enter their own complete flat project inventory and ordinary typecheck runs
in both mandatory Linux installed-artifact routes before runtime execution.
Copy the complete tracked fixture source inventory. Repository check:fast alone
does not claim to typecheck this optional consumer; no root Effect runtime
dependency is added merely for fixture type resolution. Avoid Playwright Test, TS runtime
transpilers, floating pins and new runtime dependencies in Foundation.
The repository retains its exact Node 26.11.1 / Bun 1.4.3 / pnpm 11.20.0 policy.
The installed consumer explicitly declares the existing @types/node 24.13.3
pin and its existing undici-types closure; package devDependencies do not
transitively provide those types. Admit the browser driver separately without
changing the already qualified five-package Effect fixture cohort.
The browser harness lives in the consumer's scripts/check-runtime.ts route.
Declare and acquire exact Playwright Core, esbuild and its selected native binary,
plus Node types, as separate supplemental installed development inputs. Reuse
the existing packed/registry supplemental-input owner; assert physical consumer
installation resolution, with no fallback to producer node_modules.

Published playwright-core payload inspected before first execution:
archive SHA-256 6f5a60be62a4fddfbe7d10c448d8fbd54547da3358f2f8a04211440471ee863e;
registry SHA-512 integrity was verified. The selected index.js and CLI install
entry load bootstrap/coreBundle/utilsBundle. Their imports and bundled code were
inspected; no executed TypeScript compiler/parser was identified in these
selected routes. Optional Test/Vite/BiDi/Electron paths are not selected.
This is bounded entrypoint admission, not a claim about every upstream tool.

Runtime qualification is explicitly Linux x64 Chromium. Existing native
matrix coverage remains intact; other platforms retain their applicable
portable, API and refusal tests. This does not claim Firefox, WebKit,
desktop, mobile, production deployment or a supported UI framework.

## Consumer shape and ownership

Maintain readable files under tests/fixtures/effect-consumer rather than
embedding an entire application in generated source strings.

- SDK: named wire DTOs and protocol errors; no Node or HTTP implementation
  types, Effect Scope, runtime owner or unstable service types in its public API.
- Backend: one application GM composition, native Effect service implementations,
  in-memory session state and a bounded event source.
- Frontend: a small GM/Effect graph for fetch adapter and view model, with
  a thin DOM adapter. It executes in the actual browser realm.
- Tooling: build, required checks and browser driver; it is outside the
  production browser bundle and backend runtime dependency graph.

Choose one actual disposable root package, with sdk, backend, frontend and
scripts source folders. Import shared SDK source through its explicit public
index.ts; include transitive SDK .ts files in each flat leaf's effective roots,
as the existing Effect boundary fixture already does. SDK has its own strict
leaf. Backend and browser use those same checked source bytes in their respective
execution/build paths. No fixture SDK tarball, local declaration workaround,
workspace alias or same-binary-artifact portability claim is introduced.
The installed artifacts under qualification are the public Foundation/Stack/FMS
and GM/Effect packages. Preserve physical installed-path assertions for them.

This deliberately chooses the simpler source-boundary option over R1's suggested
packed fixture SDK: the latter would add packaging/declaration mechanics without
strengthening the selected consumer gate and network claim. A same-SDK-artifact
claim would require that additional qualification, separately.
Do not call two instances of one configurable Host two independently implemented
Hosts or public SPIs. This proves actual backend/browser integration.

A single toolchain.config.json.typecheck.projects list owns all compiler
projects. Prefer sdk/backend/frontend plus one explicit tooling leaf if tooling
cannot fit the strict Node leaf cleanly. No second Effect-project list.
Every leaf is flat, strict and compatible with the supported Effect adapter
profile: no extends, references, local declaration inputs or suppressions.
List every imported local implementation in the appropriate leaf roots.
Do not include generated local .d.ts files; these are unsupported by the adapter.
Neutral source topology has one actual package root ['.'], not three invented
package roots. The SDK/backend/frontend are source boundaries; tooling is
explicitly development-only. Keep allowedUnstableApis empty in the baseline.

Production source census/topology is owned by the existing FMS/source policy.
Existing quality.source-coverage/v5 compares that independent census with
the union of compiler inputs. Frontend implementation must be reachable only
from the frontend leaf: the harness passes its build entry as a path, never
imports frontend implementation/types into tooling. Shared DTOs belong in SDK.
Deleting the frontend project must leave a retained frontend source uncovered
and produce quality.source-coverage.type-context. A named leaf alone is not
a required identity known to the generic coverage mechanism.

## Concrete wire contract

Two independent fixture sessions, left and right. These identifiers are a
test identity convention, not authentication or authorization.

- POST /api/sessions/:id/advance performs one deterministic controlled change.
- GET /api/sessions/:id/events returns NDJSON: ready, then complete progress states.

Each session owns its own PubSub.sliding<Progress>({ capacity: 1, replay: 1 }).
Publish the initial state before opening ingress. A request acquires its real
subscription, emits ready, then consumes replay/current and subsequent states.
Reconnect therefore obtains current state through the same subscription;
there is no separate snapshot-then-subscribe race. The replay is a bounded
latest-state mechanism, not durable event replay or an every-event guarantee.
A slow observer may coalesce intermediate progress states.

Use existing Effect synchronization for each session's short state/revision
update and PubSub.publish, preserving monotonic publication and making the
bounded update/publication step interruption-safe. Do not use publishUnsafe:
it does not apply the sliding overflow strategy. SubscriptionRef is not selected
because the inspected implementation uses an unbounded hub.
Keep per-session hubs so a stalled left subscriber cannot block right's updates.
Publication is not an acknowledgement of browser processing.

The frontend accepts complete states for its own session, advances monotonically,
and rejects corrupt or inconsistent duplicate revisions. Deterministically pause
stream delivery, update the session, reconnect/subscribe and verify the latest
state; separately update immediately after acquisition but before ready/frame
delivery. These test acquisition/replay/ordering, not a new merge algorithm.

Decode unknown wire values at the actual transport boundary with pinned Effect
Schema. Keep named ordinary DTO types as the public contract. Validate session
identity and monotonic revision where relevant. Bound incomplete frame storage
and explicitly reject malformed, oversized or truncated frames.
Do not add a generic protocol language, retry writes or durable-delivery claims.

Use loopback 127.0.0.1 and an ephemeral port. Expose only the fixture routes
and static browser assets. No public debug/observer HTTP endpoints.

## Resource and failure semantics

Backend:
1. Prepare composition and warm the native application runtime.
2. Only after successful startup open ingress and publish readiness.
3. Each streaming request owns a scoped subscription and request cancellation.
4. Response/socket disconnect aborts that same native request. Observe its
   actual settlement/Exit and await its finalizers.
5. Shutdown closes admission, cancels and awaits owned requests, then disposes
   the application runtime and closes the listener.

Respect response.write() backpressure: false waits for drain using the same
cancellation/response-close path. Remove drain/close/error listeners on settlement.
Bound frame size and the owned application queue; kernel/network buffering is
separate from the capacity-1 application source. Add a small controlled writable
mechanism check proving that cancellation releases a request waiting for drain;
label it separately from the real-browser network result.
Do not use ordinary IncomingMessage.close as a proxy for response-stream
disconnect. ServerResponse.close also occurs after ordinary completion; use
writableFinished or an owned terminal-state guard to distinguish premature
termination. Remove the Host's own listeners when their owner settles.
Bound shutdown and fail qualification if a child/request/resource remains.
The qualification driver has a hard outer deadline and finally cleanup,
covering configuration probes, native diagnostics, browser and HTTP children.
The Effect API budget alone is not an aggregate deadline.

Frontend:
- Acquire stable Effect.abortSignal before fetch inside Stream.unwrap; combine
  that scoped signal with the per-promise signal. A per-promise signal alone
  does not own the headers-to-reader gap or the response body's whole lifetime.
  Use Stream.fromReadableStream's ordinary cancellation/lock-release behavior.
  The researched HttpClient.withScope alternative is unstable at this pin;
  this small stable adapter keeps the baseline allowance empty.
- Own the ReadableStream reader in the same lifetime and release/cancel it.
- Explicit Stop/unmount waits for settlement before reconnect constructs a
  fresh owner. Never reuse a disposed ManagedRuntime.
- Page.close is a separate server-disconnect case. Do not promise execution
  of JS finalizers after Chromium has destroyed the realm.

Use observer events/Deferreds and observable network/DOM outcomes for readiness
and release. Counters are supporting evidence, not the only oracle.
One disposed session must not tear down the sibling or application provider.

## Mandatory consumer gates

Use public loadConfiguration from stack-toolchain and checkEffectProjects
from stack-toolchain/effect. Convert the loaded absolute project paths to
canonical relative paths, pass every project, preserve the structured report
and actual exit status. No name-based filtering or manually duplicated list.

Use the existing FMS on-disk API/public source-dependency capabilities for
declared runtime boundaries and public entrypoints. Frontend may use the SDK
public entry, not backend internals or undeclared SDK deep entrypoints.

Run the public Foundation Quality Gate Runner CLI. Its profile owns execution;
it does not know which tasks this consumer requires. Add a small consumer-owned
full-entry wrapper that verifies the fixture's canonical package-script routes
and required profile task IDs before execution, then requires those successful
task identities in the QGR report.
This catches both a removed task and a script replaced with a no-op.
Do not introduce a generic shell parser or import Foundation internal modules.
This is omission/configuration-regression checking, not resistance against
malicious modification of the qualification assertions themselves.

The static coverage route grammar does not inspect QGR or JavaScript wrappers.
Use a literal supported root chain:
check = pnpm lint:typed && node scripts/check-full.ts;
check:fast = pnpm quality:scope. lint:typed and quality:scope invoke the existing
Foundation quality check (full and --scope-only respectively). Require this root
chain in the fixture's wiring assertions. QGR then owns architecture, ordinary
typecheck, Effect diagnostics and runtime qualification; runtime depends on all
static tasks passing. No generic QGR traversal is added to source coverage.

The required full entry covers ordinary typechecking, existing architecture
checks/source coverage, Effect diagnostics and actual runtime qualification.
Keep runtime execution and gate verification acyclic: the outer installed
qualification mutates and invokes the consumer's full route; the consumer
full route never recursively invokes the mutation suite.

## Acceptance matrix and independent oracles

| Case | Required observation |
| --- | --- |
| Actual browser happy path | Same bundled JS executes in Chromium; DOM click sends real POST; real stream updates visible DOM |
| Two sessions | Handwritten expected revisions/data; left changes never affect right |
| Stop after ready | Native fetch abort settles, backend subscription releases, sibling still processes a new change |
| Browser disconnect | Physical page close causes server request settlement and release; remaining page works |
| Reconnect | Capacity-1 replay delivers latest state; controlled acquisition/update orderings preserve monotonic state |
| Malformed/wrong-session frame | Real HTTP bytes cause browser protocol failure and cleanup; corrected counterpart passes |
| Oversized/truncated frame | Bounded decoder rejects and owned resources settle, without buffering unbounded data |
| Startup failure | Runtime acquisition failure produces no ready listener |
| Shutdown | Admission stops, active streams settle, listener closes, application finalizers run exactly once |
| Output backpressure | A controlled writable returning false is cancelled; drain/close listeners and request owner release |
| Browser closure | esbuild metafile plus actual execution proves no backend, tooling, Foundation runtime or Node imports |
| Omitted frontend project | Existing coverage gate names the retained uncovered production inputs |
| Removed Effect task | Full-entry required-task assertion rejects incomplete profile |
| Deleted/no-op Effect script | Canonical script-route assertion or QGR script validation rejects |
| Frontend to backend internals | Existing source boundary check rejects the actual forbidden edge |
| SDK private entry | Existing entrypoint/source check rejects actual deep import |
| Forbidden unstable use | Real selected export use yields the expected Effect diagnostic and rejected project |
| Public unstable type leak | Real SDK public signature yields API-leak diagnostic, not merely a nonzero exit |

Mutations operate on the same installed consumer, restore in finally, and
finish with a positive restored run. Inspect the full report's intended failing
task for mutations that reach QGR. Omitted-project rejection occurs in the
leading lint:typed quality step, before QGR; assert its actual Foundation
coverage report rather than requiring a nonexistent QGR report.
Where QGR does not retain complete diagnostic output, invoke that same
failed public check once against the unchanged mutant, capture its bounded JSON
output and assert the specific diagnostic before restoration. This separate
read-only diagnostic observation is not a substitute for full-route failure. Do not use a bare unstable import as the
negative diagnostic. Inspect diagnostic category/code and project rather than
accepting an unrelated syntax/compiler failure.

No browser network stubs, page.route, fake fetch or schema-only validation may
stand in for the network cases. Deterministic event acknowledgements replace
arbitrary sleeps. Timeout is a failure budget, not the synchronization oracle.

## Delivery sequence and parallel ownership

P0: commit this plan to the one Draft PR; perform two independent review rounds,
correcting substantive gaps before implementation.

P1 runtime owner: readable SDK/backend/frontend files and lifecycle/wire tests.
P1 gate owner: fixture toolchain/FMS/coverage/QGR configuration, typed check
wrappers and omission/boundary/unstable mutation qualification.
P1 integration owner: pinned test driver, bundle/Chromium harness, installed
artifact/registry invocation, strict source/test inventories and CI owner.
Agree file ownership before edits; shared fixture manifests are integrated by
one owner. Source commits retain canonical organization author and committer
identity and are pushed promptly to this PR.

P2: run focused positive and rejecting checks, inspect actual cleanup,
then independently review code, fix findings and rerun affected tests.
Use task-scoped Stack cleanup, check:changed, check:fast and workflow-security
checks. Reuse existing packed integration and registry foundation ownership;
do not create a parallel browser CI framework. Select the existing Linux x64
packed integration and registry foundation owners. Both execute the actual full
consumer route, including Chromium, for their respective installed-artifact
claim. No skipBrowser success mode exists. Negative static mutations cannot
reach the dependent runtime task; only positive/restored full runs launch it.
Other matrix rows retain their existing applicable scope and make no browser
claim. Browser acquisition is a reusable setup within each owning job.

P3: request complete full-ci on final head/base, await native matrix and coverage,
record exact-head independent review, use the canonical owner squash route,
and verify the resulting main checks. One PR; publication remains separate.

## Documentation and retained evidence

Add the fixture README with build/run commands, correct/incorrect wiring,
resource ownership, schema/entrypoint rules and precise unsupported claims.
Link it from the Effect usage/quality-gates documentation.
Correct the stale Effect-in-progress index wording only in this work's scope.
Retain command outcomes, exact commits, dependency/browser identities,
review findings/fixes and final CI links in this plan/PR.

## Plan review R1

Independent reviewer role: architecture and qualification critic.
Verdict: changes required, corrected before R2.
Five findings: exact reconnect semantics; full-route/registry browser ownership;
HTTP backpressure and independent session sources; bundled driver admission;
explicit SDK source/artifact boundary. The corrections above use existing
sliding PubSub, literal static coverage routing, full Linux owner execution and
one source-based fixture package. The packed SDK suggestion was deliberately
not selected, with narrower source-integration claims recorded above.
This is a plan review, not executed qualification.

## Plan review R2

Independent reviewer role: source-coverage and installed-consumer critic.
Reviewed R1 revision SHA-256:
24ce783065a96ae61e987dd3c5c4f244bf21e51b759bd02d74d0e25b4a24a199.
Verdict: design sound; three bounded corrections required and recorded above:
frontend-only compiler reachability and pre-QGR diagnostic ownership; explicit
strict checking owner for every copied fixture .ts; exact supplemental installed
browser/build/type closure. After these corrections the reviewer found no
remaining architectural reason to delay implementation. Actual code review,
positive/rejecting runtime qualification and CI remain required.

Primary sources:
- https://github.com/agent-teams-ai/engineering-foundation/pull/476
- https://github.com/agent-teams-ai/engineering-foundation/blob/8432a9737486384f894436bfd9242500e422fa5a/packages/stack-toolchain/EFFECT.md
- https://github.com/agent-teams-ai/get-modular/blob/a5f41853200aed26d692e89d768185013d629a12/packages/effect/docs/practices.md
- https://github.com/agent-teams-ai/get-modular/blob/a5f41853200aed26d692e89d768185013d629a12/tests/qualification/effect-communication/native.ts
- https://github.com/Effect-TS/effect/blob/effect@4.1.4/packages/effect/src/ManagedRuntime.ts
- https://github.com/microsoft/playwright/blob/v1.65.1/packages/playwright-core/package.json
- https://github.com/microsoft/playwright/blob/v1.65.1/packages/playwright-core/browsers.json
- https://github.com/agent-teams-ai/live-module-updates/blob/main/docs/plans/foundation-delivery-plan.md
