---
id: ARCH-COMMON-ASSEMBLY
type: architecture
status: active
owner: architecture
summary: Bounded plan and execution contract for the optional assembly component above Core.
related:
  - ADR-0023
  - ADR-0026
  - ADR-0029
  - ADR-0030
  - ADR-0031
  - ADR-0032
  - ADR-0033
  - ADR-0035
  - ADR-0036
  - ADR-0037
  - ARCH-CURRENT-CONTRACT
  - ARCH-MVP-IMPLEMENTATION-ROADMAP
---

# Common assembly

## Scope and authority

The owner approved a thin optional `@get-modular/assembly` package. Core remains
pure and unchanged. Assembly depends only on the public Core root; Host supplies
already selected and authorized factory functions; capability types come from
contract descriptors ([ADR-0032](../decisions/0032-give-assembly-an-authoring-builder-and-capability-scoped-handles.md)).
A module is created as an entry beside its declaration and listed in a static group
([ADR-0036](../decisions/0036-compose-roots-from-module-entries-and-static-groups.md)).
Construction success does not establish readiness, trust or permissions.

One construction feature owns module entries and groups, preparation, sequential
execution and the authoring builder.
No service locator, global service registry, discovery, dynamic imports,
scheduler, retry, automatic rollback, disposal, readiness, generations or hot
replacement. The internal Core emitter remains private and required-only.

## Consumer module standard

[ADR-0026](../decisions/0026-adopt-consumer-module-standard.md) accepts this
central authoring and adoption contract. It applies to new composition boundaries
inside a consumer's explicitly accepted Host scope. It does not migrate a product
or certify existing code merely because that product installs Assembly.

### Authority and identity

The organization [Feature Module Standard v1](feature-module-standard.md#adoption)
remains the sole authority for semantic ownership, layers, feature layout,
dependency mechanisms and extraction. Its immutable identity is Git blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
Its published successor v1.1 (Git blob `bd949a9a670862fea851a7791fce772fdef3b4fc`, SHA-256
`cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c`) adds sub-features and
composition contracts; a consumer follows the version its profile pins.
The linked local profile maps Get Modular itself, not all consumers.

The [current contract](current-contract.md) and this Assembly contract own graph
compilation, exact bindings, preparation and construction handoff. Host owns
permissions, readiness, lifecycle decisions and cleanup authority; modules
register their own cleanup through the optional resources package. The local accepted adoption
ADR and consumer profile own concrete roots, composition owners, package pins,
legacy boundaries, exceptions and actual verification commands. None may weaken
organization rules or infer repository-wide conformance from one adopted slice.
Foundation remains this repository's source classifier and dependency policy
engine; this standard does not introduce another import parser.

A consumer pins this document's repository, path, anchor, exact Git commit and
SHA-256 of the complete document bytes, plus its accepting ADR identity. Keep
this one current document; package SemVer, compatibility tokens, profile schema
versions and document content pins are different identities. Local copies are
non-authoritative evidence only.

### New composition boundaries

Every new production capability needs a semantic owner. A bounded context,
package, feature and Assembly entry need not map one-to-one. Inside accepted
Host scope, independently assembled capabilities, alternative implementations
and configurable inter-module relationships must use consumer-owned ports and
a single Core/Assembly composition root. A local adoption can make this optional
library mandatory for that scope.

Fixed library dependencies and private helpers inside a cohesive feature remain
static imports and typed factories. A parser, mapper, DTO, class or endpoint is
not a graph node merely because it is new. Cover real composition seams, not a
quota of entries. Each wiring relationship uses one organization dependency
mechanism. Static composition does not imply runtime plugin discovery; runtime
selection, variable dependencies or independently managed lifecycle require an
explicit demonstrated need for the runtime mechanism.

Keep declarations, profiles and entry creation in the outer composition adapter.
Domain and application code must not import Core, Assembly, registration types,
SDK or transport DTOs, or selected concrete port implementations. Features expose
narrow typed factories and consumer-owned dependency records. Preserve owned
Published Language and anti-corruption boundaries; shared domain identities or
generic repositories are not justified by similar code alone.

There is one production composition authority: the profile, written or completed
by Assembly from the module entries the root lists, selects bindings,
owner-local factories materialize capabilities, and Host receives closed roots.
Do not retain a second direct production assembly, instance fallback, string
lookup, mutable registry, global container or registration-order semantics.
Keep capability IDs and revisions in contract descriptors owned by the contract
owner ([ADR-0032](../decisions/0032-give-assembly-an-authoring-builder-and-capability-scoped-handles.md));
declarations reference descriptors and never spell compatibility. Preserve literal
inference; production wiring must not use `any`, double casts through `unknown`
or broad casts to hide capability, token or slot mismatches. A justified exact
exception needs an accepted rationale and a rejecting test; it cannot authorize
a false type claim.

Construction may be async without making domain APIs async. Preserve Host-owned
cleanup, the created journal and untransferred returned-product handoff. Do not
introduce a generic lifecycle manager for passive construction. Module-registered
cleanup uses the optional resources package; see
[Module resource scopes](#module-resource-scopes).

### Optional dynamic Host lifecycle candidate

[ADR-0029](../decisions/0029-admit-an-optional-lifecycle-kernel-candidate.md)
admits `@get-modular/lifecycle-kernel` only as a candidate shared policy package.
The Host still owns trusted artifact admission, literal imports, grants,
product generation IDs, readiness, routing, async work, resource handles,
cleanup and recovery. Core/Assembly do not import the kernel. This does not
change a passive composition scope or certify Agent Runtime dynamic adoption.

For an explicitly adopted dynamic scope, keep inert selected declarations
separate from executable loaders. Reject the **whole selected graph** for
namespace, capability, binding or loader mismatch before any candidate import.
The Host creates a strong construction-attempt owner before the first import,
reserves custody before each possible acquisition, and checks live call and
product authority again after awaits and immediately before effects. Kernel
call/custody leases are bookkeeping identities, not artifact grants or cleanup
tickets. New admission closes at quiesce; ordinary effects close at retirement.
Private owner cleanup may continue afterward without restoring plugin authority.
An observer timeout never releases held work or proves physical disposal.

Record source SHA, exact package/archive hashes, this standard's full-document
SHA-256 and retained copy, TEST/production classification and real rejecting
commands in the consumer profile. A synthetic TEST Host can demonstrate these
races but cannot establish production adoption or G1 public qualification.
Until those gates and a product's local adoption decision pass, classify the
dynamic boundary as pending. Retained consumers that initiate **new** calls
after owner retirement are outside the first kernel contract; supporting them
requires a successor decision, separate evidence and product policy rather
than treating custody as invocation authority.

| Use | Reject | Evidence |
| --- | --- | --- |
| Cohesive feature with closed ports | Business policy in a giant root | Existing layer gate and ownership review |
| Exact implementation and capability | Instance fallback or second resolver | Independent mapping and zero-call negative tests |
| Local private parser or helper | Node per class or endpoint | Positive fixture and semantic review |
| Composition adapter imports | Assembly inside domain/application | Existing source policy and negative import fixture |
| Host cleanup for what the Host itself acquires | Duplicate disposal through shared capabilities | Failure, cancellation and handoff tests |
| Independent direct test reference | Production fallback or oracle derived from profile | Binding mutant and parity test |
| Oracle that pins providers and roots and lists every non-completed row | A full row table, or an oracle copied from the plan or `describeWiring` | [`packages/conformance/tests/conformance.test.mjs`](../../packages/conformance/tests/conformance.test.mjs) |
| Module resources through `setup`/`use` | Host-written cleanup lists for module-acquired resources | [`tests/resources/assembly-scope.test.mjs`](../../tests/resources/assembly-scope.test.mjs) |
| One scope per run through the `scoped` adapter of `implement` | Parent scope captured when an entry is created | Same file, two concurrent runs |
| Declared run inputs | Closures captured when an entry is created | [`tests/assembly/inputs.test.mjs`](../../tests/assembly/inputs.test.mjs) |
| Descriptors and `declareModule` | Hand-written compatibility literals | [`tests/assembly/builder-types.ts`](../../tests/assembly/builder-types.ts) |

Completing a profile in `prepare` ([ADR-0035](../decisions/0035-complete-composition-profiles-in-prepare-and-make-capabilitiesof-linear.md))
is not a second resolver: it runs once, before any factory, over the entries the
root lists, and writes explicit rows into the compiled plan. It never guesses,
and no factory receives a resolver, a container or a registry
([ADR-0031](../decisions/0031-pass-a-per-run-scope-and-declared-inputs-to-assembly-runs.md)).

### Module resource scopes

[ADR-0030](../decisions/0030-admit-the-module-resource-scope-package.md) admits
the optional `@get-modular/resources` package. It is a cleanup mechanism: a
module registers how to release what it acquired, and the Host decides when a
scope closes, how long to wait, when to escalate or abandon, whether to retry
and how to report health. Core and Assembly do not import it. Pure and
borrow-only modules need nothing.

A scope is cooperative cleanup of trusted in-process code. `complete: true`
means every registered cleanup callback returned without throwing; it is not
proof of physical release. `Debt.path` is an array; join it only for display.

Module authors:

1. Acquire through `resources.setup`, or pass a value already in hand to
   `resources.use`. Acquire asynchronously only inside `setup`: after a close is
   requested `use()` throws and the value stays with you. Never close a
   dependency received through a slot; it is borrowed.
2. Name every entry and child scope. Names form the debt paths that Hosts
   alert on.
3. Everything a cleanup needs is a declared slot or the module's own resource.
   Hidden dependencies break the order; independent modules are ordered by
   implementation ID, not by intent.
4. Give a child scope only ports whose setup completed before the child was
   created. Never pass `Resources` of an ancestor or any `ScopeControl` down.
5. When subscribing to a provider, register the returned disposer in your own
   scope.
6. Running work is not a resource. Register dependencies, then the drain set,
   then the subscription, so release runs unsubscribe, drain, close; or make
   each operation a `child()`.
7. A domain shutdown protocol, such as retire, settle and delete in a fixed
   order, stays inside one cleanup. A scope orders independent entries; it
   does not replace an authority sequence.
8. A cleanup throws only when its resource may still be held. Its `escalate`
   signal asks for a faster release; it never permits skipping one.
9. `use()` releases bluntly: `Writable` is destroyed, `ChildProcess` only
   receives SIGTERM, `http.Server` waits for active requests. Use the README
   recipes that react to the escalation signal.
10. Wrap a thenable resource: `setup: () => ({ proc: execa(...) })`.
11. Domain and application code never sees `Resources`; only the composition or
    adapter layer of the module does. Only the `scoped` adapter reads
    `FactoryContext.scope`; never cast it.
12. Never await `close()` of your own or an ancestor scope inside a cleanup.
13. A cleanup that must not run twice guards itself; the Host may retry.

Host template (policy belongs to the Host, not to the library):

<!-- consumer-standard-example: host -->

```ts
import { assemblyFor, declareModule, defineContract, implement, type Assembly, type CapabilitiesOf, type ModuleFactory } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { scoped, type CloseReport, type ModuleContext, type Resources, type ScopeControl } from "@get-modular/resources";

// Contract owners publish one descriptor per capability.
export const Db = defineContract<DbPort>()({ id: "acme/db", revision: 1 });
export const Orders = defineContract<OrdersPort>()({ id: "acme/orders", revision: 1 });

// A module package: no wire literals, typed only by the contracts it uses.
export const ordersDeclaration = declareModule({
  moduleId: "acme/orders", implementationId: "acme/orders/default",
  owner: { authority: "acme", path: ["orders"] },
  provides: [Orders.provide()], slots: [Db.slot("db", required())],
});
export const createOrders: ModuleFactory<
  CapabilitiesOf<typeof Db | typeof Orders>, typeof ordersDeclaration, Connection, ModuleContext
> = async (deps, { resources }) => {
  const conn = await resources.setup({
    name: "conn",
    setup: ({ signal }) => connect(url, { signal }),
    cleanup: (c) => c.close(),
  });
  return { instance: conn, capabilities: { "acme/orders": createOrdersPort(deps.db, conn) } };
};

// The Host: policy belongs here, not in the library.
export async function closeWithin(
  control: ScopeControl, graceMs: number, abandonMs: number,
): Promise<CloseReport> {
  const escalate = new AbortController();
  const abandon = new AbortController();
  // Referenced timers keep the process alive until the Host has a report.
  // Abandon ends only this wait: the scope keeps releasing in order.
  const toEscalate = setTimeout(() => { escalate.abort(); }, graceMs);
  const toAbandon = setTimeout(() => { abandon.abort(); }, graceMs + abandonMs);
  try {
    return await control.close({ escalate: escalate.signal, abandon: abandon.signal });
  } finally {
    clearTimeout(toEscalate);
    clearTimeout(toAbandon);
  }
}

// A one-file sketch: in a consumer each entry lives at the top level of its module file (Module template).
// A Host-local stand-in; module packages export their entry the way `orders` is made here.
const database = implement<CapabilitiesOf<typeof Db>>()(declareModule({
  moduleId: "acme/db", implementationId: "acme/db/pg",
  owner: { authority: "acme", path: ["db"] }, provides: [Db.provide()], slots: [],
}), async () => ({ instance: undefined, capabilities: { "acme/db": { query: () => 0 } } }));
const orders = implement<CapabilitiesOf<typeof Db | typeof Orders>>()(ordersDeclaration, createOrders, scoped);

// The composition root is a function of Assembly, so `smoke` can pass its own api.
export function composeOrders(api: Assembly<CapabilitiesOf<typeof Db | typeof Orders>>) {
  // `orders` has one `required` slot and `database` is the only provider of its capability, so Assembly
  // completes the row; the profile follows the module list.
  return api.prepare({ profileId: "acme/orders-host", modules: [database, orders], roots: { orders } });
}
// Prepare once; every run gets its own scope.
const preparation = await composeOrders(assemblyFor<CapabilitiesOf<typeof Db | typeof Orders>>());
if (preparation.status === "failed") { throw new ConstructionFailed(preparation); }
const { prepared } = preparation;

export async function construct(host: Resources, signal: AbortSignal) {
  const attempt = host.child({ name: "attempt" });
  const outcome = await prepared.run({ signal, scope: attempt.resources });
  if (outcome.status !== "succeeded") { // run() has settled: no factory is running
    throw new ConstructionFailed(outcome, await closeWithin(attempt.control, 5_000, 5_000));
  }
  return { roots: outcome.roots, lifetime: attempt.control }; // transfer ownership with control
}
```

Host rules:

- Pass `scoped` as the adapter of `implement` for every owning factory
  (`implement<C>()(declaration, factory, scoped)`); Assembly names the module
  scope by its implementation id, and `scoped` is the only adapter this standard
  admits: another adapter could read `scope` or add to the context a module
  receives, and Assembly cannot tell `scoped` from another function of the same
  type, so review enforces the rule. Pass one scope per run: `run({ signal, scope: attempt.resources })`,
  never the `Scope` itself. Never capture a scope when creating entries. Close the attempt only
  after `run()` settles. Load exactly one copy of `@get-modular/resources` per
  Host.
- Pass construction cancellation to `run({ signal })`. `scoped()` stops a
  module's setups when it aborts, until the factory settles.
- Keep singletons shared across attempts in the Host scope.
- Use one deadline at the root: escalate first, then abandon, with referenced
  timers. Abandon never means released; the snapshot has `settled: false`,
  debts stay in the scope, and a later `close()` after the flight completed is
  an explicit retry.
- Release continues past a failed entry. When a cleanup may need a provider
  again on retry, such as an audit log that cleanups write to, keep
  that provider in an outer scope and close the outer scope only after the
  inner report is complete.
- Use `child({ order: "concurrent" })` only for a scope whose entries are
  independent peers, such as sessions, turns or instances; everything else
  stays in reverse order.
- Drain or stop running work before closing the scope that holds its
  resources; deciding that work has stopped is Host policy.
- Transfer ownership by transferring `control`.
- A dynamic Host that uses the lifecycle kernel (candidate, ADR-0029) retains
  custody before `child()` and releases it only after the child's report is
  complete.

Out of scope: release order derived from the graph, reference-counted sharing,
durable recovery, dependency-loss health contracts, lifecycle hooks, plugin
managers and process or worker control.

### Dynamic instances

[ADR-0031](../decisions/0031-pass-a-per-run-scope-and-declared-inputs-to-assembly-runs.md)
lets one prepared assembly, called a template below, serve many instances. Get Modular has no live graph
mutation, rebinding, hot replacement or code unloading.

- An instance is one `run()` of a prepared template under its own scope with
  its own inputs. Prepare a template once and keep it at the highest level that
  outlives all its runs; it holds no run state. Key a cached template by the
  plan digest together with the identity of its factory set; the digest alone
  does not cover factories.
- Reserve an instance synchronously by creating its scope with `child()` before
  the first await, then run with that scope's `resources`. Close the instance
  scope after a failed or cancelled `run()` settles. Publish roots only after a
  successful run and transfer the instance's lifetime by transferring its
  `control`.
- Replace an instance by running a new one, switching the owner's pointer and
  closing the old one. A change of any module inside an instance rebuilds the
  whole instance; split an instance that is too coarse into nested templates.
- Pass per-instance data and parent ports as inputs: declarations without
  slots made with `input<C>()(declaration)`, one capability each. Each run supplies them in
  `run({ inputs })` as plain records keyed by capability ID; a value may be a
  port. Never pass them through closures captured when an entry is created. An input must
  outlive every instance that received it. Roots of an instance do not escape
  its owner except through a facade.
- The factory context stays closed: `{ signal, scope }` from Assembly and
  `{ signal, resources }` inside `scoped()`. An input is data or one narrow
  port, never a registry with `get(key)` or a bundle of parent services. More
  than about eight inputs on one template is a reason to review its boundary.
- Keep instances that share a key in a Host map with single-flight creation;
  eviction is Host policy. Hold many independent instances under a parent
  scope created with `order: "concurrent"`.
- Tenant variants keep one stable base template; a variant lives in a nested
  template with its own inputs.
- Callers outside the owner reach a replaceable instance through one facade
  capability: begin a call, invoke, release, and refuse with an explicit
  unavailable result after retirement. Do not wrap ports in a generic Proxy.
  With the lifecycle kernel candidate, activate the new instance, switch the
  route and quiesce the old one in one synchronous step, drain by the Host's
  deadline, retire and close it, and release kernel custody only when the
  close report is complete.

<!-- consumer-standard-example: instances -->

```ts
import { assemblyFor, declareModule, defineContract, implement, input, type Assembly, type CapabilitiesOf, type ModuleFactory } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { scoped, type ModuleContext, type Resources } from "@get-modular/resources";

const SessionId = defineContract<{ readonly id: string }>()({ id: "acme/session-id", revision: 1 });
const Chat = defineContract<ChatPort>()({ id: "acme/chat", revision: 1 });
interface Capabilities extends CapabilitiesOf<typeof SessionId | typeof Chat> {}

const sessionInput = declareModule({
  moduleId: "acme/session", implementationId: "acme/session/input",
  owner: { authority: "acme", path: ["session"] }, provides: [SessionId.provide()], slots: [],
});
export const chatDeclaration = declareModule({
  moduleId: "acme/chat", implementationId: "acme/chat/default",
  owner: { authority: "acme", path: ["chat"] },
  provides: [Chat.provide()], slots: [SessionId.slot("session", required())],
});

export const createChat: ModuleFactory<Capabilities, typeof chatDeclaration, ChatPort, ModuleContext> = async (deps, { resources }) => {
  const lease = await resources.setup({
    name: "lease", setup: () => acquireLease(deps.session.id), cleanup: (held) => held.release(),
  });
  const port = createChatPort(lease);
  return { instance: port, capabilities: { "acme/chat": port } };
};

// A one-file sketch: in a consumer each entry lives at the top level of its module file.
const session = input<Capabilities>()(sessionInput);
const chat = implement<Capabilities>()(chatDeclaration, createChat, scoped);

// The template root is a function of Assembly, so `smoke` can pass its own api.
export function composeSessions(api: Assembly<Capabilities>) {
  return api.prepare({ profileId: "acme/sessions", modules: [chat], roots: { chat }, inputs: { session } });
}
// Prepared once; each session is one run with its own scope and input.
const preparation = await composeSessions(assemblyFor<Capabilities>());
if (preparation.status === "failed") { throw new ConstructionFailed(preparation); }
const { prepared } = preparation;

// `sessions` is host.child({ name: "sessions", order: "concurrent" }).
export async function openSession(sessions: Resources, id: string, signal: AbortSignal) {
  const instance = sessions.child({ name: "session:" + id }); // reserved before the first await
  const outcome = await prepared.run({
    signal, scope: instance.resources, inputs: { session: { "acme/session-id": { id } } },
  });
  if (outcome.status !== "succeeded") { // closeWithin is the Host deadline helper from Module resource scopes
    throw new ConstructionFailed(outcome, await closeWithin(instance.control, 5_000, 5_000));
  }
  return { chat: outcome.roots.chat, lifetime: instance.control }; // the caller owns the instance
}
```

### Feature layout and implementation form

These rules strengthen a consumer's profile of the organization Feature Module
Standard and are stated in its roles. Sub-features, republication and composition
contracts follow [Feature Module Standard v1.1](https://github.com/agent-teams-ai/.github/blob/f5653f5630057524a4ee44e50c16e138442a9b42/docs/architecture/feature-module-standard/v1.1.md)
(Git blob `bd949a9a670862fea851a7791fce772fdef3b4fc`, SHA-256
`cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c`), sections
"Sub-features" and "Composition contracts". Where a consumer's profile constrains
placement, the profile wins and the consumer records the mapping. A consumer whose
profile pins v1 does not nest until its profile pins v1.1.
The [module authoring guide](../guides/module-authoring.md) shows each rule with
compiled examples and the recipes for growing a feature.

1. A feature lives in `features/<feature>/{contracts, domain, application/{use-cases,
   ports}, adapters/{inbound, outbound}, composition}`. Create only the directories
   that hold real files.
2. A feature may hold sub-features at `features/<parent>/features/<child>/` to any
   depth, each with the same layout. A sub-feature is private to its parent: code
   outside the parent reaches it only through contracts the parent republishes from
   its own `<parent>.contracts.ts` (and port types from its own `contracts/`), one level
   at a time; every republication is declared where the consumer declares its
   sub-features. A feature depends on other
   features only through the public contracts of features it can see: its direct
   sub-features, its ancestors and the siblings of itself and of its ancestors.
   Downward and lateral edges stay acyclic, type-only references included; an upward
   use of an ancestor's contracts never counts. No load-time import cycle may cross
   features. A parent's map extends its sub-features' maps through `import type`.
3. `@get-modular/*` is imported only in `composition/` and in tests.
   `application/` and `domain/` never import `contracts/`, not even their own: a use
   case types its dependencies only with `application/ports/`, and the module file
   maps between them.
4. Descriptors live in `composition/<feature>.contracts.ts`, the feature's
   composition contract, imported only by composition code and tests. One declaration file per
   implementation, `composition/<module>.declaration.ts`, imports only
   `declareModule`, the cardinality helpers and contract descriptors and holds
   only the declaration. `composition/<module>.module.ts` holds only the `implement`
   wiring.
   `composition/` is flat at every depth: it has no subdirectory. A `*.contracts.ts`
   file exists only as `composition/<own segment>.contracts.ts`, or flat in the Host's
   `src/composition/`. Every `*.module.ts` imports a declaration of its own feature (a Host-level module: a Host-level declaration) and
   is owned by exactly one production file: a feature module by its feature's group; a
   Host-level module outside `features/` by one Host-level group or, when no group lists
   it, by the one root that lists it as its own entry. A root's import of a module only
   to name it in `roots` does not count when a group owns that module; several roots
   importing one Host-level module that no group lists is a violation (`group-count`). Every `*.declaration.ts` is imported by a module file or by
   `composition/<feature>.inputs.ts`, which holds the feature's input entries. No
   source file sits directly in `application/`, and a use-case file has exactly one
   runtime export, its function, and may also export types. `checkModuleLayout` reports
   each of these rules by code.
5. A use case is `application/use-cases/<verb-noun>.ts` exporting one function
   `(deps, input) => result`; `deps` is a narrow record of port types. Pure rules go in
   `domain/`, DB, SDK and HTTP code in `adapters/`.
6. A port is an object of arrow functions built by a factory function. A class is
   allowed only for a stateful adapter or a test fake: arrow-function fields, no
   prototype method on a port, `static async create` for async setup. Port members
   are own properties, which `smoke` and `isolate` check on the capabilities a
   module returns.
7. Tests, fakes and oracle parts live under the feature's test root at the path that
   mirrors the feature's path, sub-features included. Oracle parts and fakes are
   test code.
8. A feature README SHOULD carry a `## Feature card` section with the fields of the
   [guide](../guides/module-authoring.md#2-designing-a-feature): Purpose, Parent,
   Publishes, Consumes, Modules, Sub-features, Expected growth, Likely split seams and
   Split signals now (modules, use cases and depth against the consumer's
   thresholds, for example `<n>/12`, and aggregates). The split signals, the depth warning and their thresholds are
   consumer policy; the [guide](../guides/module-authoring.md#8-when-and-how-to-split)
   gives the recipes. The size limits below are this standard's.

Enforce the import and size rules with the lint rules below and the Get Modular
layout checks (`checkModuleLayout` in `@get-modular/conformance`); the oxlint
preset is not shipped, so a consumer copies this snippet and adapts the paths:

```json
{ "overrides": [
  { "files": ["src/features/**/*.ts"], "excludeFiles": ["**/*.test.ts"], "rules": {
    "max-lines": ["error", { "max": 300, "skipBlankLines": true, "skipComments": true }],
    "max-lines-per-function": ["error", { "max": 60, "skipBlankLines": true, "skipComments": true }],
    "max-params": ["error", { "max": 4 }] } },
  { "files": ["src/features/**/composition/*.module.ts"], "rules": {
    "max-lines": ["error", { "max": 80, "skipBlankLines": true, "skipComments": true }] } },
  { "files": ["src/features/**/contracts/**", "src/features/**/domain/**", "src/features/**/application/**",
              "src/features/**/adapters/**"], "rules": {
    "no-restricted-imports": ["error", { "patterns": [
      { "group": ["@get-modular/*"], "message": "Get Modular is imported only in composition/ and tests" }] }] } },
  { "files": ["src/features/**/composition/*.declaration.ts"], "rules": {
    "no-restricted-imports": ["error", {
      "patterns": [{ "group": ["*", "!@get-modular/assembly", "!@get-modular/core",
        "!*.contracts.js", "!*.contracts.ts"],
        "message": "a declaration imports only declareModule, cardinality helpers and contract descriptors" }],
      "paths": [
        { "name": "@get-modular/assembly", "allowImportNames": ["declareModule"] },
        { "name": "@get-modular/core", "allowImportNames": ["required", "optional", "many"] }] }] } }
] }
```

The size limits are the owner's decision: 80 lines for `*.module.ts`, 300 for any other non-test file of an
adopted feature, 60 for a function and 4 parameters, with blank lines and comments not
counted and tests exempt. The rule that `application/` and `domain/` never import
`contracts/`, not even their own, is not expressed by this snippet and is not part of
`checkModuleLayout`: the consumer's Feature Module Standard checks enforce it (its own
checker, or the Feature Module Standard package of Engineering Foundation once
released), and review covers it until they run.

### Feature groups

A feature exports one static group of its modules. Assembly knows no features:
the group is [ADR-0036](../decisions/0036-compose-roots-from-module-entries-and-static-groups.md)'s
`group(name, members)`, and a name is a navigation label that never enters the
profile, the plan or the digest.

1. `composition/<feature>.group.ts` exports `<feature>Group`, a module-level constant
   made with `group("<feature segment>", [...])`: one member per line, sorted by imported
   name, each imported by name, with no conditional member. When an entry of the
   feature closes over Host-level values, the file instead exports
   `create<Feature>Group(values)`, which takes only those values and returns the same
   static list.
2. The group tree mirrors the feature tree. A parent's group lists its own modules and
   the groups of its direct sub-features; a group's name is its feature's own path
   segment, so `groupPath` in an `unresolved-binding` cause reads like the feature path.
3. A root's `modules` lists the groups of top-level features, Host-level groups and its
   own entries, and nothing else. It never lists a module of a feature, and never the
   group of a sub-feature, which is private to its parent. A root file is
   `src/composition/<root>.root.ts`. Groups own modules: a feature's group owns that
   feature's modules, and a Host-level group, `src/composition/<name>.group.ts`, owns
   the Host-level modules it lists, so several roots, such as variants, can share them.
   A root imports a module file only to name that entry in `roots`; that import does not
   count when a group owns the module, and the entry stays listed in its group and
   nowhere else in `modules`. A root owns the Host-level modules outside `features/`
   that no group lists and that it lists as its own entries
   (`src/composition/<module>.declaration.ts` and `<module>.module.ts`), directly in
   its `modules`; one such module belongs to one root.
4. The list a root passes to `prepare` never depends on run-time values; a variant is
   a separate root with its own `profileId`. Names are labels, never identities.
5. An entry listed twice, or two entries with one `implementationId`, fail with
   `assembly.prepare.duplicate-module` before any factory runs.
6. A merge conflict in a group keeps both lines.

The [guide](../guides/module-authoring.md#13-groups-and-the-root) shows the group files and the root.

### Module packages and contracts

[ADR-0032](../decisions/0032-give-assembly-an-authoring-builder-and-capability-scoped-handles.md)
gives Assembly the authoring builder and
[ADR-0036](../decisions/0036-compose-roots-from-module-entries-and-static-groups.md)
module entries and groups.

Contracts:

- A contract owner publishes one descriptor per capability with
  `defineContract<Value>()({ id, revision })` from a contract package that
  holds descriptors and port types, not implementations.
- Raise `revision` with every change of the value type, additive changes
  included, and never change what a published revision means. A capability ID
  is permanent: do not start a parallel line such as an ID ending in `/v2`.
- In the current wire generation a provider and every consumer of a capability
  use the same revision, and Core rejects a mismatch as
  `binding.compatibility-mismatch`. A later generation adds a window of
  consumer revisions that a provider still serves; declarations and maps
  written with the builder keep working, only the builder and Core change.
- A module package lists the contract packages it provides or consumes as
  ordinary dependencies; that version fixes the revision the module was built
  against. Whenever a contract package raises a revision, it releases a version
  that a caret range does not accept: a new minor while it is 0.x, a new major
  from 1.0.
- Declare port members as function-typed properties, not methods: TypeScript
  checks method parameters bivariantly and accepts a breaking change silently.
  The line applies to `contracts/` and `application/ports/`. Enforce it with one
  oxlint line for every file that declares a contract or port value type, or for
  the whole repository:
  `"typescript/method-signature-style": ["error", "property"]` (ESLint users: the
  typescript-eslint rule of the same name). The rule cannot see a value type
  inferred from an implementation such as `ReturnType<...>`; declare contract
  value types explicitly.

Module packages:

- Declarations use `declareModule` with `Contract.provide()` and
  `Contract.slot(slotId, cardinality)`. Never write `kind`, `schemaVersion` or a
  `compatibility` literal by hand; the builder emits the current wire
  generation.
- A module is a declaration file and one entry made with
  `implement<its feature map>()(declaration, factory, scoped)` in its module
  file. The factory is written inline in `implement`, which infers its types, or, when
  exported on its own, typed
  `ModuleFactory<its map, typeof declaration, Instance, ModuleContext>`; it takes
  the `scoped` adapter when it reads `resources`. The entry is created once,
  at the top level of the module file, and listed in its feature's group
  ([Feature groups](#feature-groups)). A factory that closes over Host-level values
  gets its entry from a function of the composition adapter whose module list
  never depends on them. A module never imports the Host's map. A feature's map
  is an interface that extends the maps of the features it uses, one member per
  line, through `import type`.
- Name a map derived from many contracts as an interface:
  `interface HostCapabilities extends CapabilitiesOf<typeof A | typeof B> {}`.
  A type alias over hundreds of contracts multiplies check time and reaches
  TS2589 on TypeScript 5.8.3.
- A Host prepares with a map that contains every capability any entry uses,
  with the identical contract.
- Module packages list Get Modular packages only in `peerDependencies`, with a
  range of one 0.x minor such as `^0.5.0`, and pin exact versions in
  `devDependencies` for their own tests. A Host installs one copy of each Get
  Modular package. Widen a range only when the release notes of the newer
  minor say that the authoring surface did not change.
- A breaking minor of a Get Modular package ships its migration note, and a codemod
  when the change is a mechanical rename, move or call-shape edit. Codemods live in
  the Get Modular repository under `architecture/tooling/codemods`, not in a package.
  From a checkout with dependencies installed, apply one with
  `pnpm --dir <get-modular checkout> codemod <from>-<to> <consumer dir> --write`
  (`--dry` previews, `--check` exits 1 while a change is pending; `--write` refuses
  a dirty Git tree, or a directory outside Git, unless `--allow-dirty`), then typecheck.
- Identify errors by `code`, never by class or message:
  `assembly.<area>.<reason>`, `resources.<area>.<reason>` and
  `conformance.<area>.<reason>`. Core diagnostics carry their catalog codes in
  `Diagnostic.code`.

#### Module template

Copy this for a new module in the layout above; replace `acme/counter` and `acme/store`
with your identities and your own features. The blocks are one project, each
named by its first line: the store feature's port type and descriptor, then the counter
feature's port type, its own `application/ports/` type, use case, descriptors,
declaration, module, group, the oracle part and the module test, the Host-level store
module (declaration and module, flat in `src/composition/`), the root, and the root test
with `smoke`, `checkWiring` and `checkNamespaces`. The store feature has no module
here; the Host supplies a stand-in.

<!-- consumer-standard-example: template -->

```ts
// src/features/store/contracts/store.ts
// A contract owner publishes port types with function-typed properties.
export type StorePort = { readonly bump: (key: string) => number };
```

```ts
// src/features/store/composition/store.contracts.ts
import { defineContract, type CapabilitiesOf } from "@get-modular/assembly";
import type { StorePort } from "../contracts/store.js";

// The descriptor and the feature's map: composition code imports this file, nothing else does.
export const Store = defineContract<StorePort>()({ id: "acme/store/store", revision: 1 });
export interface StoreCapabilities extends CapabilitiesOf<typeof Store> {}
```

```ts
// src/features/counter/contracts/counter.ts
export type CounterPort = { readonly increment: (key: string) => number };
```

```ts
// src/features/counter/application/ports/store.ts
// The use case types what it needs with its own port; the store feature's port satisfies it structurally.
export type StoreForCounter = { readonly bump: (key: string) => number };
```

```ts
// src/features/counter/application/use-cases/increment-counter.ts
import type { StoreForCounter } from "../ports/store.js";

export type IncrementCounterDeps = { readonly store: StoreForCounter };

export function incrementCounter(deps: IncrementCounterDeps, input: { readonly key: string }): number {
  return deps.store.bump(input.key);
}
```

```ts
// src/features/counter/composition/counter.contracts.ts
import { defineContract, type CapabilitiesOf } from "@get-modular/assembly";
import type { CounterPort } from "../contracts/counter.js";
import type { StoreCapabilities } from "../../store/composition/store.contracts.js";

export const Counter = defineContract<CounterPort>()({ id: "acme/counter/counter", revision: 1 });
// One member per line: the map extends the maps of the features it uses.
export interface CounterCapabilities extends
  StoreCapabilities,
  CapabilitiesOf<typeof Counter> {}
```

```ts
// src/features/counter/composition/counter.declaration.ts
import { declareModule } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { Store } from "../../store/composition/store.contracts.js";
import { Counter } from "./counter.contracts.js";

// Only the declaration: inert, no side effects.
export const counterDeclaration = declareModule({
  moduleId: "acme/counter/counter", implementationId: "acme/counter/counter/default",
  owner: { authority: "acme", path: ["counter"] },
  provides: [Counter.provide()], slots: [Store.slot("store", required())],
});
```

```ts
// src/features/counter/composition/counter.module.ts
import { implement } from "@get-modular/assembly";
import { incrementCounter } from "../application/use-cases/increment-counter.js";
import type { CounterPort } from "../contracts/counter.js";
import type { CounterCapabilities } from "./counter.contracts.js";
import { counterDeclaration } from "./counter.declaration.js";

// Only wiring: the module file maps ports to use cases. Add `scoped` as the third argument when the
// factory needs `resources`.
export const counterModule = implement<CounterCapabilities>()(counterDeclaration, async (deps) => {
  const port: CounterPort = { increment: (key) => incrementCounter(deps, { key }) };
  return { instance: port, capabilities: { "acme/counter/counter": port } };
});
```

```ts
// src/features/counter/composition/counter.group.ts
import { group } from "@get-modular/assembly";
import { counterModule } from "./counter.module.js";

// One module per line, sorted. The root lists this group, never the module.
export const counterGroup = group("counter", [
  counterModule,
]);
```

```ts
// src/composition/memory-store.declaration.ts
import { declareModule } from "@get-modular/assembly";
import { Store } from "../features/store/composition/store.contracts.js";

// A Host-level module sits flat in src/composition/, listed directly in a root's `modules`.
export const memoryStoreDeclaration = declareModule({
  moduleId: "acme/store/memory", implementationId: "acme/store/memory/default",
  owner: { authority: "acme", path: ["store"] }, provides: [Store.provide()], slots: [],
});
```

```ts
// src/composition/memory-store.module.ts
import { implement } from "@get-modular/assembly";
import type { CounterCapabilities } from "../features/counter/composition/counter.contracts.js";
import { memoryStoreDeclaration } from "./memory-store.declaration.js";

export const memoryStoreModule = implement<CounterCapabilities>()(memoryStoreDeclaration, async () => ({
  instance: undefined, capabilities: { "acme/store/store": { bump: (key: string) => key.length } },
}));
```

```ts
// src/composition/production.root.ts
import type { Assembly } from "@get-modular/assembly";
import type { CounterCapabilities } from "../features/counter/composition/counter.contracts.js";
import { counterGroup } from "../features/counter/composition/counter.group.js";
import { counterModule } from "../features/counter/composition/counter.module.js";
import { memoryStoreModule } from "./memory-store.module.js";

// A root lists feature groups and its own Host-level entries, nothing else, and never builds the list
// conditionally. It imports `counterModule` only to name that entry in `roots`; the entry stays listed in
// its feature's group.
export const productionModules = [counterGroup, memoryStoreModule] as const;

// A root is a function of Assembly, so `smoke` can pass its own api.
export function composeProduction(api: Assembly<CounterCapabilities>) {
  return api.prepare({ profileId: "acme/production", modules: productionModules, roots: { counter: counterModule } });
}
```

```ts
// tests/features/counter/counter.wiring.ts
import type { WiringOracle } from "@get-modular/conformance";

// Written from the decision, never copied from `describeWiring` or from test output.
export const counterWiring: WiringOracle = {
  providers: { "acme/counter/counter": "acme/counter/counter/default" },
};
```

```ts
// tests/features/counter/counter.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isolate } from "@get-modular/conformance";
import { counterModule } from "../../../src/features/counter/composition/counter.module.js";

test("counts through the real construction path", async () => {
  // Fakes are typed values from the contract owner, never `any` or a cast.
  await using counter = await isolate(counterModule, { dependencies: { store: { bump: (key) => key.length } } });
  assert.equal(counter.capabilities["acme/counter/counter"].increment("abc"), 3);
});
```

```ts
// tests/module/production.root.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { assemblyFor, entriesOf } from "@get-modular/assembly";
import { checkNamespaces, checkWiring, smoke, type WiringOracle } from "@get-modular/conformance";
import type { CounterCapabilities } from "../../src/features/counter/composition/counter.contracts.js";
import { composeProduction, productionModules } from "../../src/composition/production.root.js";
import { counterWiring } from "../features/counter/counter.wiring.js";

// The root's own decisions: the store provider and the root implementations.
const rootWiring: WiringOracle = {
  providers: { "acme/store/store": "acme/store/memory/default" },
  roots: ["acme/counter/counter/default"],
};
const declarations = entriesOf(productionModules).map((entry) => entry.declaration);

test("the root builds and cleans up after a failure at every module", async () => {
  await smoke({ api: assemblyFor<CounterCapabilities>(), compose: composeProduction });
});

test("the root wires what the oracle states", async () => {
  const preparation = await composeProduction(assemblyFor<CounterCapabilities>());
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") { return; }
  checkWiring(preparation.composition, [counterWiring, rootWiring], { declarations });
});

test("identities lie in the product namespace", () => {
  checkNamespaces({ namespace: "acme", declarations });
});
```

Once a second implementation of Counter exists, run the contract owner's suite against both with
`runContractSuite(counterSuite, subject, test)`.

### Identity and namespaces

Core validates identity syntax and rejects collisions inside one compilation;
it authenticates nothing.

1. A namespace is one or more leading whole segments of a portable ID.
   Membership holds only at a segment boundary,
   `id === namespace || id.startsWith(namespace + "/")`, so `agent` never covers
   `agent-runtime/x`.
2. `moduleId` and `implementationId` lie in the namespace of the product that
   supplies the code. Within one release of that product, declarations with
   different slots or provides never share an `implementationId`, even in
   different compositions. A module keeps its `implementationId` across
   releases, also when a later release changes its slots or provides, and
   raising a contract revision keeps every `implementationId` that uses it.
3. A `capabilityId` lies in the namespace of the contract owner, the product or
   context that defines the port, not of the provider. The owner publishes the
   descriptor and, for a contract that others implement, its suite and fake.
4. A namespace names a stable semantic owner, a product or bounded context,
   not a team, repository, package or directory. Inside it, use
   paths such as `<product>/<context>/<name>`; a module created in a sub-feature
   uses `<product>/<feature>/<sub-feature>/<name>`.
5. IDs are immutable and never reused. A renamed module or contract is a new
   identity migrated through complete profiles. Core and Assembly have no
   aliases and no override by ID.
6. `owner.authority` is a navigation label equal to the first segment of
   `moduleId`. It confers no ownership or permission.
7. Session, tenant and instance IDs never enter module IDs; they name scopes
   or run inputs.
8. Id segments are a namespace at creation time, not a path. The FMS identity of a
   feature (its path) and a Get Modular id are different concepts, and
   `checkNamespaces` never compares ids with paths. By rule 5 an id does not
   change when files or features move.

Check rule 1, the namespace part of rule 2 and rule 6 in a test with
`checkNamespaces` from `@get-modular/conformance`, over every declaration the
product supplies, its input modules and fakes included: the declarations of
`entriesOf(modules)` plus those of the input entries and fakes. That list is wider
than the one `checkWiring` takes (testing rule 6).

### Testing modules

[ADR-0033](../decisions/0033-admit-the-module-conformance-kit.md) admits the
kit `@get-modular/conformance`.

1. Make each module one entry with `implement<feature map>()(declaration,
   factory, scoped)` at the top level of its module file, with the factory written inline or typed
   `ModuleFactory` by the module's own contract map, and `scoped` as the adapter
   when it takes `ModuleContext`. Production, the group and the tests use that
   one entry.
2. Type fakes with `FactoryDependencies<C, typeof declaration>`. No `any`,
   `as never` or double cast on a dependency record.
3. The contract owner keeps one fake per contract that others implement and a
   suite created with `contractSuite(contract, cases)`, published from an
   entrypoint that production code does not import. The fake and every
   implementation pass that suite through `runContractSuite`, which takes any
   `(name, body)` registrar as `test`, such as `node:test` `test` or Vitest `it`.
   From inside a `node:test` test, pass `(name, body) => t.test(name, body)`; an
   unbound `t.test` crashes. A suite covers errors and cancellation,
   not only success, and is required once a capability has two implementations,
   the fake included.
4. Test one module with `isolate(entry, { dependencies })` and release it with
   `await using`; a debt fails the test. `isolate` passes each dependency as a run
   input: it requires one own property per slot (an array for `many`) and never runs
   the port check on it.
5. Write each production composition root as a function of `Assembly<C>`. One
   `smoke` test per root prepares it once, fails and aborts construction at
   every module and requires every attempt scope to close complete. `smoke`
   rebuilds every entry and group with `implement` and `group` and prepares the
   rebuilt tree through the `api` it passes to `compose`; it rejects when
   `compose` resolves with a preparation that api did not produce. Entries and
   groups are module-level constants, or are created by a composition-adapter
   function whose list never depends on run-time values. Effectful leaves use their owners' fakes.
   A root that prepares with `{ profileId }` lists its modules statically: the
   list does not depend on run-time values, and a variant is a separate root
   with its own `profileId`, `smoke` and oracle.
6. `smoke` does not prove wiring. Keep the independent binding oracle from the
   table above, and never derive expected bindings from the profile, the plan,
   `describeWiring` or the implementation. The oracle states wiring decisions
   ([ADR-0037](../decisions/0037-pin-providers-not-completed-rows-in-the-binding-oracle.md)):
   for each capability a selected module provides, the implementation or
   implementations that provide it; the root implementations; inputs pinned like
   providers; and every row that completion does not produce (`optional`, `many`
   and explicit rows) as written. Call
   `checkWiring(composition, oracles, { declarations })` with the declarations of
   exactly the plan's selections: those of `entriesOf(modules)` and of the root's
   input entries. A declaration that is not selected, such as a fake's, fails
   `declaration-selection`. It fails on: selections that differ from the pinned providers plus the roots
   (`selection`; a pinned provider that is not selected also fails
   `capability-provider`); plan roots that differ (`root`); declarations that do not
   cover the plan selections (`declaration-selection`); a capability a selected
   module provides that the oracle does not pin to that implementation
   (`provided-capability`); a pinned implementation that does not
   provide its pinned capability in its declaration (`pinned-provider`); a
   listed row that differs from its plan row, order included; an unlisted row
   that is not a `required` slot bound to the single pinned provider of its
   capability (`unlisted-row`); and a plan row that uses another slot or
   capability than its consumer's declaration. A feature may keep its own
   oracle part; equal duplicates across parts are allowed, a conflict fails.
   Oracle parts are test code. Roots are the root's decision: keep them in the root
   test's own part, not in a feature part. A new `required` slot bound to the single pinned
   provider of its capability needs no oracle change; review it as a
   declaration change. `describeWiring` is for debugging only.
7. Port members are own properties. `smoke` and `isolate` check the capabilities a
   module returns and fail with `conformance.ports.prototype-member` on a function or
   accessor that lives on a prototype, such as a class method: build the port as an
   object of arrow functions, or wrap a class instance in one. The check does not
   see an object-literal method that uses `this`, a method extracted unbound, a
   nested object, own accessors on the capability itself, a run input or a fake you
   pass as a dependency; those stay review rules. A `Map` capability passes; a `Map`,
   `Date` or `Buffer` from another realm is reported. The walk reads descriptors only, but
   Proxy traps run during it. A negative test is a module whose capability is a class
   instance with a method.
8. `guardHandles` is a per-file diagnostic, and `complete` is not proof of
   physical release. Check real adapters in disposable TEST projects.
9. Close every scope a test creates. No sleeps; use the test runner's
   timeouts and mock timers for deadlines.
10. A feature's tests import only its own code, the public surfaces and
    `testing.ts` of features it may see, and Get Modular; they live at the path
    that mirrors the feature, and a sub-feature's at the mirrored path.

### Scoped acceptance and evidence

An adopting consumer must provide an accepted local decision and a profile with:

- Central document and organization authority pins; exact reviewed package and
  lock/archive identities under existing package policy.
- Declared production roots, active wiring scope, owner, materialized entrypoint,
  declaration/profile/factory paths, dependency mechanism and test mapping.
- Exact existing legacy boundaries and direct relationships, marked `not-adopted`,
  with rationale, owner and review trigger. This inventory is not an FMS
  violation baseline and must not weaken an existing activation's prohibition
  on grandfather lists.
- Exact accepted exceptions with rule, paths, owner, rationale, decision and
  review trigger. No wildcard, blanket directory exemption or automatic legacy
  inventory expansion. Reject stale entries.
- Actual blocking commands, reciprocal references and evidence for the precise
  claimed slice. Package installation or a successful library test is not
  consumer adoption evidence.

At activation, the consumer gate must discover new production boundaries through
its existing topology/source inventory. Unknown boundaries fail until explicitly
adopted or classified. New cross-module or replaceable relationships inside a
legacy boundary require current adoption or an exact accepted exception. An
ordinary fixed-dependency classification is valid only inside its owning feature.
The gate must reject drifted pins, missing paths, removed/no-op command chains and
unknown or stale exceptions. These requirements become an enforced consumer claim
only with positive and rejecting fixtures in that consumer's fast and full gates.
This documentation checkpoint does not claim that a consumer checker exists.

Evidence includes unchanged existing FMS scope, adopted wiring, allowed private
helpers and declared legacy; rejection of unknown boundaries, new direct legacy
edges, invalid exceptions, pin drift and forbidden layer imports; typed rejection
of wrong capability/token/slot and a missing await on an async Host constructor; independent
binding parity, zero factories on preparation failure, attempt isolation and
Host failure/cancellation ownership; and packed imports through public roots on
exact approved artifacts in a disposable directory. Semantic review must also
look for new capabilities hidden inside existing functions: a static inventory
does not prove all ownership or domain design rules.

### Executable examples and adoption status

The existing [synthetic Host source](../../tests/assembly/fixture.mjs)
and [runtime assertions](../../tests/assembly/runtime.test.mjs) exercise
required, optional and ordered-many bindings, sharing and Host cleanup.
[Preparation regressions](../../tests/assembly/preparation.test.mjs)
check invalid wiring before effects; [typed fixtures](../../tests/assembly/types.test.mjs)
and the [packed consumer](../../tests/assembly/packed-consumer.mjs)
cover the public carrier. The [resource scope tests](../../tests/resources/assembly-scope.test.mjs),
[input tests](../../tests/assembly/inputs.test.mjs), [builder tests](../../tests/assembly/builder.test.mjs),
the [example compile test](../../tests/assembly/consumer-standard-examples.test.mjs)
for the examples of this document and of the [module authoring guide](../guides/module-authoring.md) and the [packed conformance consumer](../../packages/conformance/tests/packed-root.test.mjs)
extend them, with the [profile completion tests](../../tests/assembly/profile-completion.test.mjs). These belong to the existing `pnpm assembly:test`, `pnpm resources:check`
and `pnpm conformance:check` commands, invoked by both fast and full gates, after
`pnpm assembly:build`.
Consumers must additionally link their own executable slice and independent
binding oracle; copied Markdown examples do not count as evidence.

Agent Runtime has accepted static Core/Assembly adoption for passive setup and
ordinary-session composition in [Agent Runtime PR #168](https://github.com/agent-teams-ai/agent-runtime/pull/168),
merged as `3cd722f607e1643b809f6946ee303a5a94469171`. This reciprocal reference
records only that accepted passive scope; contained-turn and dynamic plugin
runtime scope are not admitted. The consumer records its current standard pin
in its own profile.
Core self-composition and synthetic/packed Hosts remain library evidence, not
independent production consumers. This reference does not establish
repository-wide conformance. Full legacy conversion and shared checker
extraction require separate scope.

## API and metadata ownership

`assemblyFor<C>()` selects capability value and compatibility identities at type
level; `C` is a Host map or a module's own map, usually derived with
`CapabilitiesOf`. It stores no service registrations or instances.
`implement<C>()(declaration, asyncFactory, adapter?)` returns an
identity-authenticated module entry, a frozen null-prototype
`{ declaration, factory }`, and `input<C>()(declaration)` an input entry
`{ declaration }`. A private WeakSet authenticates each kind; copying descriptors,
symbols, prototype or fields cannot forge one. This is identity checking, not code
authorization. The optional `adapter` turns a factory written for another context
into one for `FactoryContext`: Assembly calls `adapter(implementationId, factory)`
once, and `scoped` from `@get-modular/resources` is the only admitted adapter.
`group(name, members)` creates a frozen static list of entries and groups, and
`entriesOf(modules)` returns the entries of a module list depth first
([ADR-0036](../decisions/0036-compose-roots-from-module-entries-and-static-groups.md)).

`implement` and `input` synchronously snapshot declaration metadata and capture the
function before returning. The original is neither frozen nor read again.
Preparation and execution use this same snapshot. Mutation from required to many
must never change an existing callback's injection contract. Malformed metadata
causes a stable binding error before any factory call, `assembly.bind.invalid-declaration`,
`assembly.bind.limit` or `assembly.bind.invalid-factory`; a broken group fails at
creation with `assembly.bind.invalid-group`. Core owns semantic rules.

`prepare({ profileId, bindings, modules, roots, inputs })` completes the profile
from the entries ([ADR-0035](../decisions/0035-complete-composition-profiles-in-prepare-and-make-capabilitiesof-linear.md)):
`modules` is a tuple of entries and groups, so an annotated array is rejected at
type level; selections are all module and input entries, roots are module entries
reached through `modules`, and an explicit row in `bindings` is kept as written. A
`required` slot without a row binds to the single other entry that provides its
capability id, at any revision (Core still rejects a revision mismatch as
`assembly.prepare.core-rejected`). Any other slot without a row (`optional`,
`many`, or `required` with zero or several candidates) fails with
`assembly.prepare.unresolved-binding` before any factory runs; `error.cause` lists
every such slot with its candidates and the `groupPath` of its consumer. An
`optional` slot always needs a row: `[]` or one provider. Completion does not
depend on the order or the nesting of `modules`, `roots` or `inputs`. A `"prepared"` result also carries the compiled
`composition`. Give exactly one of `composition` and `profileId`.
From Assembly 0.4.0, production composition roots use `profileId`;
`prepare({ composition })` remains for a Host that compiles a profile itself,
such as from bytes or a desired profile, and for `isolate`.

`prepare({ composition, modules, roots, inputs })` accepts a successful Core
result, the exact selected module entries (a plain `readonly` list is accepted
here, because a Host that compiles its own profile builds the list at run time and
Core checks the plan), an alias-to-root-entry mapping and an alias-to-input-entry
mapping. Module and input entries together are unique and cover every selection
exactly once; an input entry appears only in `inputs` and is never a root
(`assembly.prepare.input-handles`); an uncovered or forged selection stays
`assembly.prepare.handles`. In both forms an entry reached twice, two entries with one
implementation id, an input entry under two aliases, or an input entry that shares an
id with a module entry fail with `assembly.prepare.duplicate-module`, whose `cause`
lists every duplicated id with its group paths and input aliases. Each root has exactly one alias and refers
to the same supplied entry. No extra entries or alias getters.

An entry is invariant in the capabilities its declaration uses: preparation
accepts it only when each of them has the identical value and compatibility type
in the preparing map, and every capability any entry uses is part of that map.
Literal declaration inference is controlled by
the declaration, not widened by the callback. Required slots yield `T`, optional
slots an own field `T | undefined`, and many slots a frozen `readonly T[]`.
Widened declarations do not confer a statically precise injection contract.

Factories receive only their closed dependency record and `{ signal, scope }`.
`scope` is the value passed to `run()`; Assembly delivers it unchanged and never
inspects, awaits, freezes or disposes it. Each
fulfills with `{ instance, capabilities }`. Instance is for Host, including roots
without provides. Capabilities has exactly the declaration's own capability keys.
Injection selects by provider implementation ID AND capability ID, never instance
as fallback. A present capability with value `undefined` is distinct from a missing
key. Different capabilities and instance may be three different objects.

## Preparation and resource envelope

Before the first await, capture the successful result or the `profileId` and
`bindings`, the module tree, root map and input map.
Inspect own data descriptors, dense arrays and exact shapes without invoking
getters. Pre-count individual and aggregate sizes before proportional copying.
Reject unexpected keys before projecting the supplied plan into a profile. Flatten
`modules` depth first, counting group nodes and entries against the same
ceiling.

The local carrier ceiling for the supported Core pair is: 4096 entries and group
nodes, selections and order entries; a group holds at most 4096 members and groups
nest at most 16 levels with `modules` as level 0; 1024 roots; 65536 bindings; 1024 providers per row; 262144 provider
occurrences overall. Declarations have at most 64 provides and 128 slots each,
65536 of each overall; owner paths at most 8 segments. Every metadata identifier
has at most 128 UTF-8 bytes. Root and input aliases are each bounded to 128 UTF-8 bytes and 1024
entries. Validate alias own-key counts too. These are structural allocation
ceilings, not another graph engine. No private Core imports. Changes to supported
Core require rechecking this table against its successful-plan envelope.

With `profileId`, complete the profile from the captured entries and the captured
`bindings`, counting rows and provider occurrences against the same ceilings first,
and compile it once through public `compileComposition`; the returned plan is the
prepared plan and there is nothing to compare it with.

Otherwise restore a complete profile from the captured plan and invoke public
`compileComposition` on captured entry declarations. Compare the entire returned
plan and digest to the supplied snapshot, including every ordering, capability and
compatibility field. Core alone validates grammar, cardinality, graph closure and
canonical order. Use fixed-schema comparison, not user `toJSON`/serialization.
No product factory is called until every binding and root passes. Expected
preparation failures return a discriminated result, preserving Core diagnostics
separately. Unexpected pre-effect internal errors may reject preparation.

Prepared state contains only immutable instructions and function references.
Metadata is cooperative Host-owned data. Reflection on executable Proxy objects
may run code; these are not safe data. Modified intrinsics, arbitrary heap pressure
and a fixed wall-clock bound are outside the contract. No raw-byte input ceiling
is misrepresented as an enriched plan ceiling.

## Execution and Promise carrier

`prepared.run({ signal, scope, inputs })` is async and sequential in
dependencyOrder. Every input is checked before the first factory. Exactly one
invocation per selected non-input implementation per attempt; an input value is
borrowed for the attempt. Many injection preserves
providerImplementationIds order. Diamond consumers share capability references
within an attempt; repeats, concurrent and finite nested runs have separate maps,
ordered journals and cursors. Host factories may themselves return singletons;
assembly cannot guarantee otherwise.

Dependencies, many arrays, metadata and journals belong to assembly and are
frozen. Dependency/capability records have null prototypes and exact own keys.
Instance objects, capability values, causes, closures and signals remain opaque,
are not deeply frozen, logged or copied. Library internals never await a nested
capability, including one with a callable `then`.

The supported factory carrier is a current-realm Promise with ordinary
Promise.prototype and no own string properties, under unmodified intrinsics.
Own symbol data properties used by Node async context tracking are permitted and
ignored; symbol accessors are rejected without invocation. Inspect
its prototype/own descriptors before intrinsic Promise observation; reject a
constructor getter without invoking it. Direct thenable objects and subclasses are not
supported or assimilated. Intrinsic observation verifies the internal brand.
Observe fulfillment inside a safe ordinary wrapper, never resolving another
Promise with the raw product. Promise resolution performed by the factory itself
(for example `async () => thenable`) is factory execution and outside the library's
no-assimilation promise.

## Outcomes and ownership transfer

Outcomes are closed unions: succeeded with typed roots and created; failed with
phase, stable code, implementation ID when applicable, original cause and created;
cancelled with reason and created. A failed outcome separately records observed
cancellation. Phase `inputs` reports invalid run inputs
(`assembly.run.invalid-inputs`) before any factory call. Inputs never appear in
created. Each created entry carries module ID, implementation ID, instance and a
snapshot of its capabilities, in creation order.

Immediately after fulfillment, retain the raw current product until its journal
entry is committed. Malformed completion or an internal error in this interval
returns previous created AND the same untransferred returned product/implementation
ID. After commit it appears exactly once in created. No later factory or library
cleanup runs after failure. Memory exhaustion preventing the failure result itself
and process termination are outside this handoff guarantee.

Resources not returned by a rejected factory belong to that factory or its
Host-owned resource owner. Host defines cleanup policy. The optional resources
package gives that owner an ordered mechanism; Assembly still performs no
disposal. A journal entry is not a
claim of independent resource ownership: do not dispose the same shared resource
through provider, consumers and multiple capability references.
The resource owner is known before construction handoff and registers cleanup
at acquisition; receiving a capability gives no cleanup authority. An async
provider remains responsible for allocations it fails to hand back. A one-shot
Host uses roots within their protected lifetime and returns an inert summary
after cleanup, not graph references to the closed scope. Opaque failure causes
remain opaque; a summary does not certify that those causes contain no references.

A new profile does not update previously delivered references. Construction
success remains distinct from Host readiness and lifecycle publication.

An already aborted signal yields cancelled with no calls. Check before each
factory and before success commit. Await an already running factory after abort;
no Promise.race with cancellation. Valid late fulfillment is recorded in the journal then returns
cancelled; rejection, invalid fulfillment or an internal error returns failed,
with cancellation recorded separately. An uncooperative pending factory can keep
run pending; Host owns deadlines and isolation. Terminal outcomes do not change.

## Delivery phases and ownership

- A0: record ADR/package admission and this reviewed contract. Preserve accepted
  history. Integrator owns documentation, authority and repository-wide guards.
- A1: implementation worker owns packages/assembly and its private build entry.
  Include manifest, workspace dependency, tsconfigs, build/typecheck/test commands
  and source mapping alongside the first substantive preparation code. No run stub
  or unusable standalone checkpoint. Integrator connects shared root gates.
- A2: same feature owner implements execution and the synthetic vertical slice.
  A1/A2 may be one coherent review checkpoint when the public API needs both.
- A3: packed consumer, minimum/build TypeScript checks, final independent review,
  docs and full repository gate. No publication or real Agent Runtime migration
  follows merely from this assembly implementation checkpoint.

The synthetic Host has store, filters a/b sharing store, and root app with required
store, optional logger and ordered-many filters [b,a]. Prove order-dependent output,
then a second profile with logger and reversed many. Show Host-owned cleanup after
failure without duplicate resource disposal. Core's retained consumer example is
historical evidence and is not overwritten.

## Definition of done

- Full-plan tampering, missing/duplicate/extra/forged entries, incomplete roots and
  late invalid bindings refuse with zero factory calls. Digest/order/capability
  changes refuse. Explicit absent optional binding is required.
- Snapshot mutation after bind and immediately after prepare cannot change wiring;
  getter counts stay zero for supported malformed records.
- Test individual boundary/plus-one sizes and aggregate provider overflow before
  compiler calls, including actual Core acceptance at the supported upper bound.
- Required/optional/many shapes, several distinct capabilities, roots without
  provides, sharing, many order and defined-undefined values behave as specified.
- Pending factories prove sequentiality; repeated/concurrent/nested attempts stay
  isolated. No import-time product factory calls or runtime fallback.
- Throw, primitive rejection, malformed completion, controlled internal failure
  before journal commit, and every abort/settlement ordering preserve ownership.
- Reject unsupported direct thenable and own-constructor-getter Promise without
  executing either; opaque instance/capability then methods remain untouched.
- Positive typed consumer uses no wiring casts/any; negative fixtures reject wrong
  capability/compatibility, undeclared slots, mutable many, widened declarations,
  callback inference widening and incompatible mappings. Test minimum TS 5.8.3 and
  pinned build compiler, resolver modes, and a large literal declaration fixture;
  builder-generated declarations, fragment entries created under different maps,
  rejection of unknown capabilities, and a 500-entry fixture of 20 groups on both
  compilers.
- Packed-root consumer installs only supported files/dependencies and runs the
  synthetic Host. Core never imports assembly; no development tooling leaks.
- Focused assembly gates, check:changed, check:fast, one final full check and
  independent exact-source review pass. Record evidence and remaining limitations.

## Historical Core evidence and current admission

The [assembly admission checker](../../architecture/checks/assembly-admission.mjs)
authenticates ADR-0023 and the admitted manifest before separating Assembly paths
from the unchanged Core scope. Under
[ADR-0024](../decisions/0024-separate-historical-m2-lock-custody-from-current-dependencies.md),
current admission checks the exact workspace importers and Assembly-to-Core edge;
root tooling resolutions evolve under current dependency and frozen-install gates.
The separately authenticated historical M2 lock witness preserves the original
ledgers, verifier and retained test bytes. The legacy direct reader retains its
strict reconstruction without coupling current admission to the historical lock.

[Admission regressions](../../tests/assembly-admission.test.mjs) reject graph drift,
changed authority and packages outside the admitted scope. The current
[retained replay adapter](../../tests/assembly-admission-retained.test.mjs) preserves
the historical cases and explicitly proves that the old verifier still rejects
current lock bytes without the authenticated transition. This finite transition
does not itself establish current installation readiness or change historical evidence.

Public Assembly 0.1.0 admission additionally authenticates
[ADR-0025](../decisions/0025-publish-assembly-0-1-0-with-core-0-1-0.md).
Historical private admission retains its original authority. Publication follows
retained-byte and registry consumer checks; admission alone proves no release.
Public 0.2.0 and 0.3.0 pair admission additionally authenticates
[ADR-0027](../decisions/0027-admit-the-core-and-assembly-0-2-0-correction-pair.md) and
[ADR-0031](../decisions/0031-pass-a-per-run-scope-and-declared-inputs-to-assembly-runs.md) respectively.
