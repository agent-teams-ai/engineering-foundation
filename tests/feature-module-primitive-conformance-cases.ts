import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { FeatureFixture } from "./feature-module-fixture-contract.ts";
import {
  factoryCaseData3,
  factoryCaseData4,
  factoryCaseData5,
  factoryCaseData6,
} from "./feature-module-conformance.test-data.ts";
type PrimitiveFixture = FeatureFixture & {
  record: { path: string; decision: string; consumers: { path: string; owner: string }[] };
};
type Fixture = (t: TestContext, role?: string) => Promise<FeatureFixture>;
type Dependencies = {
  fixture: Fixture;
  expectPass: (f: FeatureFixture) => Promise<void>;
  rejects: (f: FeatureFixture, code: string) => Promise<void>;
  compileFixture: (f: FeatureFixture) => Promise<void>;
  primitiveFixture: (t: TestContext, semantics?: string) => Promise<PrimitiveFixture>;
  qualifyPrimitive: (
    f: PrimitiveFixture,
    source: string,
    expected: unknown,
    lintRule?: RegExp,
  ) => Promise<Record<string, unknown>>;
};
export function registerPrimitiveConformanceCases({
  fixture,
  expectPass,
  rejects,
  compileFixture: compile,
  primitiveFixture,
  qualifyPrimitive,
}: Dependencies): void {
  for (const [label, source] of [
    [
      "const object increment",
      "const state = {count: 0}; export const compare = () => ++state.count;",
    ],
    [
      "const array push",
      "const state: number[] = []; export const compare = () => {state.push(1); return state.length;};",
    ],
    [
      "const function object escape",
      'const state = () => 0; export const compare = () => {const count = Reflect.get(state, "count") ?? 0; Reflect.set(state, "count", count + 1); return count + 1;};',
    ],
  ]) {
    void test(`primitive rejects runtime state: ${label}`, async (t) => {
      const f = await primitiveFixture(t);
      await expectPass(f);
      await f.write(f.record.path, source);
      for (const consumer of f.record.consumers) {
        await f.write(
          consumer.path,
          'import {compare} from "../../../compare.js"; export const execute = () => compare();',
        );
      }
      await compile(f);
      const run = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {compare} from ${JSON.stringify(pathToFileURL(join(f.repositoryRoot, f.record.path)).href)}; console.log(JSON.stringify([compare(),compare()]));`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), [1, 2]);
      await rejects(f, "impure-primitive");
    });
  }
  for (const source of factoryCaseData3) {
    void test(`primitive rejects module data mutation or unknown escape: ${source}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, source);
      await rejects(f, "impure-primitive");
    });
  }
  for (const source of [
    "const table = {a: -1, b: 1} as const; export const compare = () => table.a + table['b'];",
    "const table = [-1, 0, 1] as const; export const compare = () => table[0] + table.length;",
    "const table = {nested: {value: 1}}; export const compare = () => table.nested.value;",
    "export const compare = () => {const state = {count: 0}; return ++state.count;};",
    "export const compare = () => {const state: number[] = []; state.push(1); return state.length;};",
  ]) {
    void test(`primitive retains immutable tables or local working state: ${source}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, source);
      await expectPass(f);
    });
  }
  void test("primitive same-owner internal rename changes only the current caller mapping", async (t) => {
    const f = await primitiveFixture(t);
    await expectPass(f);
    const before = await readFile(join(f.repositoryRoot, f.record.decision));
    const caller = f.record.consumers[0],
      old = caller.path,
      current = old.replace("index.ts", "operation.ts");
    await f.write(current, await readFile(join(f.repositoryRoot, old), "utf8"));
    await f.write(old, 'export {execute} from "./operation.js";');
    caller.path = current;
    await expectPass(f);
    assert.deepEqual(await readFile(join(f.repositoryRoot, f.record.decision)), before);
    assert.ok(!before.toString().includes(current) && !before.toString().includes(old));
  });
  for (const [label, mutate] of [
    [
      "wrong current owner",
      (f: PrimitiveFixture) => {
        f.record.consumers[0].owner = "example/beta";
      },
    ],
    [
      "unknown current owner",
      (f: PrimitiveFixture) => {
        f.record.consumers[0].owner = "example/unknown";
      },
    ],
    [
      "package-wide owner",
      (f: PrimitiveFixture) => {
        f.record.consumers[0].owner = "example";
      },
    ],
    [
      "new semantic feature",
      (f: PrimitiveFixture) => {
        f.profile.modules[0].features[0].id = "gamma";
        f.record.consumers[0].owner = "example/gamma";
      },
    ],
    [
      "duplicate current path",
      (f: PrimitiveFixture) => {
        f.record.consumers.push(f.record.consumers[0]);
      },
    ],
    [
      "stale current path",
      async (f: PrimitiveFixture) => {
        const path = `${f.sourceRoot}/features/alpha/application/unused.ts`;
        await f.write(path, "export const unused = 1;");
        f.record.consumers.push({ path, owner: "example/alpha" });
      },
    ],
  ] as const) {
    void test(`primitive consumer mapping rejects ${label}`, async (t) => {
      const f = await primitiveFixture(t);
      await mutate(f);
      await rejects(f, "primitive-consumer");
    });
  }
  for (const field of [
    "semantics",
    "owner",
    "rationale",
    "purity",
    "versioning",
    "reviewTrigger",
    "consumers",
  ]) {
    void test(`primitive decision requires ${field}`, async (t) => {
      const f = await primitiveFixture(t),
        text = await readFile(join(f.repositoryRoot, f.record.decision), "utf8");
      const metadata = YAML.parse(text.split("---")[1]);
      delete metadata.primitiveScopes[f.record.path][field];
      await f.write(f.record.decision, `---\n${YAML.stringify(metadata)}---\n`);
      await rejects(f, "exception-decision");
    });
  }
  for (const script of ["lint:typed", "architecture:patterns"]) {
    void test(`feature adoption detects disconnected actual ${script} despite declaration`, async (t) => {
      const f = await fixture(t),
        pkg = JSON.parse(await readFile(join(f.repositoryRoot, "package.json"), "utf8"));
      pkg.scripts[script] = "true";
      await f.write("package.json", JSON.stringify(pkg));
      await rejects(f, "enforcement-command");
    });
  }

  for (const [label, source] of [
    [
      "R1 satisfies update",
      "const state = {count: 0}; export const compare = (): number => { (state.count satisfies number)++; return state.count; };",
    ],
    [
      "R2 ambient Object alias",
      'export const compare = (): number => { const target = Object; const previous: unknown = Reflect.get(target, "__ef_count"); const count = typeof previous === "number" ? previous : 0; Reflect.set(target, "__ef_count", count + 1); return count + 1; };',
    ],
  ]) {
    void test(`typed compiled primitive rejects ${label}`, async (t) => {
      const f = await primitiveFixture(t);
      const proof = await qualifyPrimitive(f, source, [1, 2]);
      const result = await f.check();
      t.diagnostic(JSON.stringify({ label, ...proof, guard: result }));
      assert.ok(
        result.problems.some(({ code }) => code === "impure-primitive"),
        JSON.stringify(result),
      );
    });
  }

  registerWrappedPrimitiveCases({ primitiveFixture, rejects, expectPass, qualifyPrimitive });
}
function registerWrappedPrimitiveCases({
  primitiveFixture,
  rejects,
  expectPass,
  qualifyPrimitive,
}: Pick<Dependencies, "primitiveFixture" | "rejects" | "expectPass" | "qualifyPrimitive">): void {
  for (const wrap of [
    (value: string) => `(${value} satisfies number)`,
    (value: string) => `(${value} as number)`,
    (value: string) => `${value}!`,
    (value: string) => `(<number>${value})`,
    (value: string) => `(((${value} as number)! satisfies number) as number)`,
  ]) {
    for (const target of ["state.count", "state.nested.count", "list[0]", "count"]) {
      for (const operation of [
        (value: string) => `${value} = 1`,
        (value: string) => `${value}++`,
        (value: string) => `delete ${value}`,
        (value: string) => `({value: ${value}} = {value: 1})`,
      ]) {
        const expression = operation(wrap(target));
        void test(`primitive wrapped module write rejects ${expression}`, async (t) => {
          const f = await primitiveFixture(t);
          await f.write(
            f.record.path,
            `const state = {count: 0, nested: {count: 0}}; const list = [0]; const count = 0; export const compare = () => {${expression}; return 1;};`,
          );
          await rejects(f, "impure-primitive");
        });
      }
    }
  }
  for (const body of factoryCaseData4) {
    void test(`primitive ambient or unknown escape rejects ${body}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, `export function compare() {${body} return 1;}`);
      await rejects(f, "impure-primitive");
    });
  }
  for (const source of factoryCaseData5) {
    void test(`primitive finite origins accept ${source}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, source);
      await expectPass(f);
    });
  }
  for (const [label, source, expected] of factoryCaseData6) {
    void test(`typed compiled primitive accepts ${label}`, async (t) => {
      const f = await primitiveFixture(t);
      const proof = await qualifyPrimitive(f, source, expected);
      await expectPass(f);
      t.diagnostic(JSON.stringify({ label, ...proof }));
    });
  }

  for (const operation of [
    "Object.assign(target, {count: 1})",
    'Object.defineProperty(target, "count", {value: 1})',
    "Object.defineProperties(target, {count: {value: 1}})",
    "Object.freeze(target)",
    "Object.seal(target)",
    "Object.preventExtensions(target)",
    'Reflect.set(target, "count", 1)',
    'Reflect.deleteProperty(target, "count")',
    'Reflect.defineProperty(target, "count", {value: 1})',
    "Reflect.preventExtensions(target)",
  ]) {
    void test(`primitive finite local target accepts ${operation}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(
        f.record.path,
        `export const compare = () => {const target = {count: 0}; ${operation}; return target.count;};`,
      );
      await expectPass(f);
    });
  }
  void test("primitive origin bound fails closed", async (t) => {
    const f = await primitiveFixture(t),
      aliases = Array.from(
        { length: 70 },
        (_, index) => `const alias${index + 1} = alias${index};`,
      ).join(" ");
    await f.write(
      f.record.path,
      `export const compare = () => {const alias0 = Reflect; ${aliases} return alias70;};`,
    );
    await rejects(f, "impure-primitive");
  });
  void test("typed composed Function control remains an existing Oxlint failure", async (t) => {
    const f = await primitiveFixture(t),
      proof = await qualifyPrimitive(
        f,
        'export const compare = (): number => (Function("return 1") as () => number)();',
        [1, 1],
        /no-new-func/u,
      );
    t.diagnostic(
      JSON.stringify({
        label: "existing Function restriction, not a third purity defect",
        ...proof,
      }),
    );
  });
}

export async function compileFixture(f: FeatureFixture): Promise<void> {
  await f.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ["packages/**/*.ts"],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "../node_modules/typescript/bin/tsc"),
      "-p",
      join(f.repositoryRoot, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: f.repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

export async function primitiveDecision(
  f: FeatureFixture,
  path: string,
  consumers: { path: string; owner: string }[],
  semantics = "Ordinal string comparison",
) {
  const record = { path, role: "domain", decision: "primitive.md", consumers };
  const scope = {
    semantics,
    owner: "platform-maintainers",
    rationale: "One ordering concept; duplication would break interoperability",
    purity: "Deterministic explicit inputs, no ambient or shared mutable state",
    versioning: "Version semantic changes with a successor decision and parity evidence",
    reviewTrigger:
      "Successor decision for semantic scope, owner, versioning or consuming feature/module changes",
    consumers: [...new Set(consumers.map((consumer) => consumer.owner))],
  };
  await f.write(
    record.decision,
    `---\n${YAML.stringify({ id: "ADR-9998", status: "accepted", primitiveScopes: { [path]: scope } })}---\n# Fixture decision only\n`,
  );
  return record;
}

export async function loadConformanceFacts() {
  const standard = await readFile(
    new URL("../standards/feature-module-standard-v1.md", import.meta.url),
  );
  const cases = JSON.parse(
    await readFile(new URL("fixtures/feature-modules/cases.json", import.meta.url), "utf8"),
  );
  return { standard, cases };
}
