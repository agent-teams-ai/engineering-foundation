import assert from "node:assert/strict";
import test from "node:test";

import { renderDocumentCommandText } from "../packages/engineering-foundation/dist/document-authoring/adapters/inbound/cli/document-command-renderer.js";

function execution(command, result, outcome = "success") {
  return {
    exitCode: outcome === "success" ? 0 : 1,
    envelope: { schemaVersion: 2, command, outcome, diagnostics: [], result },
  };
}

test("doctor renders installed, filesystem, protocol, and journal evidence", () => {
  const text = renderDocumentCommandText(execution("docs.doctor", {
    kind: "doctor",
    installedFoundationVersion: "0.15.0",
    installedFoundationBuildIdentity: `sha256:${"a".repeat(64)}`,
    filesystem: {
      basis: "platform-contract",
      strictDirectoryDurability: "platform-unsupported",
    },
    transactionState: "version-mismatch",
    protocolKind: "document-authoring",
    foundationVersion: "0.14.3",
    foundationBuildIdentity: `sha256:${"b".repeat(64)}`,
    recoveryClass: "manual",
  }, "recovery-required"));

  assert.match(text, /Installed Foundation: 0\.15\.0/u);
  assert.match(text, /Installed build: sha256:a{64}/u);
  assert.match(
    text,
    /Filesystem durability: platform-unsupported \(platform-contract\)/u,
  );
  assert.match(text, /Transaction protocol: document-authoring/u);
  assert.match(text, /Journal Foundation: 0\.14\.3/u);
  assert.match(text, /Journal build: sha256:b{64}/u);
});

test("doctor omits unavailable evidence instead of inventing it", () => {
  const text = renderDocumentCommandText(execution("docs.doctor", {
    kind: "doctor",
    transactionState: "unknown",
    recoveryClass: "manual",
  }, "recovery-required"));

  assert.doesNotMatch(text, /Installed Foundation|Installed build|Filesystem|protocol|Journal/u);
  assert.match(text, /Transaction: unknown/u);
});

test("new preview renders the canonical non-mutating next step", () => {
  const text = renderDocumentCommandText(execution("docs.new", {
    kind: "new",
    reservation: "none",
    documentPath: "docs/adr/0083-deterministic-docs.md",
    writeState: "preview",
    reachability: { state: "not-required" },
  }));

  assert.match(text, /Document: docs\/adr\/0083-deterministic-docs\.md/u);
  assert.match(text, /Next: review this preview, then run docs new without --dry-run/u);
});

test("new RC result renders exact reachability as the next step", () => {
  const text = renderDocumentCommandText(execution("docs.new", {
    kind: "new",
    reservation: "none",
    documentPath: "docs/adr/0083-deterministic-docs.md",
    writeState: "applied",
    reachability: {
      state: "manual-required",
      indexPath: "docs/adr/README.md",
      markdownLink: "[ADR-0083: Deterministic docs](0083-deterministic-docs.md)",
    },
  }));

  assert.match(text, /Next: add the exact link to docs\/adr\/README\.md/u);
  assert.match(text, /Link: \[ADR-0083: Deterministic docs\]\(0083-deterministic-docs\.md\)/u);
});

test("new completed result renders the canonical repository quality gate", () => {
  const text = renderDocumentCommandText(execution("docs.new", {
    kind: "new",
    reservation: "none",
    documentPath: "docs/adr/0083-deterministic-docs.md",
    writeState: "already-applied",
    reachability: { state: "not-required" },
  }));

  assert.match(text, /Next: agent-teams-foundation repo check/u);
});
