import test from "node:test";

async function executable(fixture, t, expression, { designated = true, shadow = false } = {}) {
  const f = await fixture(t);
  const cli = `${f.sourceRoot}/cli.ts`;
  f.profile.modules[0].moduleAssembly.push(cli);
  f.sourcePolicy.boundaries.push({ id: "cli", roots: [cli], entrypoints: [cli],
    allow: { boundaries: ["alpha"], packages: [], builtins: [], runtimeReferences: [] } });
  await f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0",
    type: "module", exports: { ".": "./src/index.ts" }, ...(designated ? { bin: { example: "./src/cli.ts" } } : {}) }));
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,
    "export async function execute(args: readonly string[]): Promise<number> { return args.length; }\n");
  const call = `execute(${expression})`;
  await f.write(cli, 'import { execute } from "./features/alpha/application/index.js";\n' +
    (shadow ? `export function start(process: { argv: string[] }) { return ${call}; }\n`
      : `process.exitCode = await ${call};\n`));
  return f;
}

export function registerExecutableArgumentsCases(fixture, expectPass, rejects) {
  for (const offset of [0, 2, 4]) {
    test(`CLI argv projection admits fixed offset ${offset}`, async (t) => {
      await expectPass(await executable(fixture, t, `process.argv.slice(${offset})`));
    });
  }
  for (const expression of [
    "process.argv.slice(Math.random())", "process.argv.slice(...[2])", "process.argv.slice(2, 4)",
    "process.argv.slice(-1)", "process.argv.slice(0.5)", "process.argv.slice(9007199254740992)",
    "process.argv.slice('2')", "process.argv.filter(Boolean)", "process.stdin.slice(2)",
    "foreign.argv.slice(2)", "process.argv['slice'](2)", "process.argv.slice?.(2)",
    "new process.argv.slice(2)",
  ]) {
    test(`CLI argv projection rejects ${expression}`, async (t) => {
      await rejects(await executable(fixture, t, expression), "assembly-behavior");
    });
  }
  test("CLI argv projection rejects a shadowed process", async (t) => {
    await rejects(await executable(fixture, t, "process.argv.slice(2)", { shadow: true }), "assembly-behavior");
  });
  test("CLI argv projection requires a manifest-designated executable", async (t) => {
    await rejects(await executable(fixture, t, "process.argv.slice(2)", { designated: false }), "assembly-behavior");
  });
}
