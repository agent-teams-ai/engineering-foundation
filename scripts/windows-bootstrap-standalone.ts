import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Private, nonqualifying diagnostic: one direct controller, one production
// managed launch per arm. No managed parent/observer, retries or asset edits.
assert.equal(process.platform, 'win32', 'Native Windows required.');
assert.match(process.version, /^v26\./u, 'Diagnostic controller requires Node 26.');
assert.equal(process.versions['bun'], undefined, 'Use the native Node controller.');
const repository = await realpath(process.cwd());
const output = resolve(process.argv[2] ?? (() => { throw new Error('Output path required.'); })());
const scratch = await realpath(process.env['RUNNER_TEMP'] ?? (() => { throw new Error('RUNNER_TEMP required.'); })());
assert.equal(await realpath(dirname(output)), scratch);
assert.equal(await realpath(tmpdir()), scratch);
const assets = join(repository, 'packages/engineering-foundation/assets/windows-managed-process');
const original = join(assets, 'bootstrap.ps1');
const helperPath = join(assets, 'WindowsManagedProcess.cs');
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: Stats): number[] => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
function checkedBytes(root: string, path: string, maximum = 4 * 1024 * 1024): Buffer {
  assert.equal(realpathSync(root), root);
  const nested = relative(root, path);
  assert.ok(nested.length > 0 && !isAbsolute(nested) && !nested.split(sep).includes('..'));
  const ancestry = [root]; let directory = root;
  for (const part of nested.split(sep).slice(0, -1)) { directory = join(directory, part); ancestry.push(directory); }
  const directories = ancestry.map(candidate => {
    const stat = lstatSync(candidate); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    return { path: candidate, dev: stat.dev, ino: stat.ino };
  });
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= maximum);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile());
    assert.deepEqual(identity(opened), identity(before));
    // Read at most the admitted size plus one byte; growth cannot allocate more.
    const bytes = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < bytes.length) {
      const observed = readSync(fd, bytes, count, bytes.length - count, null);
      if (observed === 0) { break; } count += observed;
    }
    assert.equal(count, opened.size);
    const after = lstatSync(path); assert.ok(after.isFile() && !after.isSymbolicLink());
    assert.deepEqual(identity(fstatSync(fd)), identity(opened));
    assert.deepEqual(identity(after), identity(opened));
    for (const candidate of directories) {
      const current = lstatSync(candidate.path); assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.deepEqual([current.dev, current.ino], [candidate.dev, candidate.ino]);
    }
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
const originalBytes = checkedBytes(repository, original), helperBytes = checkedBytes(repository, helperPath);
assert.equal(process.versions.node, checkedBytes(repository, join(repository, '.node-version'), 64).toString('utf8').trim());
const bootstrapSha256 = hash(originalBytes), helperSha256 = hash(helperBytes);
const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
assert.ok(systemRoot);
assert.ok(process.env['PATH'], 'Restricted launcher PATH required.');
const environment = Object.freeze({ PATH: process.env['PATH'], TMPDIR: scratch, TMP: scratch, TEMP: scratch, CI: 'true', SystemRoot: systemRoot });
const environmentKeys = Object.keys(environment).map(key => key.toLowerCase()).toSorted();
const owned = await mkdtemp(join(scratch, 'c1-TEST-single-wrapper-'));
const sourceRoot = join(owned, 'source');
const noopSource = "process.stdout.write(JSON.stringify({marker:'bootstrap-noop',node:process.version,bun:process.versions.bun??null,execPath:process.execPath,keys:Object.keys(process.env).map(k=>k.toLowerCase()).sort()}))";
type Variant = 'unqualified' | 'qualified' | 'imported';
const phaseNames = (variant: Variant): readonly string[] => ['entered', 'source-read', ...(variant === 'imported' ? ['module-import-start', 'module-import-end'] : []), 'add-type-start', 'add-type-end', 'request-ready', 'run-start', 'run-end'];
type Phase = { phase: string; epochMs: number; elapsedMs: number };
function readPhases(path: string, variant: Variant): Phase[] | null {
  try {
    const raw = checkedBytes(owned, path, 1024).toString('utf8');
    const names = phaseNames(variant);
    const phases: Phase[] = raw.trim().split('\n').map((line, index) => {
      const fields = /^([a-z-]+)\|(\d{13})\|(\d{1,8})$/u.exec(line); assert.ok(fields); assert.equal(fields[1], names[index]);
      return { phase: fields[1]!, epochMs: Number(fields[2]), elapsedMs: Number(fields[3]) };
    });
    for (let index = 1; index < phases.length; index++) { assert.ok(phases[index]!.elapsedMs >= phases[index - 1]!.elapsedMs); }
    return phases;
  } catch { return null; }
}
type Arm = { variant: Variant; round: number; bootstrap: string; bootstrapSha256: string; phasePath?: string; controls: Record<string, unknown>[]; observedEnvironmentEqual: boolean };
let active: Arm | undefined;
const results: Record<string, unknown>[] = [];
let cleanupFailed = false;
let custodyUncertain = false;
function assetsStable(arm: Arm): boolean {
  try { return hash(checkedBytes(repository, original)) === bootstrapSha256 && hash(checkedBytes(repository, helperPath)) === helperSha256 &&
    hash(checkedBytes(owned, arm.bootstrap)) === arm.bootstrapSha256 &&
    hash(checkedBytes(owned, join(dirname(arm.bootstrap), 'WindowsManagedProcess.cs'))) === helperSha256; }
  catch { return false; }
}
const save = async (): Promise<void> => {
  const text = JSON.stringify({ schemaVersion: 1, qualification: false, deadlineMs: 30000,
    controller: 'direct-node-no-managed-parent', order: ['unqualified', 'qualified', 'imported', 'unqualified', 'qualified', 'imported'],
    caveat: 'Six planned observations retain cold/warm and order effects; Add-Type invocation may include module discovery/import. No arm substitutes qualification or retries a failure.',
    bootstrapSha256, helperSha256, environmentKeys, controllerNode: process.version,
    imageOS: process.env['ImageOS'] ?? null, imageVersion: process.env['ImageVersion'] ?? null,
    sameFrozenLauncherAndRequestedEnvironment: true,
    hypothesis: 'Unqualified Add-Type includes command discovery and module autoload; explicit manifest import is timed separately, within the same complete managed deadline.',
    results, cleanupFailed, custodyUncertain, retainedScratchName: custodyUncertain ? basename(owned) : null }, null, 2) + '\n';
  assert.ok(Buffer.byteLength(text) <= 64 * 1024); await writeFile(output, text);
};
function instrument(bytes: Buffer, variant: Variant): string {
  const call = variant === 'unqualified' ? 'Add-Type' : 'Microsoft.PowerShell.Utility\\Add-Type';
  const importStep = variant === 'imported' ? "  $FailurePhase = 'utility-module-import'\n  Write-ProbePhase 'module-import-start'\n  Import-Module -Name $ProbeUtilityManifest -ErrorAction Stop\n  Write-ProbePhase 'module-import-end'\n  $FailurePhase = 'helper-compile'\n" : '';
  const moduleWitness = "\n  try {\n  $ProbeCommand = Get-Command 'Microsoft.PowerShell.Utility\\Add-Type' -CommandType Cmdlet -ErrorAction Stop\n  $ProbeWitness = @{ moduleName = $ProbeCommand.ModuleName; moduleVersion = $ProbeCommand.Module.Version.ToString(); expectedManifest = [string]::Equals([IO.Path]::GetFullPath($ProbeCommand.Module.Path), [IO.Path]::GetFullPath($ProbeUtilityManifest), [StringComparison]::OrdinalIgnoreCase) }\n  [IO.File]::WriteAllText(([IO.Path]::Combine($PSScriptRoot, 'utility.json')), ($ProbeWitness | ConvertTo-Json -Compress))\n  } catch {\n    try { [IO.File]::WriteAllText(([IO.Path]::Combine($PSScriptRoot, 'utility.json')), '{\"unknown\":true}') } catch { }\n  }";
  const source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  const prefix = `$ProbeClock = [Diagnostics.Stopwatch]::StartNew()\n$ProbeUtilityManifest = [IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')\nfunction Write-ProbePhase([string]$Name) {\n try { [System.IO.File]::AppendAllText(([System.IO.Path]::Combine($PSScriptRoot, 'phases.txt')), ($Name + '|' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '|' + $ProbeClock.ElapsedMilliseconds + [char]10)) } catch { }\n}\nWrite-ProbePhase 'entered'\n`;
  const changes: [string, string][] = [
    ['$ErrorActionPreference = "Stop"', prefix + '$ErrorActionPreference = "Stop"'],
    ['  $helperSource = [System.IO.File]::ReadAllText(', "  Write-ProbePhase 'source-read'\n  $helperSource = [System.IO.File]::ReadAllText("],
    ['  Add-Type -TypeDefinition $helperSource -Language CSharp', importStep + `  Write-ProbePhase 'add-type-start'\n  ${call} -TypeDefinition $helperSource -Language CSharp\n  Write-ProbePhase 'add-type-end'${moduleWitness}`],
    ['  $FailurePhase = "managed-run"', "  Write-ProbePhase 'request-ready'\n  $FailurePhase = \"managed-run\"\n  Write-ProbePhase 'run-start'"],
    ['  exit $exitCode', "  Write-ProbePhase 'run-end'\n  exit $exitCode"]
  ];
  let derived = source;
  for (const [anchor, replacement] of changes) { assert.equal(derived.split(anchor).length, 2); derived = derived.replace(anchor, replacement); }
  return derived;
}
const nativeSpawn = childProcess.spawn;
childProcess.spawn = new Proxy(nativeSpawn, { apply(target, receiver, args: unknown[]) {
  const arm = active;
  assert.ok(arm, 'Unexpected spawn outside an explicit arm.');
  const [command, argv, optionsValue] = args;
  assert.equal(typeof command, 'string'); assert.equal(basename(command as string).toLowerCase(), 'powershell.exe');
  assert.ok(Array.isArray(argv));
  assert.deepEqual(argv.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(argv.length, 7); assert.equal(realpathSync(argv[6]), original);
  assert.ok(typeof optionsValue === 'object' && optionsValue !== null);
  const options = optionsValue as SpawnOptions; assert.equal(typeof options.cwd, 'string');
  const controlRoot = realpathSync(options.cwd as string);
  assert.equal(resolve(options.cwd as string), controlRoot);
  assert.equal(dirname(controlRoot), scratch); assert.ok(basename(controlRoot).startsWith('agent-teams-foundation-process-'));
  const controlIdentity = lstatSync(controlRoot); assert.ok(controlIdentity.isDirectory() && !controlIdentity.isSymbolicLink());
  assert.deepEqual(options.env, environment); arm.observedEnvironmentEqual = true;
  const request = JSON.parse(checkedBytes(controlRoot, join(controlRoot, 'request.json'), 65536).toString('utf8')) as { command: string; args: string[]; cwd: string };
  assert.equal(realpathSync(request.command), realpathSync(process.execPath));
  assert.deepEqual(request.args, ['-e', noopSource]); assert.equal(realpathSync(request.cwd), sourceRoot);
  assert.equal(hash(checkedBytes(owned, arm.bootstrap)), arm.bootstrapSha256);
  const control: Record<string, unknown> = { spawnEpochMs: Date.now() }; arm.controls.push(control);
  assert.equal(arm.controls.length, 1, 'Exactly one managed wrapper per arm.');
  const started = performance.now();
  const sample = (): void => {
    try {
      const current = lstatSync(controlRoot);
      assert.deepEqual([current.dev, current.ino], [controlIdentity.dev, controlIdentity.ino]);
      for (const marker of ['launched', 'contained']) {
        if (control[marker] !== undefined) { continue; }
        try { const value = checkedBytes(controlRoot, join(controlRoot, marker), 16).toString('utf8');
          if ((marker === 'launched' && ['STARTED', 'FAILED'].includes(value)) || (marker === 'contained' && value === 'CONTAINED')) {
            control[marker] = { value, elapsedMs: performance.now() - started };
          }
        } catch { /* Missing markers remain unknown. */ }
      }
    } catch { /* Production may already have cleaned its owned control root. */ }
  };
  const child = Reflect.apply(target, receiver, [command, [...argv.slice(0, 6), arm.bootstrap], options]) as ChildProcess;
  const timer = setInterval(sample, 20); timer.unref();
  const finish = (): void => { sample(); clearInterval(timer); };
  child.once('exit', finish); child.once('error', finish); child.once('close', finish);
  return child;
} });
syncBuiltinESMExports();
try {
  await mkdir(sourceRoot);
  const { executeManagedProcess } = await import(pathToFileURL(join(repository, 'packages/engineering-foundation/dist/process-execution/node-process-runner.js')).href) as {
    executeManagedProcess: (request: { command: string; args: string[]; cwd: string; environment: Readonly<NodeJS.ProcessEnv>; timeoutMs: number }, context: { launcherEnvironment: Readonly<NodeJS.ProcessEnv> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  const { readProcessFailureFacts } = await import(pathToFileURL(join(repository, 'packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js')).href) as {
    readProcessFailureFacts: (error: unknown) => { reason: string } | undefined;
  };
  for (const [round, variant] of [[1, 'unqualified'], [1, 'qualified'], [1, 'imported'], [2, 'unqualified'], [2, 'qualified'], [2, 'imported']] as const) {
    if (custodyUncertain) { break; }
    const armRoot = join(owned, `${round}-${variant}`); await mkdir(armRoot);
    const bootstrap = join(armRoot, 'bootstrap.ps1');
    await writeFile(join(armRoot, 'WindowsManagedProcess.cs'), helperBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(bootstrap, instrument(originalBytes, variant), { flag: 'wx', mode: 0o600 });
    assert.equal(hash(checkedBytes(owned, join(armRoot, 'WindowsManagedProcess.cs'))), helperSha256);
    const arm: Arm = { variant, round, bootstrap, bootstrapSha256: hash(checkedBytes(owned, bootstrap)), controls: [], observedEnvironmentEqual: false,
      phasePath: join(armRoot, 'phases.txt') };
    active = arm; const started = performance.now();
    const result: Record<string, unknown> = { variant, round, bootstrapSha256: arm.bootstrapSha256, helperSha256 };
    let settled = false;
    try {
      const actual = await executeManagedProcess({ command: process.execPath, args: ['-e', noopSource], cwd: sourceRoot, environment, timeoutMs: 30000 }, { launcherEnvironment: environment });
      settled = true;
      result['exitCode'] = actual.exitCode;
      const phase = /\[phase=([a-z-]+)\]/u.exec(actual.stderr)?.[1]; if (phase !== undefined) { result['failurePhase'] = phase; }
      const observed = JSON.parse(actual.stdout) as { marker: string; node: string; bun: string | null; execPath: string; keys: string[] };
      result['noop'] = observed.marker === 'bootstrap-noop';
      result['nodeVersion'] = observed.node; result['nativeNode'] = observed.bun === null;
      result['childExecutableMatches'] = realpathSync(observed.execPath) === realpathSync(process.execPath);
      result['childEnvironmentKeysEqual'] = JSON.stringify(observed.keys) === JSON.stringify(environmentKeys);
      result['outcome'] = actual.exitCode === 0 && observed.marker === 'bootstrap-noop' && observed.node === process.version && observed.bun === null && result['childExecutableMatches'] === true && result['childEnvironmentKeysEqual'] === true ? 'passed' : 'failed';
    } catch (error) {
      result['outcome'] = 'failed'; result['failureKind'] = error instanceof Error ? error.name : 'non-Error';
      const facts = readProcessFailureFacts(error); result['failureReason'] = facts?.reason ?? null;
      custodyUncertain = !settled && (facts === undefined || facts.reason === 'cleanup');
    }
    finally {
      result['durationMs'] = performance.now() - started; active = undefined;
      result['controls'] = arm.controls; result['observedEnvironmentEqual'] = arm.observedEnvironmentEqual;
      const control = arm.controls[0];
      result['launchAndContainmentObserved'] = (control?.['launched'] as { value?: string } | undefined)?.value === 'STARTED' &&
        (control?.['contained'] as { value?: string } | undefined)?.value === 'CONTAINED';
      result['assetIdentityStable'] = assetsStable(arm);
      if (arm.phasePath !== undefined) {
        result['phases'] = readPhases(arm.phasePath, variant);
        result['phaseEvidenceUnavailable'] = result['phases'] === null;
        result['phaseEvidenceComplete'] = (result['phases'] as Phase[] | null)?.length === phaseNames(variant).length;
        const phases = result['phases'] as Phase[] | null;
        const duration = (start: string, end: string): number | null => {
          const from = phases?.find(item => item.phase === start), to = phases?.find(item => item.phase === end);
          return from === undefined || to === undefined ? null : to.elapsedMs - from.elapsedMs;
        };
        result['addTypeCallMs'] = duration('add-type-start', 'add-type-end');
        result['moduleImportMs'] = duration('module-import-start', 'module-import-end');
      }
      try {
        const witness = JSON.parse(checkedBytes(owned, join(armRoot, 'utility.json'), 1024).toString('utf8')) as { moduleName: string; moduleVersion: string; expectedManifest: boolean };
        result['utilityWitnessValid'] = witness.moduleName === 'Microsoft.PowerShell.Utility' && /^\d+(?:\.\d+){1,3}$/u.test(witness.moduleVersion) && witness.expectedManifest === true;
        result['utilityModule'] = { name: witness.moduleName.slice(0, 64), version: witness.moduleVersion.slice(0, 32), expectedManifest: witness.expectedManifest === true };
      } catch { result['utilityWitnessValid'] = false; }
      result['executionOutcome'] = result['outcome'];
      result['observationOutcome'] = arm.controls.length === 1 && arm.observedEnvironmentEqual && result['assetIdentityStable'] === true &&
        result['launchAndContainmentObserved'] === true && result['phaseEvidenceComplete'] === true && result['utilityWitnessValid'] === true ? 'complete' : 'incomplete';
      if (result['observationOutcome'] !== 'complete') { result['outcome'] = 'failed'; }
      results.push(result); await save();
    }
  }
} finally {
  childProcess.spawn = nativeSpawn; syncBuiltinESMExports();
  try { if (!custodyUncertain) { await rm(owned, { recursive: true }); } } catch { cleanupFailed = true; }
  await save();
}
if (cleanupFailed || results.length !== 6 || results.some(result => result['outcome'] !== 'passed' || result['launchAndContainmentObserved'] !== true || result['phaseEvidenceComplete'] !== true)) { process.exitCode = 1; }
