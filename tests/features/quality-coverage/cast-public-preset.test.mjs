import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const lint = join(repository, "node_modules/oxlint/bin/oxlint");
const nativeName = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
const wrapper = join(repository, "node_modules/oxlint-tsgolint/bin/tsgolint.js");
const native = dirname(createRequire(realpathSync(wrapper)).resolve(`${nativeName}/package.json`));
const environment = { ...process.env, OXLINT_TSGOLINT_PATH: join(native, process.platform === "win32" ? "tsgolint.exe" : "tsgolint") };
const execute = promisify(execFile);

async function runFixture(packageRoot) {
  const root = await mkdtemp(join(tmpdir(), "ef-331-quality-route-TEST-"));
  try {
    await mkdir(join(root, "presets"));
    await mkdir(join(root, "src"));
    for (const name of ["base", "node", "type-aware"]) {
      await cp(join(packageRoot, "presets/oxlint", `${name}.json`), join(root, "presets", `${name}.json`));
    }
    await writeFile(join(root, "oxlint.json"), JSON.stringify({ extends: ["./presets/type-aware.json"] }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"]
    }));
    const source = join(root, "src/main.ts");
    const cast = 'interface Trusted { readonly marker: "trusted" }\nexport const value = "unsafe" as unknown as Trusted;\n';
    const args = [lint, "--config", join(root, "oxlint.json"), "--deny-warnings", "--disable-nested-config", source];
    await writeFile(source, cast);
    const accepted = await execute(process.execPath, args, { cwd: root, env: environment });
    assert.equal(accepted.stdout, "");
    assert.equal(accepted.stderr, "");
    await writeFile(source, `${cast}Promise.resolve(1);\n`);
    await assert.rejects(execute(process.execPath, args, { cwd: root, env: environment }), (error) => {
      assert.equal(error.code, 1);
      assert.match(`${error.stdout}${error.stderr}`, /typescript\(no-floating-promises\)/u);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, /no-unsafe-type-assertion/u);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("built public quality preset accepts explicit unknown cast while typed lint remains active", async () => {
  await runFixture(join(repository, "packages/engineering-foundation"));
});

const installed = process.env["EF_331_INSTALLED_PACKAGE_ROOT"];
if (installed !== undefined) {
  test("installed public quality preset has the same cast behavior", async () => {
    const physical = await realpath(installed);
    assert.match(physical, /node_modules\/.*engineering-foundation/u);
    const manifest = JSON.parse(await readFile(join(physical, "package.json"), "utf8"));
    assert.equal(manifest.name, "@agent-teams/engineering-foundation");
    assert.equal(manifest.version, "1.5.1");
    await runFixture(installed);
  });
}
