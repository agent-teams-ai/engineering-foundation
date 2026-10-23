import {
  registerGrowthDecisionMetadataCases,
  registerGrowthDecisionComparisonCases,
  valid,
  digest,
  otherDigest,
  policyVersion,
  fingerprint,
  coordinate,
  entry,
  observation,
  compare,
  decisionFor,
  authorityFor,
  evaluate,
  codes,
} from "./public-api-growth-decision-cases.ts";
import { createVerifiedGrowthObservation } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-observation.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGrowthSurfaces,
  growthGroupFingerprint,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import { evaluateGrowthAdmission } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-growth-admission.js";
import { admitSdkGrowth } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.js";
import { growthObservationReference } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { GovernanceAcceptedDecisionEvidenceAcl } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/governance/governance-accepted-decision-evidence-acl.js";
const available = (value) => ({ status: "available", value });
const snapshot = (items = []) => ({
  schemaVersion: 1,
  packageName: "example",
  packageVersion: "1.0.0",
  extractorVersion: "pinned",
  entrypoints: [{ exportPath: ".", items }],
});
const packageSnapshot = (packageName, items, extractorVersion = "pinned") => ({
  schemaVersion: 1,
  packageName,
  packageVersion: "1.0.0",
  extractorVersion,
  entrypoints: [{ exportPath: ".", items }],
});
function useCaseFixture() {
  const before = observation([]),
    after = observation([entry("A")]);
  const {
    contractRevision: _contract,
    observationVersion: _version,
    coverage: _coverage,
    entries: _entries,
    ...invocation
  } = after;
  const artifact = { ...snapshot(), extractorVersion: "package-artifact-inventory/1" };
  const current = snapshot([
    {
      canonicalReference: "A",
      kind: "Function",
      parentKind: "EntryPoint",
      signature: "export function A(): void;",
    },
  ]);
  const comparison = compare([], [entry("A")]),
    decision = decisionFor(comparison.transitions);
  const reference = growthObservationReference(before, fingerprint);
  const context = {
    trustedBase: available(before),
    trustedBaseReference: available(reference),
    retainedHistory: available({
      targetSurfaceDigest: reference.surfaceDigest,
      receiptDigest: digest,
    }),
    released: [
      {
        packageName: "example",
        policy: {
          packageName: "example",
          packageRoot: "packages/example",
          manifestPath: "packages/example/package.json",
          tsconfigPath: "packages/example/tsconfig.json",
          releasedBaselinePath: "architecture/public-api/example.json",
          approvedBreakingChanges: [],
          entrypoints: [{ exportPath: ".", declarationEntryPoint: "dist/index.d.ts" }],
          nonTypeExports: [],
        },
        releaseEvidence: available({
          packageName: "example",
          packageVersion: "1.0.0",
          declaredBump: "minor",
        }),
        qualification: { receiptDigest: digest },
        evidence: { kind: "released", typed: available(snapshot()), artifact: available(artifact) },
      },
    ],
    packedCandidates: [{ packageName: "example", observation: after, coverage: after.coverage[0] }],
    decisions: [decision],
    acceptedBreakingDecisions: {
      acceptedDecisionIds: [],
      acceptedDecisionPaths: [],
      growthDecisionAuthority: available([authorityFor(decision)]),
    },
    authority: { status: "verified", receiptDigest: digest },
  };
  const execution = {
    identity: invocation,
    surface: available(after),
    compatibilitySnapshots: [
      {
        packageName: "example",
        typed: { kind: "typed", snapshot: available(current) },
        artifact: { kind: "artifact", snapshot: available(artifact) },
      },
    ],
  };
  const calls = [];
  const cancellation = { throwIfCancelled() {} };
  const input = {
    invocation,
    context: {
      trustedBasePath: "base.json",
      decisionsPath: "decisions.json",
      released: [{ packageName: "example", kind: "released", observationPath: "released.json" }],
    },
    cancellation,
  };
  const dependencies = {
    fingerprint,
    observation: {
      async observe(value, token) {
        calls.push(["observation", value, token]);
        return execution;
      },
    },
    context: {
      async read(value, token) {
        calls.push(["context", value, token]);
        return context;
      },
    },
  };
  return { input, dependencies, execution, context, calls };
}

function configureCrossPackageDefaultAliasFixture(fixture, reversePackages = false) {
  const aliasPackageName = "example";
  const bindingPackageName = "@fixture/core";
  const aliasReference = `${aliasPackageName}!AnyFactoryHandle:type`;
  const targetReference = `${aliasPackageName}!FactoryHandle:interface`;
  const alias = (signature) => ({
    canonicalReference: aliasReference,
    kind: "TypeAlias",
    parentReference: `${aliasPackageName}!`,
    parentKind: "EntryPoint",
    signature,
  });
  const target = {
    canonicalReference: targetReference,
    kind: "Interface",
    parentReference: `${aliasPackageName}!`,
    parentKind: "EntryPoint",
    signature:
      "export interface FactoryHandle<C, D extends ModuleDeclaration = ModuleDeclaration, I = unknown>",
  };
  const binding = {
    canonicalReference: `${bindingPackageName}!ModuleDeclaration:interface`,
    kind: "Interface",
    parentReference: `${bindingPackageName}!`,
    parentKind: "EntryPoint",
    signature: "export interface ModuleDeclaration",
  };
  const releasedAlias = snapshot([
    alias("export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;"),
    target,
  ]);
  const currentAlias = snapshot([
    alias("export type AnyFactoryHandle<C> = FactoryHandle<C>;"),
    target,
  ]);
  const releasedBinding = packageSnapshot(bindingPackageName, [binding]);
  const currentBinding = packageSnapshot(bindingPackageName, [binding]);
  fixture.context.released[0].evidence.typed = available(releasedAlias);
  fixture.context.released[0].evidence.artifact = available({
    ...releasedAlias,
    extractorVersion: "package-artifact-inventory/1",
  });
  fixture.execution.compatibilitySnapshots[0].typed.snapshot = available(currentAlias);
  fixture.execution.compatibilitySnapshots[0].artifact.snapshot = available({
    ...currentAlias,
    extractorVersion: "package-artifact-inventory/1",
  });
  const bindingPolicy = {
    ...fixture.context.released[0].policy,
    packageName: bindingPackageName,
    packageRoot: "packages/core",
    manifestPath: "packages/core/package.json",
    tsconfigPath: "packages/core/tsconfig.json",
    releasedBaselinePath: "architecture/public-api/core.json",
  };
  const releasedRow = {
    packageName: bindingPackageName,
    policy: bindingPolicy,
    releaseEvidence: available({ packageName: bindingPackageName, packageVersion: "1.0.0" }),
    qualification: { receiptDigest: digest },
    evidence: {
      kind: "released",
      typed: available(releasedBinding),
      artifact: available({ ...releasedBinding, extractorVersion: "package-artifact-inventory/1" }),
    },
  };
  const currentRow = {
    packageName: bindingPackageName,
    typed: { kind: "typed", snapshot: available(currentBinding) },
    artifact: {
      kind: "artifact",
      snapshot: available({ ...currentBinding, extractorVersion: "package-artifact-inventory/1" }),
    },
  };
  fixture.context.released.push(releasedRow);
  fixture.execution.compatibilitySnapshots.push(currentRow);
  for (const surface of [fixture.context.trustedBase.value, fixture.execution.surface.value]) {
    surface.coverage.push({
      ...structuredClone(surface.coverage[0]),
      packageName: bindingPackageName,
    });
  }
  const reference = growthObservationReference(fixture.context.trustedBase.value, fingerprint);
  fixture.context.trustedBaseReference = available(reference);
  fixture.context.retainedHistory = available({
    targetSurfaceDigest: reference.surfaceDigest,
    receiptDigest: digest,
  });
  if (reversePackages) {
    fixture.context.released.reverse();
    fixture.execution.compatibilitySnapshots.reverse();
  }
}

function registerGrowthAdmissionRegressionCases() {
  test("raw context candidate fields cannot rewrite the S1 payload or its digest", async () => {
    const f = useCaseFixture();
    const original = structuredClone(f.execution);
    f.context.packedCandidates = [
      {
        packageName: "example",
        observation: observation([]),
        coverage: observation([]).coverage[0],
      },
    ];
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.deepEqual(result.observation, original);
    assert.deepEqual(
      growthObservationReference(result.observation.surface.value, fingerprint),
      growthObservationReference(original.surface.value, fingerprint),
    );
  });

  test("SDK qualification uses cross-package stable default bindings independent of package order", async () => {
    const results = [];
    for (const reversePackages of [false, true]) {
      const f = useCaseFixture();
      configureCrossPackageDefaultAliasFixture(f, reversePackages);
      const result = await admitSdkGrowth(f.input, f.dependencies);
      assert.equal(result.compatibility.status, "complete", JSON.stringify(result.compatibility));
      assert.deepEqual(result.compatibility.diagnostics, []);
      assert.equal(result.admission.status, "admitted");
      results.push(result.compatibility);
    }
    assert.deepEqual(results[1], results[0]);
  });

  test("decision order cannot change overlap evidence", () => {
    const comparison = compare([], [entry("A")]);
    const decisions = [
      decisionFor(comparison.transitions, "ADR-2"),
      decisionFor(comparison.transitions, "ADR-1"),
    ];
    const result = evaluate(comparison, decisions);
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.admittedTransitions, []);
    assert.deepEqual(
      result.diagnostics.filter((x) => x.code === "growth-decision-overlap").map((x) => x.subject),
      ["ADR-2"],
    );
    assert.deepEqual(evaluate(comparison, decisions.toReversed()), result);
  });
  test("duplicate IDs reject all records before owner matching regardless of order", () => {
    const comparison = compare([], [entry("A")]);
    const first = decisionFor(comparison.transitions);
    const changed = { ...first, exposureRationale: "different approval" };
    const authority = [authorityFor(first)];
    const result = evaluate(comparison, [first, changed], { authority });
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.admittedTransitions, []);
    assert.ok(codes(result).includes("growth-decision-duplicate"));
    assert.ok(!codes(result).includes("growth-owner-evidence-unavailable"));
    assert.deepEqual(evaluate(comparison, [changed, first], { authority }), result);
    assert.equal(evaluate(comparison, [first, first], { authority }).status, "rejected");
  });
  test("sparse observations budget actual transitions rather than combined coordinates", () => {
    const shared = Array.from({ length: 99_999 }, (_, i) => entry(`S${i}`));
    const comparison = compare([...shared, entry("old")], [...shared, entry("new")]);
    assert.equal(comparison.status, "complete");
    assert.equal(comparison.transitions.length, 2);
    assert.deepEqual(
      comparison.transitions.map((x) => x.coordinate.subject.canonicalReference),
      ["new", "old"],
    );
  });
  test("transition budget accepts the exact limit and rejects one extra transition", () => {
    const before = Array.from({ length: 50_000 }, (_, i) => entry(`L${i}`));
    const after = Array.from({ length: 50_000 }, (_, i) => entry(`R${i}`));
    assert.equal(compare(before, after).transitions.length, 100_000);
    assert.deepEqual(compare(before, [...after, entry("extra")]), {
      status: "incomplete",
      reasons: ["growth-transition-budget-exhausted"],
      findings: [],
    });
  });
  test("decision count and cumulative claim budgets return deterministic incomplete evidence", () => {
    const comparison = compare([], [entry("A")]);
    const expected = {
      status: "incomplete",
      admittedTransitions: [],
      releaseEligible: false,
      diagnostics: [
        {
          code: "growth-decision-budget-exhausted",
          subject: "decisions",
          remediation: "Supply at most 10000 decisions and 100000 total transition claims.",
        },
      ],
    };
    const run = (decisions) =>
      evaluateGrowthAdmission(
        { comparison, decisions, authority: [], compatibility: "complete" },
        fingerprint,
      );
    const d = decisionFor(comparison.transitions);
    assert.ok(!codes(run(Array(10_000).fill(d))).includes("growth-decision-budget-exhausted"));
    assert.deepEqual(run(Array(10_001).fill(d)), expected);
    const claims = Array.from(
      { length: 50_001 },
      (_, i) => `sha256:${i.toString(16).padStart(64, "0")}`,
    );
    const first = { ...d, transitions: claims.slice(0, 50_000) };
    const second = { ...d, decisionId: "ADR-2", transitions: claims.slice(0, 50_000) };
    assert.ok(!codes(run([first, second])).includes("growth-decision-budget-exhausted"));
    const over = { ...second, transitions: claims };
    assert.deepEqual(run([first, over]), expected);
    assert.deepEqual(run([over, first]), expected);
  });
}

const rawBudgetAdmission = (decisions) =>
  evaluateGrowthAdmission(
    {
      comparison: compare([], [entry("A")]),
      decisions,
      authority: [],
      compatibility: "complete",
    },
    fingerprint,
  );
function registerRawDecisionBudgetCases() {
  const expected = {
    status: "incomplete",
    admittedTransitions: [],
    releaseEligible: false,
    diagnostics: [
      {
        code: "growth-decision-budget-exhausted",
        subject: "decisions",
        remediation: "Supply at most 10000 decisions and 100000 total transition claims.",
      },
    ],
  };
  test("one oversized raw decision exhausts the budget before metadata validation", () => {
    const oversized = { ...valid(), transitions: Array(100_001).fill(digest) };
    assert.deepEqual(rawBudgetAdmission([oversized]), expected);
    assert.deepEqual(rawBudgetAdmission([oversized]), rawBudgetAdmission([oversized]));
    const sparse = [];
    sparse.length = 0xffffffff;
    assert.deepEqual(rawBudgetAdmission([{ ...oversized, transitions: sparse }]), expected);
  });
  test("malformed records count toward cumulative raw claim exhaustion in any order", () => {
    const malformed = { ...valid(), ownerRef: "", transitions: Array(50_000).fill(digest) };
    const other = { ...valid(), transitions: Array(50_000).fill(digest) };
    assert.ok(
      !codes(rawBudgetAdmission([malformed, other])).includes("growth-decision-budget-exhausted"),
    );
    const overflow = { ...other, transitions: [...other.transitions, digest] };
    assert.deepEqual(rawBudgetAdmission([malformed, overflow]), expected);
    assert.deepEqual(rawBudgetAdmission([overflow, malformed]), expected);
  });
}

export function registerGrowthAdmissionCases() {
  registerRawDecisionBudgetCases();
  registerGrowthAdmissionRegressionCases();
  registerGrowthDecisionMetadataCases();
  registerGrowthDecisionComparisonCases();
  registerGrowthUseCaseCases();
}

function registerGrowthUseCaseCases() {
  test("one S1 execution supplies admission and unchanged v1 compatibility branches", async () => {
    const f = useCaseFixture();
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.equal(result.admission.status, "admitted");
    assert.equal(result.compatibility.status, "complete");
    assert.deepEqual(
      f.calls.map((x) => x[0]),
      ["observation", "context"],
    );
    assert.ok(f.calls.every((x) => x[2] === f.input.cancellation));
    assert.deepEqual(f.calls[0][1], f.input.invocation);
  });
  test("actual retained v1 breaking change rejects despite exact growth approval", async () => {
    const f = useCaseFixture();
    f.context.released[0].evidence.typed.value.entrypoints[0].items = [
      {
        canonicalReference: "A",
        kind: "Function",
        parentKind: "EntryPoint",
        signature: "export function A(value: string): void;",
      },
    ];
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.equal(result.admission.status, "rejected");
    assert.equal(result.compatibility.status, "rejected");
    assert.ok(result.compatibility.diagnostics.length > 0);
  });
  for (const [name, mutate, reason] of [
    [
      "envelope identity",
      (f) => {
        f.execution.identity = { ...f.execution.identity, sourceCommit: "c".repeat(40) };
      },
      "growth-execution-identity-mismatch",
    ],
    [
      "surface identity",
      (f) => {
        f.execution.surface.value.sourceTree = "c".repeat(40);
      },
      "growth-surface-identity-mismatch",
    ],
    [
      "duplicate handoff",
      (f) => {
        f.execution.compatibilitySnapshots.push(f.execution.compatibilitySnapshots[0]);
      },
      "duplicate-growth-collection-key",
    ],
    [
      "missing handoff",
      (f) => {
        f.execution.compatibilitySnapshots = [];
      },
      "growth-compatibility-topology-mismatch",
    ],
    [
      "substituted branch",
      (f) => {
        f.execution.compatibilitySnapshots[0].typed =
          f.execution.compatibilitySnapshots[0].artifact;
      },
      "growth-compatibility-branch-mismatch",
    ],
    [
      "stale retained reference",
      (f) => {
        f.context.trustedBaseReference.value.surfaceDigest = otherDigest;
      },
      "growth-trusted-base-reference-mismatch",
    ],
  ]) {
    test(`S2 rejects ${name}`, async () => {
      const f = useCaseFixture();
      mutate(f);
      await assert.rejects(
        admitSdkGrowth(f.input, f.dependencies),
        (error) => error.reason === reason,
      );
    });
  }
  for (const [name, mutate] of [
    [
      "shallow retained history",
      (f) => {
        f.context.retainedHistory = { status: "unavailable", reasons: ["shallow-history"] };
      },
    ],
    [
      "retained chain target changed",
      (f) => {
        f.context.retainedHistory.value.targetSurfaceDigest = otherDigest;
      },
    ],
    [
      "candidate authority",
      (f) => {
        f.context.authority = { status: "unverified", reasons: ["candidate-input"] };
      },
    ],
    [
      "missing initial history",
      (f) => {
        f.context.released[0].evidence = {
          kind: "initial-unreleased",
          history: { status: "unavailable", reasons: ["missing-history"] },
        };
      },
    ],
    [
      "unqualified initial history digest",
      (f) => {
        f.context.released[0].evidence = { kind: "initial-unreleased", history: available(digest) };
        delete f.context.released[0].qualification;
      },
    ],
    [
      "mismatched initial history qualification",
      (f) => {
        f.context.released[0].evidence = { kind: "initial-unreleased", history: available(digest) };
        f.context.released[0].qualification = { receiptDigest: otherDigest };
      },
    ],
    [
      "unavailable artifact branch",
      (f) => {
        f.execution.compatibilitySnapshots[0].artifact.snapshot = {
          status: "unavailable",
          reasons: ["lost-archive"],
        };
      },
    ],
  ]) {
    test(`${name} remains incomplete`, async () => {
      const f = useCaseFixture();
      mutate(f);
      const result = await admitSdkGrowth(f.input, f.dependencies);
      assert.equal(result.admission.status, "incomplete");
      assert.equal(result.admission.releaseEligible, false);
      assert.deepEqual(result.released, f.context.released);
    });
  }
  for (const boundary of ["observation", "context"]) {
    test(`cancellation during ${boundary} propagates original reason`, async () => {
      const f = useCaseFixture(),
        reason = new Error("cancelled"),
        controller = new AbortController();
      f.input.cancellation = {
        signal: controller.signal,
        throwIfCancelled() {
          controller.signal.throwIfAborted();
        },
      };
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      f.dependencies[boundary][boundary === "observation" ? "observe" : "read"] = async (
        _value,
        token,
      ) => {
        entered();
        await new Promise((_resolve, reject) => {
          token.signal.addEventListener("abort", () => reject(new Error("io-aborted")), {
            once: true,
          });
        });
      };
      const running = admitSdkGrowth(f.input, f.dependencies);
      await started;
      controller.abort(reason);
      await assert.rejects(running, (error) => error === reason);
      if (boundary === "observation") {
        assert.equal(f.calls.length, 0);
      }
    });
    test(`${boundary} errors are preserved`, async () => {
      const f = useCaseFixture(),
        failure = new Error("unexpected");
      f.dependencies[boundary][boundary === "observation" ? "observe" : "read"] = async () => {
        throw failure;
      };
      await assert.rejects(admitSdkGrowth(f.input, f.dependencies), (error) => error === failure);
    });
  }

  registerGrowthRetainedDecisionCases();
}

function registerGrowthRetainedDecisionCases() {
  test("same decision ID with changed present before digest rejects", () => {
    const original = compare([entry("A")], [entry("A", otherDigest)]);
    const changed = compare([entry("A", `sha256:${"c".repeat(64)}`)], [entry("A", otherDigest)]);
    assert.equal(evaluate(changed, [decisionFor(original.transitions)]).status, "rejected");
  });
  test("retained absent-to-A decision cannot authorize later A-to-B or collapsed absent-to-B", () => {
    const first = compare([], [entry("A")]);
    const d = decisionFor(first.transitions);
    assert.equal(
      evaluate(compare([entry("A")], [entry("A", otherDigest)]), [d]).status,
      "rejected",
    );
    assert.equal(evaluate(compare([], [entry("A", otherDigest)]), [d]).status, "rejected");
  });
  for (const kind of ["typed", "data", "wildcard-member"]) {
    test(`packed-only ${kind} cannot bypass release compatibility`, async () => {
      const f = useCaseFixture();
      f.execution.surface.value.entries = [];
      f.execution.compatibilitySnapshots[0].typed.snapshot = available(snapshot());
      const packed = structuredClone(f.context.packedCandidates[0]);
      packed.observation.entries = [
        {
          coordinate: {
            ...coordinate("PackedOnly"),
            subject:
              kind === "typed"
                ? { kind, canonicalReference: "PackedOnly" }
                : { kind, member: "dist/packed.json" },
          },
          value: { state: "present", digest },
        },
      ];
      f.context.packedCandidates = [packed];
      f.dependencies.observation = createVerifiedGrowthObservation(f.dependencies.observation, {
        packedCandidates: () => f.context.packedCandidates,
        resolution: () => ({ grant: { metadataRoots: [] } }),
      });
      const comparison = compareGrowthSurfaces(
        { trustedBefore: f.context.trustedBase, candidateAfter: available(packed.observation) },
        fingerprint,
      );
      const decision = decisionFor(comparison.transitions);
      f.context.decisions = [decision];
      f.context.acceptedBreakingDecisions.growthDecisionAuthority = available([
        authorityFor(decision),
      ]);
      delete f.context.released[0].releaseEvidence.value.declaredBump;
      const result = await admitSdkGrowth(f.input, f.dependencies);
      assert.equal(result.comparison.status, "complete");
      assert.equal(result.comparison.transitions.length, 1);
      assert.equal(result.compatibility.status, "incomplete");
      assert.ok(
        result.compatibility.reasons.includes(
          `example:${kind === "typed" ? "typed" : "artifact"}:compatibility-evidence-unavailable`,
        ),
      );
      assert.equal(result.admission.status, "incomplete");
      assert.equal(result.admission.releaseEligible, false);
    });
  }

  test("removed package release obligations cannot disappear from context", async () => {
    const f = useCaseFixture();
    const before = f.context.trustedBase.value;
    before.coverage.push({ ...structuredClone(before.coverage[0]), packageName: "old-package" });
    before.entries.push({
      ...entry("old"),
      coordinate: { ...coordinate("old"), packageName: "old-package" },
    });
    const reference = growthObservationReference(before, fingerprint);
    f.context.trustedBaseReference = available(reference);
    f.context.retainedHistory = available({
      targetSurfaceDigest: reference.surfaceDigest,
      receiptDigest: digest,
    });
    const c = compareGrowthSurfaces(
      { trustedBefore: available(before), candidateAfter: f.execution.surface },
      fingerprint,
    );
    const d = decisionFor(c.transitions);
    f.context.decisions = [d];
    f.context.acceptedBreakingDecisions.growthDecisionAuthority = available([authorityFor(d)]);
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.equal(result.admission.status, "incomplete");
    assert.ok(result.comparison.reasons.includes("growth-release-topology-mismatch"));
  });

  test("existing governance ACL preserves v1 and does not invent exact owner approval", async () => {
    const retained = {
      acceptedDecisionIds: ["ADR-1"],
      acceptedDecisionPaths: ["docs/decisions/1.md"],
    };
    const adapter = new GovernanceAcceptedDecisionEvidenceAcl(async () => retained);
    const request = {
      consumerRoot: ".",
      baselinePath: "baseline.json",
      governanceConfigPath: "governance.yaml",
    };
    assert.equal(await adapter.readAcceptedDecisionEvidence(request), retained);
    const extended = await adapter.readAcceptedDecisionEvidence({
      ...request,
      growthDecisions: [valid()],
    });
    assert.deepEqual(extended.acceptedDecisionIds, retained.acceptedDecisionIds);
    assert.equal(extended.growthDecisionAuthority.status, "unavailable");
    assert.deepEqual(extended.growthDecisionAuthority.reasons, [
      "governance-exact-growth-owner-binding-unavailable",
    ]);
  });
  test("growth approval cannot establish private-only support classification", () => {
    const before = observation([entry("A")]),
      after = observation([entry("A")]);
    after.coverage[0].classification = "private-only";
    const comparison = compareGrowthSurfaces(
      { trustedBefore: available(before), candidateAfter: available(after) },
      fingerprint,
    );
    assert.equal(evaluate(comparison).status, "incomplete");
    assert.ok(
      comparison.reasons.some((reason) => reason.includes("private-classification-unqualified")),
    );
  });

  test("group payload matches independent canonical bytes and excludes input order", () => {
    const bytes = `{"domain":"foundation:sdk-growth:group:1","policyVersion":"${policyVersion}","transitions":["${digest}","${otherDigest}"]}`;
    assert.equal(
      growthGroupFingerprint([otherDigest, digest], fingerprint),
      `sha256:${fingerprint.sha256(bytes)}`,
    );
    assert.throws(() => growthGroupFingerprint([digest, digest], fingerprint), /duplicate/u);
  });
  test("release evidence from another package is an invariant failure", async () => {
    const f = useCaseFixture();
    f.context.released[0].releaseEvidence.value.packageName = "other";
    await assert.rejects(
      admitSdkGrowth(f.input, f.dependencies),
      (error) => error.reason === "growth-release-evidence-package-mismatch",
    );
  });
}
