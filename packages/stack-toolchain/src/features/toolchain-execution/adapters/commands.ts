import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProcessExecutor } from 'node-or-bun';
import { createNodeProcessAdapter } from 'node-or-bun/node';
import { loadConfiguration } from './configuration.js';
import { resolveExecutables, resolveToolExecutable, resolveCompilerExecutable, resolveTsgolintExecutable } from './executables.js';
import { createCheckerRunner, type CheckerExecutable } from './process.js';
import { typecheck } from '../application/typecheck.js';

export interface CommandInput {
  readonly command: 'typecheck' | 'lint' | 'format:check' | 'compile' | 'doctor';
  readonly cwd: string;
  readonly configPath?: string;
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
  readonly compileArgs?: readonly string[];
}
export interface CommandReport {
  readonly command: CommandInput['command'];
  readonly status: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly details: unknown;
  readonly versions: unknown;
}
const executor = createProcessExecutor(createNodeProcessAdapter());
async function execute(executable: CheckerExecutable, args: readonly string[], cwd: string, signal: AbortSignal, env?: Readonly<Record<string, string>>) {
  const result = await executor.run({ command: executable.command, args: [...executable.prefix, ...args], cwd,
    signal, timeoutMs: 300_000, strictUtf8: true, ...(env === undefined ? {} : { environment: env }) });
  if (!result.facts.outputBounded || result.facts.incompleteCustody || result.facts.lateFailureCodes.length > 0) { throw new Error("TOOLCHAIN_INCOMPLETE_PROCESS_RESULT"); }
  return result;
}
async function doctor(input: CommandInput): Promise<Record<string, unknown>> {
  const executables = resolveExecutables();
      const versions: Record<string, unknown> = {};
      for (const [engine, executable] of Object.entries(executables)) {
        if (executable === null) { versions[engine] = { available: false }; continue; }
        const result = await execute(executable, ['--version'], input.cwd, input.signal);
        versions[engine] = { available: result.exitCode === 0, version: result.stdout.trim(), stderr: result.stderr };
      }
  return versions;
}
async function compile(input: CommandInput, executable: CheckerExecutable | null) {
  if (executable === null) {throw new Error('TOOLCHAIN_COMPILER_UNAVAILABLE');}
  const args = input.compileArgs ?? [];
  const validProject = args[0] === '--project' && args.length === 2;
  const validBuild = args[0] === '--build' && args.length >= 2;
  if ((!validProject && !validBuild) || args.slice(1).some(arg => arg.startsWith('-'))) {
    throw new Error('TOOLCHAIN_COMPILE_ARGUMENTS');
  }
  return execute(executable, args, input.cwd, input.signal);
}
async function check(input: CommandInput, config: Awaited<ReturnType<typeof loadConfiguration>>, started: number) {

      const remaining = (input.budgetMs ?? 300_000) - (performance.now() - started);
      if (remaining <= 0) { throw new Error('TOOLCHAIN_DEADLINE'); }
      const executables = resolveExecutables();
      const result = await typecheck({ projects: config.projects, signal: input.signal, budgetMs: remaining }, {
        run: createCheckerRunner({ cwd: config.root, executables, now: () => performance.now() }), now: () => performance.now()
      });
      return result;
}
function checkExit(result: Awaited<ReturnType<typeof typecheck>>, callerSignal: AbortSignal): number {
  if (result.status !== 'failed') { return 0; }
  if (result.code === 'TOOLCHAIN_DIAGNOSTICS') { return 1; }
  return result.code === 'TOOLCHAIN_CANCELLED' && callerSignal.aborted ? 130 : 2;
}
function toolEnvironment(command: CommandInput['command']): Readonly<Record<string, string>> | undefined {
  return command === 'lint' ? { OXLINT_TSGOLINT_PATH: resolveTsgolintExecutable() } : undefined;
}
export async function runCommand(input: CommandInput): Promise<CommandReport> {
  const started = performance.now();
  const originalSignal = input.signal;
  const report = (status: string, exitCode: number, details: unknown): CommandReport =>
    ({ command: input.command, status, exitCode, durationMs: performance.now() - started, details, versions });
  let versions: unknown = null;
  try {
    const budget = input.budgetMs ?? 300_000;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) { throw new Error('TOOLCHAIN_INVALID_BUDGET'); }
    const callerSignal = input.signal;
    input = { ...input, signal: AbortSignal.any([callerSignal, AbortSignal.timeout(budget)]) };
    input.signal.throwIfAborted();
    versions = JSON.parse(fs.readFileSync(new URL('../../../../toolchain-manifest.json', import.meta.url), 'utf8')) as unknown;
    if (input.command === 'doctor') {
      const details = await doctor(input);
      const required = details['typescript'] as { available: boolean };
      return report(required.available ? 'passed' : 'failed', required.available ? 0 : 2, details);
    }
    if (input.command === 'compile') {
      const result = await compile(input, resolveCompilerExecutable());
      return report(result.exitCode === 0 ? 'passed' : 'failed', result.exitCode === 0 ? 0 : 1, result);
    }
    const config = await loadConfiguration({ cwd: input.cwd, signal: input.signal, ...(input.configPath === undefined ? {} : { configPath: input.configPath }) });
    if (input.command === 'typecheck') {
      const result = await check(input, config, started);
      return report(result.status, checkExit(result, originalSignal), result);
    }
    const executable = resolveToolExecutable(input.command === 'lint' ? 'oxlint' : 'oxfmt');
    const args = input.command === 'lint'
      ? ['--type-aware', '--disable-nested-config', '--config', config.lint.config, '--', ...config.lint.paths]
      : ['--check', '--config', fileURLToPath(new URL('../../../../presets/format.json', import.meta.url)), '--disable-nested-config', '--', ...config.format.paths];
    const result = await execute(executable, args, config.root, input.signal, toolEnvironment(input.command));
    return report(result.exitCode === 0 ? 'passed' : 'failed', result.exitCode === 0 ? 0 : 1, result);
  } catch (error) {
    return report('failed', originalSignal.aborted ? 130 : 2,
      { message: error instanceof Error ? error.message : String(error) });
  }
}
