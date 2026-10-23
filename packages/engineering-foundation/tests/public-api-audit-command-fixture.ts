import type {
  AuditDeclarationInput,
  PublicApiAuditRequest,
} from "../src/capabilities/public-api-compatibility/contract/public-api-audit.js";
export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export type AuditRequestFixture = Mutable<PublicApiAuditRequest>;

import { NATIVE_EXTRACTOR_VERSION } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import { runPublicApiAudit } from "../dist/capabilities/public-api-compatibility/node.js";

export const digest = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export async function schemas() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validators: Record<string, ValidateFunction> = {};
  for (const kind of ["request", "report"]) {
    validators[`package-public-api-audit-${kind}/v1`] = ajv.compile(
      JSON.parse(
        await readFile(
          new URL(`../schemas/package-public-api-audit-${kind}/v1.schema.json`, import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  validators["package-public-api-baseline/v1"] = ajv.compile(
    JSON.parse(
      await readFile(
        new URL("../schemas/package-public-api-baseline/v1.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  return async (id: string, input: unknown) => {
    const validate = validators[id]!;
    assert.ok(validate(input), JSON.stringify(validate.errors));
  };
}

async function custodyDeclarations(
  root: string,
  subject: "A" | "C",
): Promise<Mutable<AuditDeclarationInput>> {
  await mkdir(join(root, subject));
  const files = {
    [`${subject}/package.json`]: JSON.stringify({
      name: "audit-custody",
      version: "1.0.0",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    [`${subject}/index.d.ts`]: "/** @internal */\nexport declare function _f(): string;\n",
    [`${subject}/tsconfig.json`]: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        skipLibCheck: false,
      },
      files: ["index.d.ts"],
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  const inventory = Object.entries(files).map(([path, content]) => ({
    path,
    digest: digest(content),
  }));
  return {
    packages: [
      {
        packageName: "audit-custody",
        packageVersion: "1.0.0",
        manifestPath: `${subject}/package.json`,
        tsconfigPath: `${subject}/tsconfig.json`,
        entrypoints: [{ exportPath: ".", declarationEntryPoint: `${subject}/index.d.ts` }],
        nonTypeExports: [],
      },
    ],
    files: inventory,
    resolutionUniverse: [
      { packageName: "audit-custody", exportPath: ".", declarationPath: `${subject}/index.d.ts` },
    ],
  };
}

export async function custodyFixture(root: string): Promise<AuditRequestFixture> {
  const declarationsA = await custodyDeclarations(root, "A");
  const declarationsC = await custodyDeclarations(root, "C");
  const A: AuditRequestFixture["subjects"]["A"] = {
    ...declarationsA,
    archive: { digest: digest("supplied"), extractedMembers: declarationsA.files },
  };
  const C: AuditRequestFixture["subjects"]["C"] = {
    ...declarationsC,
    build: {
      sourceIdentity: "synthetic",
      buildIdentity: "synthetic",
      declarations: declarationsC.files.filter((file) => file.path.endsWith(".d.ts")),
    },
  };
  const baseline = JSON.stringify({
    schemaVersion: 1,
    packageName: "audit-custody",
    packageVersion: "1.0.0",
    extractorVersion: NATIVE_EXTRACTOR_VERSION,
    entrypoints: [{ exportPath: ".", items: [] }],
  });
  await writeFile(join(root, "baseline.json"), baseline);
  const B: AuditRequestFixture["subjects"]["B"] = {
    baselines: [{ packageName: "audit-custody", path: "baseline.json", digest: digest(baseline) }],
  };
  return { schemaVersion: 1, subjects: { A, C, B } };
}

for (const fault of ["missing", "digest-mismatch"]) {
  test(`filesystem historical B ${fault} retains valid A-C findings`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-baseline-isolation-"));
    try {
      const request = await custodyFixture(root);
      const changed = "/** @internal */\nexport declare function _f(): number;\n";
      await writeFile(join(root, "C/index.d.ts"), changed);
      request.subjects.C.files = request.subjects.C.files.map((file) =>
        file.path === "C/index.d.ts" ? { ...file, digest: digest(changed) } : file,
      );
      request.subjects.C.build.declarations = request.subjects.C.files.filter((file) =>
        file.path.endsWith(".d.ts"),
      );
      const assertSchema = await schemas();
      const run = async () => {
        await writeFile(join(root, "request.json"), JSON.stringify(request));
        return runPublicApiAudit(
          { consumerRoot: root, configPath: "request.json", foundationVersion: "1.2.0" },
          assertSchema,
        );
      };
      const valid = await run();
      assert.equal(valid.exitCode, 0);
      const rich = valid.comparisons.find((comparison) => comparison.pair === "A-C");
      assert.equal(rich!.eligibility.eligible, true);
      assert.equal(rich!.findings!.classification, "breaking");
      if (fault === "missing") {
        await rm(join(root, "baseline.json"));
      } else {
        await writeFile(join(root, "baseline.json"), "{}\n");
      }
      const report = await run();
      await assertSchema("package-public-api-audit-report/v1", report);
      assert.equal(report.exitCode, 2);
      assert.equal(report.evidenceComplete, false);
      assert.equal(report.releaseEligible, false);
      assert.deepEqual(report.observations, valid.observations);
      assert.deepEqual(
        report.comparisons.find((comparison) => comparison.pair === "A-C"),
        rich,
      );
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0]!, /^B\/audit-custody: /u);
      assert.match(
        report.errors[0]!,
        fault === "missing" ? /ENOENT/u : /Baseline digest mismatch/u,
      );
      for (const historicalComparison of report.comparisons.filter(
        (comparison) => comparison.pair !== "A-C",
      )) {
        assert.equal(historicalComparison.eligibility.eligible, false);
        assert.ok(historicalComparison.eligibility.reasons.includes("stored-surface-unavailable"));
        assert.equal(historicalComparison.findings, undefined);
      }
      // Duplicate identities remain structural errors even when the first B is unreadable.
      request.subjects.B.baselines.push({
        ...request.subjects.B.baselines[0]!,
        path: "other.json",
      });
      await assert.rejects(run(), /Duplicate historical package/u);
      request.subjects.B.baselines.pop();
      // B isolation must not relax the initial validation of either subject's custody.
      for (const subject of ["A", "C"] as const) {
        const custody =
          subject === "A"
            ? request.subjects.A.archive.extractedMembers
            : request.subjects.C.build.declarations;
        const original = custody[0]!;
        // Custody and input inventory entries share objects in the fixture.
        // Replace the custody entry so only custody fails, while input bytes stay valid.
        const independentCustody = custody.map((file, index) =>
          index === 0 ? { ...file, digest: digest("invalid custody") } : file,
        );
        if (subject === "A") {
          request.subjects.A.archive.extractedMembers = independentCustody;
        } else {
          request.subjects.C.build.declarations = independentCustody;
        }
        await assert.rejects(run(), /Audit digest mismatch/u);
        independentCustody[0] = original;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

export async function admitCustodyFile(
  root: string,
  request: AuditRequestFixture,
  path: string,
  content: string,
) {
  await writeFile(join(root, path), content);
  const subject = request.subjects.A;
  subject.files = [
    ...subject.files.filter((file) => file.path !== path),
    { path, digest: digest(content) },
  ];
  subject.archive.extractedMembers = subject.files;
}
