import test, { type TestContext } from "node:test";
import type { FeatureFixture } from "./feature-module-fixture-contract.ts";
export function registerInvalidFeatureProfileCases(
  fixture: (t: TestContext) => Promise<FeatureFixture>,
  rejects: (f: FeatureFixture, code: string) => Promise<void>,
): void {
  for (const [name, mutate, code] of [
    [
      "unowned behavior",
      (f: FeatureFixture) => f.write(`${f.sourceRoot}/utils.ts`, "export const read = () => 1;\n"),
      "unowned-source",
    ],
    [
      "module role",
      (f: FeatureFixture) => {
        f.profile.modules[0].role = "unknown";
      },
      "module-role",
    ],
    [
      "missing feature",
      (f: FeatureFixture) => {
        f.profile.modules[0].features = [];
      },
      "feature-required",
    ],
    [
      "standard digest drift",
      (f: FeatureFixture) => {
        f.profile.standard.digest = "sha256:wrong";
      },
      "standard-digest",
    ],
    [
      "unowned executable entrypoint",
      (f: FeatureFixture) =>
        f.write(
          "packages/example/package.json",
          JSON.stringify({
            name: "@fixture/example",
            version: "1.0.0",
            type: "module",
            exports: { ".": "./src/index.ts" },
            bin: "./scripts/hidden.js",
          }),
        ),
      "module-executable",
    ],
    [
      "open package subpaths",
      (f: FeatureFixture) =>
        f.write(
          "packages/example/package.json",
          JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module" }),
        ),
      "module-export",
    ],
    [
      "missing module inventory",
      (f: FeatureFixture) => {
        f.profile.modules = [];
      },
      "module-inventory",
    ],
    [
      "layer overlap",
      (f: FeatureFixture) => {
        f.profile.modules[0].features[0].layers.push({
          role: "adapters",
          roots: [`${f.sourceRoot}/features/alpha/application/index.ts`],
        });
      },
      "overlapping-ownership",
    ],
    [
      "empty layer",
      async (f: FeatureFixture) => {
        f.profile.modules[0].features[0].layers.push({
          role: "domain",
          roots: [`${f.sourceRoot}/features/alpha/domain`],
        });
        await f.write(`${f.sourceRoot}/features/alpha/domain/.gitkeep`, "");
      },
      "empty-layer",
    ],
    [
      "empty undeclared child layer",
      (f: FeatureFixture) =>
        f.write(`${f.sourceRoot}/features/alpha/application/empty/.gitkeep`, ""),
      "empty-layer",
    ],
    [
      "primitive without decision",
      async (f: FeatureFixture) => {
        const path = `${f.sourceRoot}/clock.ts`;
        f.profile.modules[0].exceptions.push({ path });
        await f.write(path, "export const clock = () => 1;\n");
      },
      "invalid-exception",
    ],
    [
      "blanket primitive exception",
      (f: FeatureFixture) => {
        f.profile.modules[0].exceptions.push({
          path: `${f.sourceRoot}/features`,
          decision: "decision.md",
          owner: "maintainers",
          rationale: "convenience",
          reviewTrigger: "later",
        });
      },
      "invalid-exception",
    ],
    [
      "unapproved scoped exception",
      async (f: FeatureFixture) => {
        const path = `${f.sourceRoot}/clock.ts`;
        f.profile.modules[0].exceptions.push({
          path,
          decision: "decision.md",
          owner: "maintainers",
          rationale: "primitive",
          reviewTrigger: "consumer change",
        });
        await f.write(path, "export const clock = () => 1;\n");
      },
      "exception-decision",
    ],
    [
      "ceremonial shared feature",
      (f: FeatureFixture) => {
        f.profile.modules[0].features[0].id = "shared";
      },
      "feature-identity",
    ],
    [
      "assembly hiding behavior",
      (f: FeatureFixture) =>
        f.write(
          `${f.sourceRoot}/index.ts`,
          "export function calculate(value: number) { if (value > 3) return 9; return 1; }\n",
        ),
      "assembly-behavior",
    ],
    [
      "export star surface",
      (f: FeatureFixture) =>
        f.write(
          `${f.sourceRoot}/features/alpha/application/index.ts`,
          "export * from './private.js';\n",
        ),
      "uncurated-entrypoint",
    ],
    [
      "unreachable adoption",
      (f: FeatureFixture) => f.write("README.md", "# Missing link\n"),
      "adoption-reachability",
    ],
    [
      "gate disconnected",
      (f: FeatureFixture) =>
        f.write(
          "package.json",
          JSON.stringify({
            name: "fixture-root",
            private: true,
            scripts: {
              "check:fast": "pnpm architecture:features:check",
              check: "node -e ''",
              "architecture:features:check": "node scripts/check-feature-modules.mjs",
            },
          }),
        ),
      "enforcement-command",
    ],
    [
      "broad boundary across features",
      (f: FeatureFixture) => {
        f.sourcePolicy.boundaries[0].roots.push(`${f.sourceRoot}/features/beta/application`);
        f.sourcePolicy.boundaries.splice(1, 1);
      },
      "boundary-ownership",
    ],
    [
      "unknown module on disk",
      (f: FeatureFixture) =>
        f.write(
          "packages/new/package.json",
          JSON.stringify({ name: "@fixture/new", version: "1.0.0" }),
        ),
      "source-policy",
    ],
    [
      "source outside selected roots",
      (f: FeatureFixture) => f.write("packages/example/extra.ts", "export const hidden = true;\n"),
      "source-policy",
    ],
    [
      "transport contracts in application",
      async (f: FeatureFixture) => {
        const root = `${f.sourceRoot}/features/alpha/contracts`;
        f.profile.modules[0].features[0].layers.push({ role: "contracts", roots: [root] });
        f.sourcePolicy.boundaries.push({
          id: "contracts",
          roots: [root],
          entrypoints: [`${root}/index.ts`],
          allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
        });
        f.sourcePolicy.boundaries[0].allow.boundaries.push("contracts");
        await f.write(`${root}/index.ts`, "export interface Transport { value: string }\n");
        await f.write(
          `${f.sourceRoot}/features/alpha/application/index.ts`,
          "import type { Transport } from '../contracts/index.js';\nexport const execute = (x: Transport) => x.value;\n",
        );
      },
      "layer-direction",
    ],
  ] as const) {
    void test(`rejects ${name}`, async (t) => {
      const f = await fixture(t);
      await mutate(f);
      await rejects(f, code);
    });
  }
}
