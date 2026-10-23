import { createHash } from "node:crypto";
import { validateGrowthReport } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-report.js";
const reportFingerprint = {
  sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  },
};
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import test from "node:test";
import { check, withPublicApiFixture } from "./support/capability-fixtures.mjs";

export function registerGrowthRouteCases() {
  registerExistingRouteCase();
  registerScopeDriftCase();
}
function registerExistingRouteCase() {
  test("existing public check route preserves v1 and publishes deterministic incomplete v2 evidence with exit 2", async () => {
    await withPublicApiFixture(async (root: string) => {
      assert.equal(check(root).result.status, 0);
      const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      await cp("tests/fixtures/governance-architecture-decisions/valid", root, { recursive: true });
      await cp(
        "tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml",
        join(root, "architecture/foundation/governance-architecture-decisions.yaml"),
      );
      config.schemaVersion = 2;
      config.governanceConfigPath =
        "architecture/foundation/governance-architecture-decisions.yaml";
      config.sdkGrowth = {
        contractRevision: "foundation:sdk-growth:c0:5",
        policyVersion: "foundation:sdk-growth:policy:1",
        comparison: {
          trustedBasePath: "evidence/base.json",
          released: [
            {
              packageName: "@fixture/public-api",
              kind: "released",
              observationPath: "evidence/released.json",
            },
          ],
        },
        decisionsPath: "evidence/decisions.json",
        reportPath: "reports/sdk.json",
      };
      await writeFile(configPath, stringify(config));
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      await mkdir(join(root, "reports"));
      await mkdir(join(root, "evidence"));
      await writeFile(join(root, "evidence/decisions.json"), "[]");
      const releasedTyped = JSON.parse(
        await readFile(join(root, "architecture/public-api/public-api.json"), "utf8"),
      );
      await writeFile(
        join(root, "evidence/released.json"),
        JSON.stringify({
          typed: releasedTyped,
          artifact: {
            ...releasedTyped,
            extractorVersion: "package-artifact-inventory/1",
            entrypoints: [{ exportPath: ".", items: [] }],
          },
        }),
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture-root", private: true, version: "1.0.0" }),
      );
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["-C", root, "add", "packages"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);
      const first = check(root);
      assert.equal(first.result.status, 2, JSON.stringify(first.report));
      const capability = first.report.capabilities[0];
      assert.equal(capability.capabilityConfigSchemaVersion, 2);
      assert.equal(capability.problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
      assert.ok(
        capability.diagnostics.some(
          (row: { ruleId: string }) =>
            row.ruleId === "package.public-api-compatibility.sdk-growth-report",
        ),
        JSON.stringify(capability),
      );
      const bytes = await readFile(join(root, "reports/sdk.json"));
      const report = validateGrowthReport(JSON.parse(bytes.toString("utf8")), reportFingerprint);
      assert.equal(report.verdict, "incomplete");
      assert.equal(report.releaseEligible, false);
      assert.equal(report.contractRevision, "foundation:sdk-growth:c0:5");
      assert.deepEqual(report.transitionReceipts, []);
      assert.deepEqual(
        report.phases.map((row) => row.name),
        ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"],
      );
      assert.equal(report.phases.find((row) => row.name === "authority")?.status, "unavailable");
      assert.ok(report.trustedBaseComparison.status === "incomplete");
      assert.ok(report.trustedBaseComparison.reasons.includes("growth-authority-unverified"));
      assert.deepEqual(check(root).report, first.report);
      assert.deepEqual(await readFile(join(root, "reports/sdk.json")), bytes);
      const previousBreakingFingerprints = new Set(
        capability.diagnostics
          .filter(
            (row: { ruleId: string }) =>
              row.ruleId === "package.public-api-compatibility.breaking-change-not-approved",
          )
          .flatMap((row: { evidence: readonly { kind: string; value: string }[] }) =>
            row.evidence
              .filter((item) => item.kind === "change-fingerprint")
              .map((item) => item.value),
          ),
      );
      const declarationPath = join(root, "packages/library/dist/index.d.ts");
      const declaration = await readFile(declarationPath, "utf8");
      const originalCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      await writeFile(declarationPath, declaration.replace("value: string", "value: number"));
      execFileSync("git", ["-C", root, "add", "packages"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture parameter change",
      ]);
      const breaking = check(root);
      assert.equal(breaking.result.status, 2, JSON.stringify(breaking.report));
      assert.equal(breaking.report.capabilities[0].problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
      assert.ok(
        breaking.report.capabilities[0].diagnostics.some(
          (row: { ruleId: string; evidence: readonly { kind: string; value: string }[] }) =>
            row.ruleId === "package.public-api-compatibility.breaking-change-not-approved" &&
            row.evidence.some(
              (item) =>
                item.kind === "change-fingerprint" && !previousBreakingFingerprints.has(item.value),
            ),
        ),
        JSON.stringify(breaking.report),
      );
      const breakingReport = JSON.parse(await readFile(join(root, "reports/sdk.json"), "utf8"));
      assert.equal(breakingReport.verdict, "incomplete");
      assert.equal(breakingReport.releaseEligible, false);
      execFileSync("git", ["-C", root, "reset", "--hard", originalCommit], { stdio: "ignore" });
      assert.deepEqual(check(root).report, first.report);
      assert.ok(report.candidate.status === "available");
      const {
        sourceCommit,
        sourceTree,
        topologyDigest,
        lockDigest,
        toolchainDigest,
        artifactDigests,
      } = report.candidate.value;
      const base = {
        contractRevision: report.contractRevision,
        observationVersion: "foundation:sdk-growth:observation:1",
        repository: report.repository,
        sourceCommit,
        sourceTree,
        topologyDigest,
        lockDigest,
        toolchainDigest,
        artifactDigests,
        tool: report.tool,
        coverage: report.coverage,
        entries: Array.from({ length: 100001 }, () => ({})),
      };
      await writeFile(join(root, "evidence/base.json"), JSON.stringify(base));
      await writeFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n# Later observed inputs\n",
      );
      const later = check(root);
      assert.equal(later.result.status, 2, JSON.stringify(later.report));
      assert.equal(later.report.capabilities[0].problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
      const updated = await readFile(join(root, "reports/sdk.json"));
      assert.notDeepEqual(updated, bytes);
      assert.equal(
        validateGrowthReport(JSON.parse(updated.toString("utf8")), reportFingerprint).trustedBase
          .status,
        "unavailable",
      );
      assert.notEqual(
        JSON.parse(updated.toString("utf8")).candidate.value.lockDigest,
        report.candidate.status === "available" ? report.candidate.value.lockDigest : null,
      );
      assert.deepEqual(check(root).report, later.report);
      assert.deepEqual(await readFile(join(root, "reports/sdk.json")), updated);
      base.entries = [];
      base.sourceCommit = "invalid";
      await writeFile(join(root, "evidence/base.json"), JSON.stringify(base));
      assert.equal(check(root).result.status, 3);
      assert.deepEqual(await readFile(join(root, "reports/sdk.json")), updated);
    });
  });
}
function registerScopeDriftCase() {
  test("public check reports governed package scope drift without losing the full release scope", async () => {
    await withPublicApiFixture(async (root: string) => {
      const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      await cp("tests/fixtures/governance-architecture-decisions/valid", root, { recursive: true });
      await cp(
        "tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml",
        join(root, "architecture/foundation/governance-architecture-decisions.yaml"),
      );
      config.schemaVersion = 2;
      config.governanceConfigPath =
        "architecture/foundation/governance-architecture-decisions.yaml";
      config.sdkGrowth = {
        contractRevision: "foundation:sdk-growth:c0:5",
        policyVersion: "foundation:sdk-growth:policy:1",
        comparison: {
          trustedBasePath: "evidence/base.json",
          released: [
            {
              packageName: "@fixture/public-api",
              kind: "released",
              observationPath: "evidence/released.json",
            },
          ],
        },
        decisionsPath: "evidence/decisions.json",
        reportPath: "reports/sdk.json",
      };
      await writeFile(configPath, stringify(config));
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture-root", private: true, version: "1.0.0" }),
      );
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await mkdir(join(root, "reports"));
      await mkdir(join(root, "evidence"));
      await writeFile(join(root, "evidence/decisions.json"), "[]");
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["-C", root, "add", "packages", "pnpm-workspace.yaml"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);
      const baseline = check(root);
      assert.equal(baseline.result.status, 2, JSON.stringify(baseline.report));
      const baselineBytes = await readFile(join(root, "reports/sdk.json"));
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - other/*\n");
      execFileSync("git", ["-C", root, "add", "pnpm-workspace.yaml"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture scope drift",
      ]);
      const drift = check(root);
      assert.equal(drift.result.status, 2, JSON.stringify(drift.report));
      assert.equal(drift.report.capabilities[0].problem.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
      const driftBytes = await readFile(join(root, "reports/sdk.json"));
      assert.notDeepEqual(driftBytes, baselineBytes);
      const report = validateGrowthReport(
        JSON.parse(driftBytes.toString("utf8")),
        reportFingerprint,
      );
      assert.equal(report.verdict, "incomplete");
      assert.equal(report.releaseEligible, false);
      assert.equal(report.candidate.status, "available");
      assert.deepEqual(
        report.coverage.map((row) => row.packageName),
        ["@fixture/public-api", "fixture-root"],
      );
      assert.ok(
        report.coverage
          .find((row) => row.packageName === "@fixture/public-api")
          ?.dimensions.some(
            (row) =>
              row.dimension === "topology" &&
              row.status === "unavailable" &&
              row.reasons.includes("package-outside-observed-topology"),
          ),
      );
      assert.ok(report.trustedBaseComparison.status === "incomplete");
      assert.ok(
        report.trustedBaseComparison.reasons.includes("growth-release-topology-unavailable"),
      );
      assert.deepEqual(check(root).report, drift.report);
      assert.deepEqual(await readFile(join(root, "reports/sdk.json")), driftBytes);
    });
  });
}
