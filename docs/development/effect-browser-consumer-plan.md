# Effect browser and consumer gates delivery plan

Status: proposed on 2026-11-26; implementation has not started.
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
1.65.1: no dependency closure or embedded TypeScript compiler, Node >=20.
Its upstream browsers.json pins Chromium/headless-shell revision 1255,
browser version 159.0.8154.6. Install the pinned headless shell through its
official installer. Record the driver and actual browser version in evidence.
A missing browser fails the designated browser qualification; do not silently
skip, use an arbitrary system Chromium or substitute a DOM emulator.
Browser-download acquisition is explicit CI preparation and never production
runtime installation. Confirm native library requirements before selecting
the existing hosted runner step.

Every new implementation, test and tooling file is ordinary .ts and enters
a strict required TypeScript >=7.0.2 project. Avoid Playwright Test, TS runtime
transpilers, floating pins and new runtime dependencies in Foundation.
The repository retains its exact Node 26.11.1 / Bun 1.4.3 / pnpm 11.20.0 policy.

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

Use the same installed SDK artifact where a same-artifact claim is made;
otherwise explicitly report separate target builds. Do not call two instances
of one configurable Host two independently implemented Hosts or public SPIs.
The useful claim is backend/browser integration and execution of their actual
shared SDK boundary, not a universal portability certification.

A single toolchain.config.json.typecheck.projects list owns all compiler
projects. Prefer sdk/backend/frontend plus one explicit tooling leaf if tooling
cannot fit the strict Node leaf cleanly. No second Effect-project list.
Every leaf is flat, strict and compatible with the supported Effect adapter
profile: no extends, references, local declaration inputs or suppressions.
SDK source ownership and imported implementation inputs must match the
adapter's canonical root requirement; verify this before finalizing layout.

Production source census/topology is owned by the existing FMS/source policy.
Existing quality.source-coverage/v5 compares that independent census with
the compiler projects. This is what detects an omitted project.

## Concrete wire contract

Two independent fixture sessions, left and right. These identifiers are a
test identity convention, not authentication or authorization.

- GET /api/sessions/:id/snapshot returns sessionId, revision, completed.
- POST /api/sessions/:id/advance performs one deterministic controlled change.
- GET /api/sessions/:id/events returns NDJSON: ready, then future progress frames.

Ready is emitted only after the subscription is actually acquired.
Events are notifications without replay. After reconnect, the consumer obtains
the authoritative snapshot and observes subsequent changes using an explicitly
race-free handshake/order; a separate snapshot followed by subscription must
not silently lose a change between those steps.
Publication is not an acknowledgement of browser processing.

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

Do not use ordinary IncomingMessage.close as a proxy for response-stream
disconnect. Remove the Host's own listeners when their owner settles.
Bound shutdown and fail qualification if a child/request/resource remains.
The qualification driver has a hard outer deadline and finally cleanup,
covering configuration probes, native diagnostics, browser and HTTP children.
The Effect API budget alone is not an aggregate deadline.

Frontend:
- Pass the actual native cancellation signal to fetch.
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
full-entry wrapper that verifies the fixture's canonical package-script routes,
then requires the expected successful task identities in the QGR report.
This catches both a removed task and a script replaced with a no-op.
Do not introduce a generic shell parser or import Foundation internal modules.
This is omission/configuration-regression checking, not resistance against
malicious modification of the qualification assertions themselves.

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
| Reconnect | Snapshot/subscription handshake has no gap; fresh owner sees authoritative value and later change |
| Malformed/wrong-session frame | Real HTTP bytes cause browser protocol failure and cleanup; corrected counterpart passes |
| Oversized/truncated frame | Bounded decoder rejects and owned resources settle, without buffering unbounded data |
| Startup failure | Runtime acquisition failure produces no ready listener |
| Shutdown | Admission stops, active streams settle, listener closes, application finalizers run exactly once |
| Browser closure | esbuild metafile plus actual execution proves no backend, tooling, Foundation runtime or Node imports |
| Omitted frontend project | Existing coverage gate names the retained uncovered production inputs |
| Removed Effect task | Full-entry required-task assertion rejects incomplete profile |
| Deleted/no-op Effect script | Canonical script-route assertion or QGR script validation rejects |
| Frontend to backend internals | Existing source boundary check rejects the actual forbidden edge |
| SDK private entry | Existing entrypoint/source check rejects actual deep import |
| Forbidden unstable use | Real selected export use yields the expected Effect diagnostic and rejected project |
| Public unstable type leak | Real SDK public signature yields API-leak diagnostic, not merely a nonzero exit |

Mutations operate on the same installed consumer, restore in finally, and
finish with a positive restored run. Do not use a bare unstable import as the
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
do not create a parallel browser CI framework. Keep a single designated
positive browser lane and disclose where registry consumes the same gate
without duplicating a Chromium launch unnecessarily.

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

Primary sources:
- https://github.com/agent-teams-ai/engineering-foundation/pull/476
- https://github.com/agent-teams-ai/engineering-foundation/blob/8432a9737486384f894436bfd9242500e422fa5a/packages/stack-toolchain/EFFECT.md
- https://github.com/agent-teams-ai/get-modular/blob/a5f41853200aed26d692e89d768185013d629a12/packages/effect/docs/practices.md
- https://github.com/agent-teams-ai/get-modular/blob/a5f41853200aed26d692e89d768185013d629a12/tests/qualification/effect-communication/native.ts
- https://github.com/Effect-TS/effect/blob/effect@4.1.4/packages/effect/src/ManagedRuntime.ts
- https://github.com/microsoft/playwright/blob/v1.65.1/packages/playwright-core/package.json
- https://github.com/microsoft/playwright/blob/v1.65.1/packages/playwright-core/browsers.json
- https://github.com/agent-teams-ai/live-module-updates/blob/main/docs/plans/foundation-delivery-plan.md
