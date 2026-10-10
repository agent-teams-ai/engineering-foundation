import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeManagedProcess } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";

// Disposable TEST branch only. Each cold PowerShell child inherits the real
// outer Job Object. 30s inner deadline; 90s TEST budget includes wrapper startup.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = fileURLToPath(import.meta.url);
const assetRoot = join(sourceRoot, "packages/engineering-foundation/assets/windows-managed-process");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const variant = process.argv[3];
const diagnostic = { stage: "entry", sourceSha256: null as string | null, helperSha256: null as string | null };
assert.equal(process.platform, "win32");

function replaceOnce(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length, 2, "exact derivation anchor required");
  return source.replace(anchor, replacement);
}

async function containedProbe(mode: string, root: string): Promise<void> {
  assert.ok(mode === "baseline" || mode === "explicit-utility");
  diagnostic.stage = "bootstrap-read";
  const original = await readFile(join(assetRoot, "bootstrap.ps1"));
  diagnostic.stage = "bootstrap-identity";
  diagnostic.sourceSha256 = hash(original);
  assert.ok([
    "7373da6764e631c222eefb42d56967e5adc5e4cc905ea229b18d30da56e4d3b7",
    "fa34bd6bde3d8ff5828c9ffb28b0e7b5e8855b5d2c423d61a80097040e430815"
  ].includes(hash(original)), "only reviewed LF/CRLF source accepted");
  diagnostic.stage = "helper-read";
  const helper = await readFile(join(assetRoot, "WindowsManagedProcess.cs"));
  diagnostic.stage = "helper-identity";
  diagnostic.helperSha256 = hash(helper);
  assert.ok([
    "e43e687de772639301306caab09619ca2916b00c27c7b5e0849d0f2544f66197",
    "a7c5bedb2db523fd41d099526943b73d7afe4ac46a033096beac9335a2346af7"
  ].includes(hash(helper)), "only reviewed LF/CRLF helper accepted");
  diagnostic.stage = "derive-bootstrap";
  let source = original.toString("utf8").replaceAll("\r\n", "\n");
  const prefix = [
    '$TestClock = [System.Diagnostics.Stopwatch]::StartNew()',
    'function Write-TestPhase([string]$Name) { [Console]::Out.WriteLine("TEST_PHASE|" + $Name + "|" + $TestClock.ElapsedMilliseconds) }',
    'Write-TestPhase "entered"',
    ...(mode === "explicit-utility" ? [
      '$PSModuleAutoLoadingPreference = "None"',
      'Write-TestPhase "import-start"',
      'try {',
      '  Import-Module -Name ([System.IO.Path]::Combine($PSHOME, "Modules", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1")) -Scope Local -ErrorAction Stop',
      '  Write-TestPhase "import-end"',
      '} catch { Write-TestPhase "import-failed"; exit 2 }'
    ] : [])
  ].join("\n") + "\n";
  source = replaceOnce(source, '  $FailurePhase = "helper-compile"',
    '  Write-TestPhase "source-read"\n  $FailurePhase = "helper-compile"');
  source = replaceOnce(source, '  Add-Type -TypeDefinition $helperSource -Language CSharp',
    '  Write-TestPhase "compile-start"\n  Add-Type -TypeDefinition $helperSource -Language CSharp\n  Write-TestPhase "compile-end"');
  source = replaceOnce(source, '  $FailurePhase = "bootstrap-request"',
    '  Write-TestPhase "request-start"\n  $FailurePhase = "bootstrap-request"');
  diagnostic.stage = "helper-copy";
  await copyFile(join(assetRoot, "WindowsManagedProcess.cs"), join(root, "WindowsManagedProcess.cs"));
  const script = join(root, "bootstrap.ps1");
  diagnostic.stage = "bootstrap-write";
  await writeFile(script, prefix + source, { flag: "wx" });
  diagnostic.stage = "powershell-path";
  const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === "systemroot")?.[1];
  assert.ok(systemRoot);
  diagnostic.stage = "environment-source-bindings";
  for (const [path, lf, crlf] of [
    ["tests/c1-test-support.mts", "91bd11327231567a489ea9d844b7cd0740f98806478a8c1d991eec83d62616bc", "80fd6465c8b47bf0c0045eebca934d30df03b0454800ca1431fb95c7d78f6610"],
    ["packages/engineering-foundation/src/process-execution/windows-managed-process.ts", "cb75c05a7a160030fcd6c601883957f7fb7f17798e480274d64e5a51ce474337", "17bb035855356dd62f1057ed444a76ea44a5451ce5d692c8d7c449991a6bac23"]
  ] as const) {
    const bytes = await readFile(join(sourceRoot, path));
    assert.ok(new Set<string>([lf, crlf]).has(hash(bytes)), "exact environment policy source required");
  }
  diagnostic.stage = "environment-projection";
  assert.equal(typeof process.env["PATH"], "string");
  // Exact c1 execute() projection, with its fixture-owned scratch selected as
  // root here. The adapter injects SystemRoot from the launcher environment.
  const environment = { HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root, PATH: process.env["PATH"], TMPDIR: root, TMP: root,
    TEMP: root, CI: "true", SystemRoot: systemRoot };
  const policy = { sourceHead: "373e4549104610633d65b043366f8b044cdf1528",
    supportLF: "91bd11327231567a489ea9d844b7cd0740f98806478a8c1d991eec83d62616bc",
    adapterLF: "cb75c05a7a160030fcd6c601883957f7fb7f17798e480274d64e5a51ce474337",
    scratchKeys: ["HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP"],
    inheritedKeys: ["PATH", "SystemRoot"], constants: { CI: "true" } };
  const observedKeys = ["HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "PATH", "TMPDIR", "TMP", "TEMP", "CI", "SystemRoot", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "ProgramFiles", "PSModulePath"];
  const presence = Object.fromEntries(observedKeys.map((name) => [name,
    Object.keys(environment).some((key) => key.toLowerCase() === name.toLowerCase())]));
  writeSync(1, JSON.stringify({ mode, outcome: "environment-bound", policySha256: hash(JSON.stringify(policy)), presence }) + "\n");
  diagnostic.stage = "powershell-spawn";
  const child = spawn(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { cwd: root, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  const started = performance.now();
  const timer = setTimeout(() => {
    writeSync(1, JSON.stringify({ mode, outcome: "inner-deadline", elapsedMs: performance.now() - started, phases: phaseRows(stdout.slice(0, stdout.lastIndexOf("\n") + 1)) }) + "\n");
    // Exiting the contained Node parent invokes the wrapper's whole-job cleanup,
    // including a still-running compiler descendant. Do not continue after timeout.
    process.exit(3);
  }, 30_000);
  try {
    diagnostic.stage = "powershell-await";
    const result = await new Promise<number | null>((resolveExit, reject) => {
      for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]] as const) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16_384) { process.exit(4); }
          if (isError) stderr += chunk; else stdout += chunk;
        });
      }
      child.on("error", reject);
      child.on("close", resolveExit);
      child.stdin.on("error", () => { /* close/error result remains authoritative */ });
      child.stdin.end(JSON.stringify({ schemaVersion: 0 }));
    });
    diagnostic.stage = "validate-result";
    const phases = phaseRows(stdout);
    const passed = result === 1 && stderr.includes("[phase=bootstrap-request]") &&
      stderr.includes("Unsupported Windows managed-process bootstrap schema.");
    process.stdout.write(JSON.stringify({ mode, outcome: passed ? "schema-rejected" : "unexpected-result", exitCode: result,
      elapsedMs: performance.now() - started, sourceSha256: hash(original), helperSha256: hash(helper), phases }) + "\n");
    assert.ok(passed, "real helper must compile then reject schema0");
    assert.deepEqual(phases.map(([name]) => name), mode === "baseline"
      ? ["entered", "source-read", "compile-start", "compile-end", "request-start"]
      : ["entered", "import-start", "import-end", "source-read", "compile-start", "compile-end", "request-start"]);
  } finally { clearTimeout(timer); }
}

function phaseRows(stdout: string): [string, number][] {
  const rows: [string, number][] = [];
  if (stdout.trim() === "") return rows;
  for (const line of stdout.trim().split(/\r?\n/u)) {
    const match = /^TEST_PHASE\|(entered|import-start|import-end|import-failed|source-read|compile-start|compile-end|request-start)\|([0-9]+)$/u.exec(line);
    assert.ok(match, "only finite phase output accepted");
    const elapsed = Number(match[2]);
    assert.ok(Number.isSafeInteger(elapsed) && elapsed >= (rows.at(-1)?.[1] ?? 0));
    rows.push([match[1]!, elapsed]);
  }
  return rows;
}

if (process.argv[2] === "--contained") {
  assert.ok(variant);
  const root = process.argv[4];
  assert.ok(root);
  try { await containedProbe(variant, root); }
  catch (error) {
    writeSync(1, JSON.stringify({ mode: variant, outcome: "probe-failure", ...diagnostic,
      errorCategory: error instanceof assert.AssertionError ? "assertion" : "probe-error" }) + "\n");
    process.exitCode = 1;
  }
} else {
  const outcomes: number[] = [];
  for (const mode of ["baseline", "explicit-utility"]) {
    const root = await mkdtemp(join(tmpdir(), "foundation TEST cold bootstrap "));
    let confirmed = false;
    try {
      const result = await executeManagedProcess({ command: process.execPath,
        args: [fixturePath, "--contained", mode, root], cwd: sourceRoot,
        timeoutMs: 90_000, strictUtf8: true, environment: process.env });
      confirmed = true;
      process.stdout.write(result.stdout);
      process.stdout.write(JSON.stringify({ mode, outerExitCode: result.exitCode, containment: "confirmed" }) + "\n");
      outcomes.push(result.exitCode);
    } catch {
      writeSync(1, JSON.stringify({ mode, outcome: "outer-executor-rejected", containment: "unconfirmed", rootRetained: true }) + "\n");
      throw new Error("Contained probe executor rejected; fixed receipt retained.");
    } finally {
      // A rejected outer cleanup preserves the root and aborts further probes.
      if (confirmed) await rm(root, { force: true, recursive: true });
    }
  }
  assert.ok(outcomes.every((code) => code === 0), "one or more fixed probe receipts failed");
}
