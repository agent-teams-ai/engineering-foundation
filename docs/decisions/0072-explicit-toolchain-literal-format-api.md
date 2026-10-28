---
id: ADR-0072
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0072: Explicit Stack Toolchain Literal Format API

Status: Accepted after independent design review by the repository architecture
coordinator. Canonical accepted-decision promotion records this bounded API
authority; complete native and package qualification remain separate.

Decision owner: Product owner; the repository architecture coordinator records
the bounded decision after independent architecture review.

Date: 2026-10-28

## Context and evidence

The released baseline is `stack-toolchain` 0.1.1. The reviewed literal-format
delivery adds an explicit file census to `runCommand` while retaining ordinary
configured native formatting. The candidate source used by the failed gate is
`acde6ba068d2b272aaacbb7877e4464588af507c`, based on
`3bee0168797580b931dd7e355d0fb8e0ed5691de`; its isolated Linux qualification is
run `40745573501`. Typed lint, strict consumer checking and the other Foundation
capabilities passed before the public API capability rejected the missing
approval. This is not complete runtime, coverage or package qualification.

The actual gate reports exactly
`sha256:cbdefc1eae68189e5ebdf74059dac771e08263deb73bf2e0c5bf56056d3bc7c0`.
Its complete declaration delta has 13 additions, no changed items and no removed
items. A read-only reconstruction from the retained declarations reproduces this
exact change fingerprint. The run retained its full diagnostic JSON but not the
temporary native snapshot; reconstruction is not a new native extraction run.

The added member below the released interface is:

```ts
interface CommandInput {
  readonly formatFiles?: readonly string[];
}
```

The other twelve additions are the root constant and the new interface with its
ten readonly members:

```ts
export declare const formatFilesContractVersion = 1;
export interface FormatFilesDetails {
  readonly schemaVersion: typeof formatFilesContractVersion;
  readonly requested: readonly string[];
  readonly validated: readonly string[];
  readonly attempted: readonly string[];
  readonly digests: Readonly<Record<"requested" | "validated" | "attempted", string>>;
  readonly batches: readonly {
    readonly files: readonly string[];
    readonly completed: boolean;
    readonly result?: unknown;
  }[];
  readonly completed: boolean;
  readonly sourceBytesUnchanged: boolean | null;
  readonly retainedControlDirectory?: string;
  readonly failure?: string;
}
```

`runCommand(input: CommandInput): Promise<CommandReport>`, its existing command
union, all existing input/report members, configuration and typecheck signatures
are unchanged. ADR-0004 deliberately treats a member added below a released
interface as breaking, including an optional member. Only
`CommandInput.formatFiles` meets that condition here; the new root exports and
the members of the new interface are additive.

## Decision

1. Approve only the exact fingerprint above through `approvedBreakingChanges`, referencing ADR-0072.
   Preserve ADR-0065 and its existing approval independently.
2. Keep the released 0.1.1 baseline and compatibility classifier unchanged.
   Promote a new release baseline only through the ordinary version workflow.
3. Retain the existing `stack-toolchain` minor Changeset. The package remains
   0.x; the next minor carries this deliberate API evolution. Do not add a
   redundant bump or compatibility shim.
4. Keep literal execution opt-in. The caller supplies and owns its file census
   and protected-input policy; Stack validates every requested literal file and
   invokes its pinned formatter without discovery or implicit filtering. The
   existing configured native path retains its glob and ignore behavior.
5. Before using this optional field, callers check the public root constant
   `formatFilesContractVersion === 1`. An older version may ignore an unknown
   field, so ordinary formatter success is not evidence of contract support.
6. Preserve bounded process ownership, shared budget/cancellation, requested /
   validated / attempted evidence, source-byte revalidation, and fail-closed
   partial execution. A result with incomplete or uncertain execution cannot
   qualify formatting coverage.

## Compatibility and migration

Existing structural `CommandInput` values and old object literals remain valid:
the new member is optional. Ordinary callers need no value-shape migration and
continue to omit it. This is not a claim of universal source compatibility:
`keyof CommandInput` expands, so exhaustive mapped or key-enumerating consumers
may need to account for `formatFiles`.

Opt-in consumers use the version check and `command: "format:check"` with an
explicit nonempty `formatFiles` census. They consume schema-1 literal details;
they do not infer repository-wide coverage from an ordinary native format
report. Other command combinations reject rather than silently reinterpret the
request. No literal-input CLI flag is introduced by this decision.

## Scope and acceptance limits

This decision covers only the existing formatter/literal delivery. A future Bun
backend or additional configuration/public metadata evolves in a separate lane
with its own API delta and admission; it must not delay or be merged into this
approval's surface.

Acceptance must bind the exact final public item delta and fingerprint. A source
or public declaration change invalidates an assumed binding until reviewed;
matching historical package presence is insufficient. Existing proposed ADRs,
accepted ADR bytes, release-owned baselines, rules and coverage scope remain
unchanged. The historical unpublished literal archive is not rebound to later
source or treated as a published release.

After acceptance, the standard canonical checks, complete platform-selected
runtime inventory, coverage and package qualification, exact-head native CI,
and ordinary release remain required. This decision claims none of them.
