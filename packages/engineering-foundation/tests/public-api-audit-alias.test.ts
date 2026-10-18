import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AuditPackageInput } from "../src/capabilities/public-api-compatibility/contract/public-api-audit.js";
import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import { publicApiAuditEligibility, publicApiAuditPairEligibility } from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";

interface AliasFixture {
  readonly name: string;
  readonly core: string;
  readonly facade?: string;
  readonly assembly: string;
  readonly text: string;
  readonly targetPackage: string;
  readonly exportPath: string;
  readonly canonicalReference: string;
  readonly coreReferences: readonly string[];
  readonly facadeReferences?: readonly string[];
}
const fixtures: readonly AliasFixture[] = [
  { name: "renamed interface", core: "interface Original { value: string } export { Original as Renamed };\n",
    assembly: 'import type { Renamed } from "@fixture/core"; export type Query = Renamed;\n', text: "Renamed",
    targetPackage: "@fixture/core", exportPath: ".", canonicalReference: "@fixture/core!Renamed:interface",
    coreReferences: ["@fixture/core!Renamed:interface", "@fixture/core!Renamed#value:member"] },
  { name: "renamed function", core: "declare function original(x: string): string; export { original as renamed };\n",
    assembly: 'import { renamed } from "@fixture/core/extra"; export type Query = typeof renamed;\n', text: "renamed",
    targetPackage: "@fixture/core", exportPath: "./extra", canonicalReference: "@fixture/core!renamed:function(1)",
    coreReferences: ["@fixture/core!renamed:function(1)"] },
  { name: "renamed nested namespace", core: "declare namespace Internal { interface Thing { value: string } } export { Internal as Renamed };\n",
    assembly: 'import type { Renamed } from "@fixture/core/extra"; export type Query = Renamed.Thing;\n', text: "Renamed.Thing",
    targetPackage: "@fixture/core", exportPath: "./extra", canonicalReference: "@fixture/core!Renamed.Thing:interface",
    coreReferences: ["@fixture/core!Renamed:namespace", "@fixture/core!Renamed.Thing:interface", "@fixture/core!Renamed.Thing#value:member"] },
  { name: "facade owns its re-exported alias", core: "export interface Original { value: string }\n",
    facade: 'export { Original as Renamed } from "@fixture/core";\n',
    assembly: 'import type { Renamed } from "@fixture/facade/extra"; export type Query = Renamed;\n', text: "Renamed",
    targetPackage: "@fixture/facade", exportPath: "./extra", canonicalReference: "@fixture/facade!Renamed:interface",
    coreReferences: ["@fixture/core!Original:interface", "@fixture/core!Original#value:member"],
    facadeReferences: ["@fixture/facade!Renamed:interface", "@fixture/facade!Renamed#value:member"] }
];

for (const fixture of fixtures) {
  test(`native observer ${fixture.name} binds the actual exported model across A/C`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-alias-test-"));
    try {
      const definitions = [
        { name: "@fixture/core", directory: "node_modules/@fixture/core", source: fixture.core, references: fixture.coreReferences },
        ...(fixture.facade === undefined ? [] : [{ name: "@fixture/facade", directory: "node_modules/@fixture/facade", source: fixture.facade, references: fixture.facadeReferences! }]),
        { name: "@fixture/assembly", directory: "assembly", source: fixture.assembly, references: ["@fixture/assembly!Query:type"] }
      ];
      const files: Record<string, string> = {};
      const packages: AuditPackageInput[] = [];
      for (const definition of definitions) {
        const entrypoints = [{ exportPath: ".", declarationEntryPoint: `${definition.directory}/index.d.ts` },
          ...(definition.name === "@fixture/assembly" ? [] : [{ exportPath: "./extra", declarationEntryPoint: `${definition.directory}/index.d.ts` }])];
        files[`${definition.directory}/package.json`] = JSON.stringify({ name: definition.name, version: "1.0.0", types: "index.d.ts",
          dependencies: definition.name === "@fixture/assembly" ? { [fixture.targetPackage]: "1.0.0" } : definition.name === "@fixture/facade" ? { "@fixture/core": "1.0.0" } : {},
          exports: Object.fromEntries(entrypoints.map(entry => [entry.exportPath, { types: "./index.d.ts" }])) });
        files[`${definition.directory}/index.d.ts`] = definition.source;
        files[`${definition.directory}/tsconfig.json`] = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] });
        packages.push({ packageName: definition.name, packageVersion: "1.0.0", manifestPath: `${definition.directory}/package.json`, tsconfigPath: `${definition.directory}/tsconfig.json`, entrypoints, nonTypeExports: [] });
      }
      for (const [path, bytes] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), bytes);
      }
      const declarations = { packages, files: Object.entries(files).map(([path, bytes]) => ({ path, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })),
        resolutionUniverse: packages.flatMap(pkg => pkg.entrypoints.map(entry => ({ packageName: pkg.packageName, exportPath: entry.exportPath, declarationPath: entry.declarationEntryPoint }))) };
      const observer = new MicrosoftPublicApiObserver();
      const previous = await observer.observe({ consumerRoot: root, subject: "A", declarations });
      const candidate = await observer.observe({ consumerRoot: root, subject: "C", declarations });
      for (const [observations, subject] of [[previous, "A"], [candidate, "C"]] as const) {
        assert.equal(observations.length, fixture.facade === undefined ? 3 : 5);
        assert.deepEqual(observations.flatMap(observation => observation.unsupported), []);
        assert.ok(observations.every(observation => observation.invocation.succeeded && observation.modelPresent && observation.inputBytesRevalidated));
        assert.deepEqual(observations.flatMap(observation => observation.diagnostics.filter(diagnostic => diagnostic.severity === "error")), []);
        for (const definition of definitions) {
          const modeled = observations.filter(item => item.packageName === definition.name);
          assert.deepEqual(modeled.map(observation => observation.exportPath), definition.name === "@fixture/assembly" ? ["."] : [".", "./extra"]);
          for (const observation of modeled) {
            assert.deepEqual(observation.items.map(item => item.identity.canonicalReference).toSorted(), [...definition.references].toSorted());
          }
        }
        const assembly = observations.find(observation => observation.packageName === "@fixture/assembly");
        assert(assembly);
        assert.deepEqual(assembly.items.flatMap(item => item.references).map(reference => [reference.text, reference.canonicalReference, reference.resolution, reference.target]), [
          [fixture.text, fixture.canonicalReference, "same-subject-dependency", { subject, packageName: fixture.targetPackage, exportPath: fixture.exportPath, canonicalReference: fixture.canonicalReference }]
        ]);
        assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
        assert.equal(publicApiAuditEligibility(observations.filter(observation => observation.packageName !== fixture.targetPackage)).eligible, false);
      }
      assert.deepEqual(publicApiAuditPairEligibility(previous, candidate), { eligible: true, reasons: [] });
      assert.deepEqual(projectPublicApiObservation(previous, "@fixture/assembly").snapshot, projectPublicApiObservation(candidate, "@fixture/assembly").snapshot);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
