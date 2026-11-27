import assert from "node:assert/strict";

export interface AuthoritySelection {
  readonly revision: string;
  readonly tree: string;
}

type AuthorityRow = Record<string, unknown>;

function row(value: unknown, label: string): AuthorityRow {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as AuthorityRow;
}

function gitSha(value: unknown, label: string): string {
  assert(typeof value === "string" && /^(?!0{40}$)[0-9a-f]{40}$/u.test(value), label);
  return value;
}

export function parseAuthorityRevision(value: unknown): string {
  return gitSha(value, "Select one explicit immutable Central authority revision");
}

export function assertCurrentAuthority(revision: string, observedBranch: unknown): void {
  parseAuthorityRevision(revision);
  const branch = row(observedBranch, "Current Central main response");
  assert.equal(branch["name"], "main", "Select the fixed Central main branch");
  assert.equal(branch["protected"], true, "Central main must remain protected");
  assert.equal(
    row(branch["commit"], "Current protected authority commit")["sha"],
    revision,
    "Selected Central authority is no longer current",
  );
}

export function admitAuthoritySelection(
  selectedRevision: unknown,
  observedBranch: unknown,
  observedCommit: unknown,
): AuthoritySelection {
  const revision = parseAuthorityRevision(selectedRevision);
  assertCurrentAuthority(revision, observedBranch);
  const commit = row(observedCommit, "Immutable Central Git commit response");
  assert.equal(commit["sha"], revision, "Immutable authority response must match the selection");
  const tree = gitSha(row(commit["tree"], "Immutable authority tree")["sha"], "Authority tree SHA");
  return Object.freeze({ revision, tree });
}
