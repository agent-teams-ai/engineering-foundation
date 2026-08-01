# Suppression Governance

Status: Implemented; ADR-0003 is proposed.

`quality.suppression-governance` treats every inline suppression as temporary
accountable evidence. It scans parser comments, so directive-like text inside a
string is not evidence.

## Allowed surface

Only these narrow directives can receive a waiver:

- `oxlint-disable-line` and `oxlint-disable-next-line` with exact rule IDs;
- `@ts-expect-error`, represented as `typescript-expect-error` with the stable
  rule `typescript/type-error`;
- rule-scoped `ast-grep-ignore`.

File or region suppressions, `@ts-ignore`, `@ts-nocheck`, ESLint aliases, and
directives without exact rules fail. Rules beginning with `security.`,
`tenancy.`, or `tenant-isolation.` are never waiverable. Consumers may add
protected prefixes but cannot remove the built-in set.

## Waiver contract

One waiver matches exactly one source location, directive kind, and sorted rule
set. It requires a unique ID, owner, reason, decision reference, creation date,
and expiry date. A waiver cannot start in the future, survive expiry, exceed 90
days, or remain after its source directive is removed. Unknown, stale, broad,
and mismatched evidence fails closed with deterministic diagnostics.

The capability owns scanning and policy. The consumer owns governed roots,
additional protected rule prefixes, and its waiver records. A waiver permits a
specific lint suppression; it never suppresses a foundation diagnostic.
