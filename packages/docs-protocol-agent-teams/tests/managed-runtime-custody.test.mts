import assert from "node:assert/strict";
import test from "node:test";
import { hasNoManagedChild, permitsAttemptRelease, permitsAttemptTransition,
  permitsDisposableProject, snapshotAttemptInput, snapshotInstallInput } from "../dist/consumer-integration/application/managed-runtime-policy.js";
import type { ManagedAttemptInput, ManagedPnpmInstallInput, ProcessFacts } from "../dist/consumer-integration/application/ports/managed-runtime.js";

const empty: ProcessFacts = { spawned: false, exitCode: null, signal: null, cancelled: false,
  timedOut: false, stdoutBytes: 0, stderrBytes: 0, directChild: "not-started",
  group: "not-started", streams: "not-started" };
const runtime = Object.freeze({ kind: "managed-runtime-handle" as const });
const input: ManagedAttemptInput = { externalRoot: "/TEST/external", consumerRoot: "/TEST/consumer",
  controllerBuildDigest: "1".repeat(64), role: "source", runtime,
  signal: new AbortController().signal };

test("unknown streams and durable debt never permit release or a new spawning transition", () => {
  assert.equal(hasNoManagedChild({ ...empty, streams: "unconfirmed" }), false);
  assert.equal(permitsAttemptRelease("acquired", { ...empty, group: "unconfirmed" }, false), false);
  assert.equal(permitsAttemptRelease("terminated", { ...empty, streams: "unconfirmed" }, false), false);
  assert.equal(permitsAttemptRelease("debt", empty, false), false);
  assert.equal(permitsAttemptTransition("debt", "spawning"), false);
  assert.equal(permitsAttemptRelease("acquired", empty, false), true);
});

test("attempt admission snapshots descriptors before caller mutation and never executes accessors", () => {
  const mutable = { ...input };
  const snapshot = snapshotAttemptInput(mutable);
  assert.ok(snapshot);
  mutable.consumerRoot = "/TEST/replacement";
  assert.equal(snapshot.consumerRoot, "/TEST/consumer");
  let reads = 0;
  const accessor = { ...input, get externalRoot(): string { reads++; throw new Error("accessor"); } };
  assert.equal(snapshotAttemptInput(accessor), null);
  assert.equal(reads, 0);
  assert.equal(snapshotAttemptInput({ ...input, duplicate: runtime }), null);
});

test("role and mode require literal strings without invoking caller coercion", () => {
  const install: ManagedPnpmInstallInput = { root: { kind: "managed-owned-installation-root" },
    runtime, mode: "prepare", expectedManifestDigest: "2".repeat(64),
    expectedWorkspaceDigest: "3".repeat(64), expectedLockDigest: null, signal: input.signal };
  let calls = 0;
  const candidates: readonly { readonly role: unknown; readonly mode: unknown }[] = [
    { role: { toString(): string { calls++; return "source"; } },
      mode: { toString(): string { calls++; return "prepare"; } } },
    { role: { toString(): never { calls++; throw new Error("role coercion"); } },
      mode: { toString(): never { calls++; throw new Error("mode coercion"); } } },
    { role: { [Symbol.toPrimitive](): string { calls++; return "source"; } },
      mode: { [Symbol.toPrimitive](): string { calls++; return "prepare"; } } },
    { role: { [Symbol.toPrimitive](): never { calls++; throw new Error("role primitive"); } },
      mode: { [Symbol.toPrimitive](): never { calls++; throw new Error("mode primitive"); } } },
    { role: null, mode: null },
    { role: 1, mode: true }
  ];
  for (const candidate of candidates) {
    assert.equal(snapshotAttemptInput({ ...input, role: candidate.role }), null);
    assert.equal(snapshotInstallInput({ ...install, mode: candidate.mode }), null);
  }
  assert.equal(calls, 0);
  assert.equal(snapshotAttemptInput({ ...input, role: "target" })?.role, "target");
  assert.equal(snapshotInstallInput({ ...install, mode: "frozen-offline" })?.mode, "frozen-offline");
});

test("install admission rejects accessor authority and unbranded cancellation objects", () => {
  const install: ManagedPnpmInstallInput = { root: { kind: "managed-owned-installation-root" },
    runtime, mode: "prepare", expectedManifestDigest: "2".repeat(64),
    expectedWorkspaceDigest: "3".repeat(64), expectedLockDigest: null, signal: input.signal };
  let reads = 0;
  assert.equal(snapshotInstallInput({ ...install, get root(): never { reads++; throw new Error("root"); } }), null);
  assert.equal(reads, 0);
  assert.equal(snapshotInstallInput({ ...install, signal: Object.create(AbortSignal.prototype) as unknown }), null);
});

test("disposable installation refuses remote dependencies and workspace strictness overrides", () => {
  const manifest = { name: "TEST-private", version: "1.0.0", private: true,
    packageManager: "pnpm@11.20.0", dependencies: { fixture: "file:./fixture.tgz" } };
  assert.equal(permitsDisposableProject(manifest, { packages: [] }), true);
  assert.equal(permitsDisposableProject({ ...manifest, dependencies: { fixture: "https://example.invalid/fixture.tgz" } }, { packages: [] }), false);
  assert.equal(permitsDisposableProject(manifest, { packages: [], engineStrict: false }), false);
  assert.equal(permitsDisposableProject(manifest, { packages: ["../consumer"] }), false);
});
