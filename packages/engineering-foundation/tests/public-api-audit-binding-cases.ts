import assert from "node:assert/strict";
import test from "node:test";

import { tmpdir } from "node:os";
import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import {
  publicApiAuditEligibility,
  publicApiAuditPairEligibility,
} from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";
const inputFile = (path: string, text: string) => ({
  path,
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";

import { createHash } from "node:crypto";

import type { AuditPackageInput } from "../src/capabilities/public-api-compatibility/contract/public-api-audit.js";

for (const form of [
  "named-root",
  "named-extra",
  "inline-extra",
  "unused-root-inline-extra",
  "mixed-inline-paths",
  "overloaded-inline",
  "namespace-root",
  "namespace-extra",
  "paired-accessor",
  "paired-accessor-reversed",
]) {
  const importedPath = form === "named-root" || form === "namespace-root" ? "." : "./extra";
  const inline = form.includes("inline");
  const paths =
    form === "mixed-inline-paths" ||
    form === "overloaded-inline" ||
    form.startsWith("paired-accessor")
      ? [".", "./extra"]
      : inline
        ? [importedPath]
        : [importedPath, importedPath];
  const declaration = form.startsWith("paired-accessor")
    ? `import type { Core as Read } from "@fixture/core"; import type { Core as Write } from "@fixture/core/extra"; export declare class Use { ${form.endsWith("reversed") ? "set value(value: Write); get value(): Read;" : "get value(): Read; set value(value: Write);"} }\n`
    : form.startsWith("namespace-")
      ? `import type * as NS from "@fixture/core${importedPath === "." ? "" : "/extra"}"; export declare function use(x: NS.Core): NS.Core;\n`
      : form === "overloaded-inline"
        ? 'export declare function use(x: import("@fixture/core").Core): void;\nexport declare function use(x: import("@fixture/core/extra").Core, extra: string): void;\n'
        : form === "mixed-inline-paths"
          ? 'export declare function use(x: import("@fixture/core").Core, y: import("@fixture/core/extra").Core): void;\n'
          : inline
            ? `${form === "unused-root-inline-extra" ? 'import type { Core as Unused } from "@fixture/core";\n' : ""}export declare function use(x: import("@fixture/core/extra").Core): void;\n`
            : `import type { Core } from "@fixture/core${importedPath === "." ? "" : "/extra"}"; export declare function use(x: Core): Core;\n`;
  test(`cross-package ${form} binding preserves repeated canonical identities across A/C`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-dependency-test-"));
    try {
      const declarations = await prepareBindingDeclarations(root, declaration);
      const observations = await new MicrosoftPublicApiObserver().observe({
        consumerRoot: root,
        subject: "A",
        declarations,
      });
      assert(observations[0]);
      assert.deepEqual(
        observations.flatMap((observation) => observation.unsupported),
        [],
      );
      const assembly = observations.find(
        (observation) => observation.packageName === "@fixture/assembly",
      );
      assert(assembly);
      assert.equal(assembly.invocation.outcome, "completed", JSON.stringify(assembly));
      if (form === "overloaded-inline") {
        assert.deepEqual(
          assembly.items.map((item) => item.identity.canonicalReference),
          ["@fixture/assembly!use:function(1)", "@fixture/assembly!use:function(2)"],
        );
      }
      if (form.startsWith("paired-accessor")) {
        assert.deepEqual(
          assembly.items.map((item) => item.identity.canonicalReference).toSorted(),
          ["@fixture/assembly!Use#value:member", "@fixture/assembly!Use:class"],
        );
        const property = assembly.items.find(
          (item) => item.identity.canonicalReference === "@fixture/assembly!Use#value:member",
        );
        assert(property);
        assert.equal(property.excerpt, "get value(): Read;\nset value(value: Write);");
      }
      assert.deepEqual(
        assembly.items
          .flatMap((item) => item.references)
          .map((reference) => [
            reference.resolution,
            reference.target?.subject,
            reference.target?.packageName,
            reference.target?.exportPath,
            reference.target?.canonicalReference,
          ]),
        paths.map((path) => [
          "same-subject-dependency",
          "A",
          "@fixture/core",
          path,
          "@fixture/core!Core:interface",
        ]),
      );
      assert.equal(publicApiAuditEligibility(observations).eligible, true);
      const candidate = await new MicrosoftPublicApiObserver().observe({
        consumerRoot: root,
        subject: "C",
        declarations,
      });
      assert(candidate[0]);
      assert.deepEqual(publicApiAuditPairEligibility(observations, candidate), {
        eligible: true,
        reasons: [],
      });
      assert.deepEqual(
        projectPublicApiObservation(observations, "@fixture/assembly").snapshot,
        projectPublicApiObservation(candidate, "@fixture/assembly").snapshot,
      );
      assert.deepEqual(
        candidate
          .find((observation) => observation.packageName === "@fixture/assembly")!
          .items.flatMap((item) => item.references)
          .map((reference) => reference.target?.subject),
        paths.map(() => "C"),
      );
      assert.deepEqual(
        observations
          .filter((observation) => observation.packageName === "@fixture/core")
          .map((observation) => [
            observation.exportPath,
            observation.items.map((item) => item.identity.canonicalReference),
          ]),
        [
          [".", ["@fixture/core!Core:interface", "@fixture/core!Core#value:member"]],
          ["./extra", ["@fixture/core!Core:interface", "@fixture/core!Core#value:member"]],
        ],
      );
      const withoutCoreModel = observations.filter(
        (observation) => observation.packageName !== "@fixture/core",
      );
      assert.equal(publicApiAuditEligibility(withoutCoreModel).eligible, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const form of [
  "function-root",
  "function-extra",
  "instance-method-root",
  "instance-method-extra",
  "overloaded-function-root",
  "namespace-heritage-root",
  "namespace-heritage-extra",
  "whole-module-root",
] as const) {
  test(`external declaration ${form} preserves the actual declaration scope across A/C`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-type-query-test-"));
    try {
      const exportPath = form.endsWith("extra") ? "./extra" : ".";
      const specifier = exportPath === "." ? "@fixture/core" : "@fixture/core/extra";
      const method = form.startsWith("instance-method");
      const overloaded = form.startsWith("overloaded");
      const heritage = form.startsWith("namespace-heritage");
      const wholeModule = form.startsWith("whole-module");
      const rejected = overloaded || wholeModule;
      const declarations = await prepareTypeQueryDeclarations(root, {
        overloaded,
        wholeModule,
        specifier,
        heritage,
        method,
      });
      const observer = new MicrosoftPublicApiObserver();
      const previous = await observer.observe({ consumerRoot: root, subject: "A", declarations });
      const candidate = await observer.observe({ consumerRoot: root, subject: "C", declarations });
      for (const [observations, subject] of [
        [previous, "A"],
        [candidate, "C"],
      ] as const) {
        assert.deepEqual(
          observations.flatMap((observation) => observation.unsupported),
          [],
        );
        assert.ok(
          observations.every(
            (observation) => observation.modelPresent && observation.inputBytesRevalidated,
          ),
        );
        const assembly = observations.find(
          (observation) => observation.packageName === "@fixture/assembly",
        );
        assert(assembly);
        assert.deepEqual(
          assembly.items.map((item) => item.identity.canonicalReference),
          [heritage ? "@fixture/assembly!Query:class" : "@fixture/assembly!Query:type"],
        );
        const references = assembly.items.flatMap((item) => item.references);
        if (rejected) {
          assert.equal(assembly.invocation.outcome, "completed");
          assert.equal(assembly.invocation.succeeded, false);
          assert.equal(assembly.invocation.errorCount, 1);
          assert.deepEqual(
            observations.flatMap((observation) =>
              observation.diagnostics
                .filter((diagnostic) => diagnostic.severity === "error")
                .map((diagnostic) => [diagnostic.source, diagnostic.id, diagnostic.severity]),
            ),
            [
              [
                "extractor",
                wholeModule
                  ? "native-whole-module-import-reference"
                  : "native-external-overload-reference",
                "error",
              ],
            ],
          );
          assert.deepEqual(references, []);
          assert.deepEqual(publicApiAuditEligibility(observations), {
            eligible: false,
            reasons: ["non-forgotten-export-error"],
          });
        } else {
          assert.ok(observations.every((observation) => observation.invocation.succeeded));
          assert.deepEqual(
            observations.flatMap((observation) =>
              observation.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
            ),
            [],
          );
          const canonicalReference = heritage
            ? "@fixture/core!Box:class"
            : method
              ? "@fixture/core!Box#run:member(1)"
              : "@fixture/core!fn:function(1)";
          assert.deepEqual(
            references.map((reference) => [
              reference.text,
              reference.canonicalReference,
              reference.resolution,
              reference.target,
            ]),
            [
              [
                heritage ? "NS.Box" : method ? "box.run" : "fn",
                canonicalReference,
                "same-subject-dependency",
                { subject, packageName: "@fixture/core", exportPath, canonicalReference },
              ],
            ],
          );
          assert.deepEqual(publicApiAuditEligibility(observations), {
            eligible: true,
            reasons: [],
          });
          assert.equal(
            publicApiAuditEligibility(
              observations.filter((observation) => observation.packageName !== "@fixture/core"),
            ).eligible,
            false,
          );
        }
        const coreReferences = [
          "@fixture/core!Box:class",
          "@fixture/core!Box#run:member(1)",
          "@fixture/core!box:var",
          "@fixture/core!fn:function(1)",
          ...(overloaded ? ["@fixture/core!fn:function(2)"] : []),
        ].toSorted();
        assert.deepEqual(
          observations
            .filter((observation) => observation.packageName === "@fixture/core")
            .map((observation) => [
              observation.exportPath,
              observation.items.map((item) => item.identity.canonicalReference).toSorted(),
            ]),
          [
            [".", coreReferences],
            ["./extra", coreReferences],
          ],
        );
      }
      if (rejected) {
        assert.equal(publicApiAuditPairEligibility(previous, candidate).eligible, false);
      } else {
        assert.deepEqual(publicApiAuditPairEligibility(previous, candidate), {
          eligible: true,
          reasons: [],
        });
        assert.deepEqual(
          projectPublicApiObservation(previous, "@fixture/assembly").snapshot,
          projectPublicApiObservation(candidate, "@fixture/assembly").snapshot,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function prepareBindingDeclarations(root: string, declaration: string) {
  const files: Record<string, string> = {};
  const packages: AuditPackageInput[] = [];
  for (const name of ["core", "assembly"]) {
    const directory = name === "core" ? "node_modules/@fixture/core" : "assembly";
    await mkdir(join(root, directory), { recursive: true });
    files[`${directory}/package.json`] = JSON.stringify({
      name: `@fixture/${name}`,
      version: "1.0.0",
      ...(name === "assembly" ? { dependencies: { "@fixture/core": "1.0.0" } } : {}),
      types: "index.d.ts",
      exports: {
        ".": { types: "./index.d.ts" },
        ...(name === "core" ? { "./extra": { types: "./index.d.ts" } } : {}),
      },
    });
    files[`${directory}/index.d.ts`] =
      name === "core" ? "export interface Core { value: string }\n" : declaration;
    files[`${directory}/tsconfig.json`] = JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        skipLibCheck: false,
      },
      files: ["index.d.ts"],
    });
    packages.push({
      packageName: `@fixture/${name}`,
      packageVersion: "1.0.0",
      manifestPath: `${directory}/package.json`,
      tsconfigPath: `${directory}/tsconfig.json`,
      entrypoints: [
        { exportPath: ".", declarationEntryPoint: `${directory}/index.d.ts` },
        ...(name === "core"
          ? [{ exportPath: "./extra", declarationEntryPoint: `${directory}/index.d.ts` }]
          : []),
      ],
      nonTypeExports: [],
    });
  }
  for (const [path, bytes] of Object.entries(files)) {
    await writeFile(join(root, path), bytes);
  }
  const declarations = {
    packages,
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    })),
    resolutionUniverse: packages.flatMap((pkg) =>
      pkg.entrypoints.map((entry) => ({
        packageName: pkg.packageName,
        exportPath: entry.exportPath,
        declarationPath: entry.declarationEntryPoint,
      })),
    ),
  };

  return declarations;
}

async function prepareTypeQueryDeclarations(
  root: string,
  {
    overloaded,
    wholeModule,
    specifier,
    heritage,
    method,
  }: {
    overloaded: boolean;
    wholeModule: boolean;
    specifier: string;
    heritage: boolean;
    method: boolean;
  },
) {
  const files: Record<string, string> = {
    "node_modules/@fixture/core/package.json": JSON.stringify({
      name: "@fixture/core",
      version: "1.0.0",
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts" }, "./extra": { types: "./index.d.ts" } },
    }),
    "node_modules/@fixture/core/index.d.ts": `export declare function fn(x: string): string;\n${overloaded ? "export declare function fn(x: number): number;\n" : ""}export declare class Box { run(x: string): string; }\nexport declare const box: Box;\n`,
    "node_modules/@fixture/core/tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        skipLibCheck: false,
      },
      files: ["index.d.ts"],
    }),
    "assembly/package.json": JSON.stringify({
      name: "@fixture/assembly",
      version: "1.0.0",
      dependencies: { "@fixture/core": "1.0.0" },
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    "assembly/index.d.ts": wholeModule
      ? `export type Query = typeof import("${specifier}");\n`
      : heritage
        ? `import * as NS from "${specifier}"; export declare class Query extends NS.Box {}\n`
        : `import { ${method ? "box" : "fn"} } from "${specifier}"; export type Query = typeof ${method ? "box.run" : "fn"};\n`,
    "assembly/tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        skipLibCheck: false,
      },
      files: ["index.d.ts"],
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const packages: AuditPackageInput[] = [
    {
      packageName: "@fixture/core",
      packageVersion: "1.0.0",
      manifestPath: "node_modules/@fixture/core/package.json",
      tsconfigPath: "node_modules/@fixture/core/tsconfig.json",
      entrypoints: [
        { exportPath: ".", declarationEntryPoint: "node_modules/@fixture/core/index.d.ts" },
        {
          exportPath: "./extra",
          declarationEntryPoint: "node_modules/@fixture/core/index.d.ts",
        },
      ],
      nonTypeExports: [],
    },
    {
      packageName: "@fixture/assembly",
      packageVersion: "1.0.0",
      manifestPath: "assembly/package.json",
      tsconfigPath: "assembly/tsconfig.json",
      entrypoints: [{ exportPath: ".", declarationEntryPoint: "assembly/index.d.ts" }],
      nonTypeExports: [],
    },
  ];
  const declarations = {
    packages,
    files: Object.entries(files).map(([path, bytes]) => inputFile(path, bytes)),
    resolutionUniverse: packages.flatMap((pkg) =>
      pkg.entrypoints.map((entry) => ({
        packageName: pkg.packageName,
        exportPath: entry.exportPath,
        declarationPath: entry.declarationEntryPoint,
      })),
    ),
  };

  return declarations;
}
