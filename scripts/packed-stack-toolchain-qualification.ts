import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runCommand } from "./pack-test-support.mjs";

function doctorRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Packed CI binds the diagnostic to its installed package's public metadata. */
export function validateInstalledDoctorReport(
  value: unknown,
  installedPackage: unknown,
  manifest: unknown,
): void {
  const report = doctorRecord(value),
    pins = doctorRecord(manifest),
    packageJson = doctorRecord(installedPackage);
  const dependencies = doctorRecord(packageJson["dependencies"]);
  const optionalDependencies = doctorRecord(packageJson["optionalDependencies"]);
  assert.equal(pins["schemaVersion"], 1);
  assert.equal(report["schemaVersion"], 1);
  assert.equal(report["command"], "doctor");
  assert.equal(report["status"], "passed");
  assert.equal(report["exitCode"], 0);
  assert.equal(typeof report["durationMs"], "number");
  assert.ok(Number.isFinite(report["durationMs"]) && Number(report["durationMs"]) >= 0);
  assert.deepEqual(report["versions"], pins);
  const details = doctorRecord(report["details"]);
  assert.equal(details["schemaVersion"], 1);
  assert.equal(packageJson["name"], "stack-toolchain");
  assert.equal(typeof packageJson["version"], "string");
  assert.equal(details["packageVersion"], packageJson["version"]);
  assert.ok(Array.isArray(details["findings"]));
  const optionalMissing = new Set<string>();
  for (const item of details["findings"]) {
    const finding = doctorRecord(item);
    assert.deepEqual(Object.keys(finding).toSorted(), ["code", "severity", "tool"]);
    assert.equal(finding["code"], "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE");
    assert.equal(finding["severity"], "info");
    assert.equal(typeof finding["tool"], "string");
    const tool = String(finding["tool"]);
    assert.equal(typeof pins[tool], "string");
    assert.ok(!optionalMissing.has(tool));
    optionalMissing.add(tool);
  }
  for (const [tool, expected] of Object.entries(pins)) {
    if (tool === "schemaVersion") {
      continue;
    }
    assert.equal(typeof expected, "string");
    const observation = doctorRecord(details[tool]);
    assert.equal(observation["expectedVersion"], expected);
    const required = Object.hasOwn(dependencies, tool);
    assert.notEqual(required, Object.hasOwn(optionalDependencies, tool));
    assert.equal(required ? dependencies[tool] : optionalDependencies[tool], expected);
    assert.equal(observation["required"], required);
    assert.equal(typeof observation["available"], "boolean");
    assert.ok(
      observation["installedVersion"] === null || observation["installedVersion"] === expected,
    );
    if (observation["available"]) {
      assert.equal(observation["resolvedVersion"], expected);
      assert.ok(
        ["binary-output", "installed-package"].includes(String(observation["versionSource"])),
      );
      assert.ok(!optionalMissing.has(tool));
    } else {
      assert.equal(observation["required"], false);
      assert.equal(observation["resolvedVersion"], null);
      assert.equal(observation["versionSource"], null);
      assert.ok(optionalMissing.has(tool));
    }
  }
}

const literalDigest = (files: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(files)).digest("hex");

function assertLiteralReport(
  report: Record<string, unknown>,
  file: string,
  exitCode: number,
): void {
  assert.equal(report["command"], "format:check");
  assert.equal(report["exitCode"], exitCode);
  assert.equal(report["status"], exitCode === 0 ? "passed" : "failed");
  const details = doctorRecord(report["details"]);
  const digest = literalDigest([file]);
  assert.deepEqual(Object.keys(details).toSorted(), [
    "attempted",
    "batches",
    "completed",
    "digests",
    "requested",
    "schemaVersion",
    "sourceBytesUnchanged",
    "validated",
  ]);
  assert.partialDeepStrictEqual(details, {
    schemaVersion: 1,
    requested: [file],
    validated: [file],
    attempted: [file],
    digests: { requested: digest, validated: digest, attempted: digest },
    completed: true,
    sourceBytesUnchanged: true,
  });
  assert.ok(Array.isArray(details["batches"]));
  assert.equal(details["batches"].length, 1);
  assert.partialDeepStrictEqual(details["batches"][0], {
    files: [file],
    completed: true,
    result: {
      exitCode,
      facts: { outputBounded: true, incompleteCustody: false, lateFailureCodes: [] },
    },
  });
}

async function qualifyLiteralTypes(root: string, cli: string): Promise<void> {
  const positive = `import { runCommand, formatFilesContractVersion,
    type CommandInput, type FormatFilesDetails } from "stack-toolchain";
    const marker: 1 = formatFilesContractVersion;
    const request: CommandInput = { command: "format:check", cwd: ".",
      signal: AbortSignal.abort(), formatFiles: ["input.json"] };
    void runCommand(request);
    const checked: FormatFilesDetails = { schemaVersion: marker,
      requested: [], validated: [], attempted: [],
      digests: { requested: "", validated: "", attempted: "" }, batches: [],
      completed: true, sourceBytesUnchanged: true };`;
  const types = join(root, "literal-types.ts");
  await writeFile(types, positive);
  await writeFile(
    join(root, "literal-types.json"),
    JSON.stringify({
      files: ["literal-types.ts"],
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: [],
      },
    }),
  );
  const compile = () =>
    runCommand(
      process.execPath,
      [cli, "compile", "--json", "--project", "literal-types.json"],
      root,
    );
  await compile();
  await writeFile(
    types,
    `${positive}
    request.formatFiles = [];
    checked.requested.push("mutated");
    const wrong: 2 = formatFilesContractVersion;
    void runCommand({ ...request, formatFiles: [123] });`,
  );
  let rejection: unknown;
  try {
    await compile();
  } catch (error) {
    rejection = error;
  }
  const failure = doctorRecord(rejection);
  assert.equal(failure["code"], 1);
  assert.equal(failure["terminationConfirmed"], true);
  const diagnostic = doctorRecord(JSON.parse(String(failure["stdout"])));
  assert.equal(diagnostic["exitCode"], 1);
  const output = String(doctorRecord(diagnostic["details"])["stdout"]);
  assert.deepEqual(output.match(/error TS\d+/gu)?.toSorted(), [
    "error TS2322",
    "error TS2322",
    "error TS2339",
    "error TS2540",
  ]);
  await writeFile(types, positive);
}

async function qualifyInstalledLiteralFormat(root: string, cli: string): Promise<void> {
  const negotiation = `const api = await import("stack-toolchain");
    if (api.formatFilesContractVersion !== 1) throw new Error("STACK_LITERAL_API_UNAVAILABLE");`;
  await runCommand(process.execPath, ["--input-type=module", "--eval", negotiation], root);
  const invoke = async (input: unknown) => {
    const program = `${negotiation}
      const report = await api.runCommand({ ...JSON.parse(process.argv[1]),
        cwd: process.cwd(), signal: new AbortController().signal });
      process.stdout.write(JSON.stringify(report));`;
    const result = await runCommand(
      process.execPath,
      ["--input-type=module", "--eval", program, JSON.stringify(input)],
      root,
    );
    return doctorRecord(JSON.parse(result.stdout));
  };
  await qualifyLiteralTypes(root, cli);
  const config = await readFile(join(root, "toolchain.config.json"));
  await writeFile(join(root, "toolchain.config.json"), "invalid configuration");
  await mkdir(join(root, "literal"));
  await writeFile(join(root, ".gitignore"), "literal/**\n");
  await writeFile(join(root, ".prettierignore"), "literal/**\n");
  await writeFile(join(root, "literal/.gitignore"), "*.json\n");
  const protectedBytes = '{"protected":[1,2]}';
  await writeFile(join(root, "protected.json"), protectedBytes);
  const cases: [string, string, string][] = [
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map(
      (ext): [string, string, string] => [
        `input.${ext}`,
        "const value={answer:1};",
        "const value = { answer: 1 };\n",
      ],
    ),
    ["input.json", '{"answer":[1,2]}', "{}\n"],
    ["input.jsonc", '{"answer":[1,2]}', "{}\n"],
    ["input.yaml", "answer: [1,2]", "answer: [1, 2]\n"],
    ["input.yml", "answer: [1,2]", "answer: [1, 2]\n"],
    ["input.md", "# Title\n\n-   item\n", "# Title\n\n- item\n"],
  ];
  const names = ["[abc].json", "{a,b}.json", "space ü.json", "!leading.json", "-dash.json"];
  if (process.platform !== "win32") {
    names.push("*.json", "?.json");
  }
  for (const name of names) {
    cases.push([name, '{"value":1}', "{}\n"]);
  }
  for (const [name, , good] of cases) {
    await writeFile(join(root, "literal", name), good);
  }
  for (const [name, bad, good] of cases) {
    const file = `literal/${name}`;
    for (const [source, expected] of [
      [bad, 1],
      [good, 0],
    ] as const) {
      await writeFile(join(root, file), source);
      const report = await invoke({ command: "format:check", formatFiles: [file] });
      assertLiteralReport(report, file, expected);
      assert.equal(await readFile(join(root, file), "utf8"), source);
    }
  }
  await writeFile(join(root, "unsupported.rs"), "unowned input");
  const mixed = await invoke({
    command: "format:check",
    formatFiles: ["literal/input.json", "unsupported.rs"],
  });
  assert.equal(mixed["exitCode"], 2);
  assert.equal(mixed["status"], "failed");
  assert.partialDeepStrictEqual(mixed["details"], {
    schemaVersion: 1,
    requested: ["literal/input.json", "unsupported.rs"],
    validated: ["literal/input.json"],
    attempted: [],
    digests: {
      requested: literalDigest(["literal/input.json", "unsupported.rs"]),
      validated: literalDigest(["literal/input.json"]),
      attempted: literalDigest([]),
    },
    batches: [],
    completed: false,
    sourceBytesUnchanged: null,
    failure: "TOOLCHAIN_FORMAT_UNSUPPORTED",
  });
  await writeFile(join(root, "toolchain.config.json"), config);
  assert.equal((await invoke({ command: "format:check" }))["exitCode"], 0);
  assert.equal(await readFile(join(root, "protected.json"), "utf8"), protectedBytes);
}

/** Runs only against an installed candidate in a disposable package consumer. */
export async function qualifyInstalledStackToolchain(consumerRoot: string): Promise<void> {
  const root = join(consumerRoot, "TEST-stack-toolchain");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module", scripts: { check: "exit 99" } }),
  );
  await writeFile(join(root, "index.ts"), 'export const value: string = "ready";\n');
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      files: ["index.ts"],
      compilerOptions: { strict: true, skipLibCheck: true, outDir: "dist" },
    }),
  );
  await writeFile(join(root, ".oxlintrc.json"), "{}");
  await writeFile(
    join(root, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: ["tsconfig.json"] },
      lint: { config: ".oxlintrc.json", paths: ["index.ts"] },
      format: { paths: ["index.ts"] },
    }),
  );
  await writeFile(
    join(root, "oxfmt.config.ts"),
    'import fs from "node:fs"; fs.writeFileSync("formatter-marker", "executed"); export default {};',
  );
  const cli = join(consumerRoot, "node_modules/stack-toolchain/dist/cli.js");
  const installed = createRequire(join(consumerRoot, "package.json"));
  const packageJson = doctorRecord(
    JSON.parse(await readFile(installed.resolve("stack-toolchain/package.json"), "utf8")),
  );
  assert.equal(packageJson["name"], "stack-toolchain");
  const manifest: unknown = JSON.parse(
    await readFile(installed.resolve("stack-toolchain/toolchain-manifest.json"), "utf8"),
  );
  const doctor = await runCommand(process.execPath, [cli, "doctor", "--json"], root);
  validateInstalledDoctorReport(JSON.parse(doctor.stdout), packageJson, manifest);
  for (const command of ["typecheck", "lint", "format:check"]) {
    const result = await runCommand(process.execPath, [cli, command, "--json"], root);
    assert.equal(JSON.parse(result.stdout).exitCode, 0, command);
  }
  await runCommand(
    process.execPath,
    [cli, "compile", "--json", "--project", "tsconfig.json"],
    root,
  );
  assert.match(await readFile(join(root, "dist/index.js"), "utf8"), /ready/u);
  await assert.rejects(readFile(join(root, "formatter-marker")), /ENOENT/u);
  const original = await readFile(join(root, "index.ts"), "utf8");
  await writeFile(join(root, "index.ts"), "export const value: string = 12;\n");
  let output = "";
  try {
    await runCommand(process.execPath, [cli, "typecheck", "--json"], root);
  } catch (error) {
    output = String((error as { stdout?: string }).stdout);
  }
  assert.match(output, /TS2322/u);
  await writeFile(join(root, "index.ts"), 'export const value:string="ready"');
  let formattingFailed = false;
  try {
    await runCommand(process.execPath, [cli, "format:check", "--json"], root);
  } catch {
    formattingFailed = true;
  }
  assert.equal(formattingFailed, true);
  assert.equal(await readFile(join(root, "index.ts"), "utf8"), 'export const value:string="ready"');
  await writeFile(join(root, "index.ts"), original);
  await qualifyInstalledLiteralFormat(root, cli);
}
