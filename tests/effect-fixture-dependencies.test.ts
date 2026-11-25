import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  assertInstalledEffectFixtureDependencies,
  type EffectFixtureDependencies,
} from "../scripts/effect-fixture-dependencies.ts";

async function fixture(t: TestContext, publishConfig?: Record<string, unknown>) {
  const consumerRoot = await mkdtemp(join(tmpdir(), "TEST-effect-payload-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  const packageRoot = join(consumerRoot, "node_modules", "@fixture", "native");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  const manifest = {
    name: "@fixture/native",
    version: "1.0.0",
    ...(publishConfig === undefined ? {} : { publishConfig }),
  };
  const source = Buffer.from("inert fixture bytes\n");
  const program = join(packageRoot, "bin", "tool");
  await writeFile(program, source);
  await chmod(program, 0o755);
  const manifestPath = join(packageRoot, "package.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  const files = [];
  for (const [path, bytes] of [
    ["bin/tool", source],
    ["package.json", manifestBytes],
  ] as const) {
    files.push({
      path,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: ((await lstat(join(packageRoot, path))).mode & 0o111) !== 0,
    });
  }
  const cohort: EffectFixtureDependencies = {
    pins: { "@fixture/native": "1.0.0" },
    roots: [
      {
        identity: "@fixture/native@1.0.0",
        root: packageRoot,
        manifest,
        integrity: "fixture",
        files,
      },
    ],
    receiptPath: join(consumerRoot, "unused-receipt.json"),
  };
  return { consumerRoot, packageRoot, manifest, manifestPath, program, cohort };
}

test("installed fixture accepts original bytes and the exact seed executable normalization", async (t) => {
  for (const publish of [undefined, { access: "public" }, { executableFiles: ["historical"] }]) {
    const input = await fixture(t, publish);
    await assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort);
    const executableFiles = input.cohort.roots[0]!.files.filter((file) => file.executable).map(
      (file) => file.path,
    );
    await writeFile(
      input.manifestPath,
      JSON.stringify(
        {
          ...input.manifest,
          publishConfig: { ...publish, executableFiles },
        },
        null,
        2,
      ),
    );
    await assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort);
  }
});

test("executable normalization cannot conceal additional manifest changes", async (t) => {
  const input = await fixture(t);
  const executableFiles = input.cohort.roots[0]!.files.filter((file) => file.executable).map(
    (file) => file.path,
  );
  for (const manifest of [
    { ...input.manifest, publishConfig: { executableFiles: ["not-the-observed-member"] } },
    { ...input.manifest, publishConfig: { executableFiles, tag: "changed" } },
    { ...input.manifest, version: "2.0.0", publishConfig: { executableFiles } },
  ]) {
    await writeFile(input.manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    );
  }
});

test("installed fixture rejects changed, additional and missing payload files", async (t) => {
  const input = await fixture(t);
  await writeFile(input.program, "changed fixture bytes\n");
  await assert.rejects(
    assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    /payload differs/u,
  );
  await writeFile(input.program, "inert fixture bytes\n");
  await writeFile(join(input.packageRoot, "additional"), "unverified");
  await assert.rejects(
    assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    /payload differs/u,
  );
  await rm(join(input.packageRoot, "additional"));
  await rm(input.program);
  await assert.rejects(
    assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    /payload differs/u,
  );
});

test("installed fixture rejects a payload file replaced by a link", async (t) => {
  const input = await fixture(t);
  const outside = join(input.consumerRoot, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "tool"), "inert fixture bytes\n");
  await rm(join(input.packageRoot, "bin"), { recursive: true });
  await symlink(
    outside,
    join(input.packageRoot, "bin"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    /contains a link/u,
  );
});

test("installed fixture rejects an unadmitted nested dependency tree", async (t) => {
  const input = await fixture(t);
  await mkdir(join(input.packageRoot, "node_modules", "unverified"), { recursive: true });
  await assert.rejects(
    assertInstalledEffectFixtureDependencies(input.consumerRoot, input.cohort),
    /unadmitted nested dependency/u,
  );
});
