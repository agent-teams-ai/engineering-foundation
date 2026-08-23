---
id: ADR-0033
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0033: Freeze the Legacy Foundation Docs CLI

Status: Accepted

Date: 2026-08-23

Decision owner: Product owner

## Context

ADR-0026 carries forward the one-way documentation package split:
`@agent-teams/docs-protocol` depends on Foundation and owns the documentation
command vocabulary, orchestration, query behavior, diagnostics, and agent
workflow. Foundation owns reusable catalog, planning, mutation, transaction,
and recovery mechanisms and cannot depend on Docs Protocol.

Foundation still publishes and dispatches the older
`agent-teams-foundation docs` command family. Existing consumers and exact
recovery paths can still rely on that executable surface. Deleting it
immediately would turn an ownership correction into an unqualified breaking
change. Leaving it advertised without a freeze would preserve two apparent
owners and allow their behavior to drift.

The legacy JSON commands also have a published stream contract: exactly one
bounded command envelope on stdout, no human text on stdout, and stderr
reserved for emergency launcher failure before an envelope is available. A
deprecation mechanism cannot silently invalidate that contract.

## Decision

1. Docs Protocol is the sole target owner of operator-facing and agent-facing
   documentation commands. Current guidance uses `agent-teams-docs` from
   `@agent-teams/docs-protocol`.
2. Foundation's `docs` namespace is a frozen compatibility surface. Its
   existing parser, dispatch, result envelopes, exit codes, mutation behavior,
   and recovery behavior remain available during phase 1.
3. Foundation emits the stable diagnostic code
   `FOUNDATION_DOCS_CLI_DEPRECATED` once for each human-mode invocation of the
   legacy namespace. The diagnostic names `agent-teams-docs` and the Docs
   Protocol package as the replacement.
4. Legacy JSON invocations emit no deprecation text or second JSON value. Their
   stdout, stderr, versioned envelope, and exit-code behavior remains
   byte-compatible. Automation can discover deprecation through published
   help, package guidance, and the stable human diagnostic code without
   corrupting a command envelope.
5. The Foundation help surface keeps one compact legacy namespace entry so an
   operator can identify the compatibility route. It marks that entry
   deprecated and points to Docs Protocol instead of advertising each legacy
   subcommand as current functionality.
6. The freeze forbids new legacy commands, flags, aliases, output fields,
   orchestration semantics, or convenience behavior. A security, data-loss,
   platform-compatibility, or exact-recovery correction may change the legacy
   implementation only when it preserves the frozen command contract or is
   released as an explicitly governed compatibility exception.
7. Foundation does not import, load, invoke, forward to, or declare a
   dependency on Docs Protocol. The replacement package and command in the
   warning are inert identifiers, not a runtime integration. Dependency
   direction remains Docs Protocol to Foundation.
8. Foundation's document-authoring exports, schemas, catalog compiler,
   transaction barrier, mutation ports, evidence readers, and exact-build
   recovery handlers are not legacy merely because the top-level CLI is
   deprecated. They remain owned Foundation mechanisms used by Docs Protocol
   and compatibility recovery.
9. Phase 1 does not delete the legacy parser or dispatch, rewrite legacy
   recovery recommendations, add a package/plugin framework, or create a second
   forwarding binary. Existing disposable compatibility fixtures remain
   qualification evidence until the later removal event.
10. Removing the legacy namespace is a separate, explicitly breaking change.
    It cannot be bundled into routine cleanup or inferred from Docs Protocol
    publication alone.

## Removal event

The removal event is the merge of a dedicated legacy-CLI removal change after
all evidence below is attached to that change at its exact head SHA. There is
no passive waiting period: evidence, not elapsed time, opens the gate.

The removal change must include:

1. an organization-governance attestation bound to an exact revision of the
   append-only central Cohort registry, the selected Qualified Cohort record
   digest, and its qualification-event digest. It must enumerate every
   repository in that revision's supported, suspended, or otherwise
   fleet-governed membership with its default-branch commit and show zero
   package scripts, workflows, agent instructions, or automation invoking the
   legacy Foundation docs namespace. An unresolvable registry revision,
   lifecycle state, or member closes the gate;
2. per-consumer cutover evidence showing exact registry versions of Docs
   Protocol and Foundation, the managed aliases owned by Docs Protocol, a clean
   lockfile, and the consumer's required hosted check at the inventoried commit;
3. positive and negative parity fixtures for every formerly used legacy
   operation, including find, preview, apply, doctor, recovery, invalid input,
   cancellation, and partial-catalog behavior where applicable;
4. packed-registry qualification proving the Docs Protocol CLI starts and
   executes against exact published package artifacts on Linux, macOS, and
   Windows, with dependency direction still one-way;
5. a closed recovery-compatibility inventory derived from the canonical
   [transaction and compatibility](../architecture/document-authoring-protocol.md#transaction-and-compatibility)
   contract at the removal head. It must explicitly enumerate every recognized
   document evidence pair - currently envelope v2/journal v1 as manual-only
   evidence, envelope v3/journal v2 with its exact handler generation, and
   envelope v4/journal v3 with its exact handler generation - and bind each
   entry to fixtures plus the retained exact registry artifact or manual
   procedure that handles it without the removed top-level namespace;
6. a source and package-boundary report proving Foundation has no Docs Protocol
   import, dependency, dynamic loader, subprocess proxy, or generated package
   reference that creates a reverse runtime edge;
7. a release note and Changeset that identify the removal as breaking, name the
   replacement command and package, and state which Foundation mechanisms and
   recovery contracts remain supported; and
8. the full required hosted matrix at the exact removal head, including package
   contents, public API compatibility, registry installation, crash/recovery,
   and security checks.

If the exact central registry revision cannot be reproduced, any governed
consumer or lifecycle state is absent from the inventory, any legacy invocation
remains, any required hosted check is stale or failing, or the closed recovery
inventory omits a recognized evidence pair or proven route, the removal gate is
closed. The compatibility namespace stays frozen; the missing evidence is
repaired without expanding its behavior.

## Compatibility observations

The phase-1 warning is intentionally outside the document command renderers.
Those renderers remain pure and keep their versioned envelope contracts. The
CLI entrypoint observes only whether the raw top-level command is `docs` and
whether the invocation's existing output path is human or machine. A completed
dispatch uses the parsed output mode, so an option token after `--` remains
human input. An exception uses the legacy launcher projection, which historically
recognizes a machine-output token anywhere in the raw arguments. This preserves
empty stderr whenever that launcher produces a JSON failure envelope.

The entrypoint emits at most one warning after a completed human dispatch or
before projecting a human launch failure. This placement covers invalid human
legacy invocations while leaving direct library consumers and Docs Protocol
calls untouched. It introduces no filesystem, network, package-manager, or
consumer-project observation.

## Consequences

- Docs Protocol is visibly the target owner without a Foundation dependency
  cycle or a forwarding shim.
- Existing human operators receive an actionable, stable deprecation code.
- Existing machine callers retain their one-envelope stdout and empty-stderr
  compatibility contract.
- The repository continues carrying legacy parser and orchestration cost until
  consumer and recovery evidence is complete.
- Later deletion is reviewable as a dedicated breaking event with exact-head
  evidence instead of an informal assumption that consumers migrated.

## Rejected alternatives

- Import or spawn Docs Protocol from the Foundation CLI. This reverses or hides
  the accepted dependency direction and couples independently released
  packages.
- Emit a second JSON object or a JSON warning on stderr. This breaks the
  published legacy machine stream contract.
- Add deprecation diagnostics to existing envelopes in place. That changes
  versioned command semantics and can alter outcome calculations.
- Delete only the command parser while retaining undocumented recovery entry
  points. That strands compatibility evidence and makes ownership less clear.
- Keep both CLIs current until every consumer migrates. That permits continued
  behavior drift and does not establish a measurable removal gate.
- Build a generic CLI forwarding or plugin system. One deprecated namespace
  does not justify a new extension framework.
