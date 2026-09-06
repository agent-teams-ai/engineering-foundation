import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function observeCommandFailures(dist) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const base = ${JSON.stringify(dist)};
    const { runFoundationCli } = await import(base + 'features/command-host/adapters/inbound/cli/foundation-cli.js');
    const { ScaffoldError } = await import(base + 'scaffolding/scaffold-error.js');
    const { ProcessCancellationError } = await import(base + 'process-execution/api.js');
    const { FoundationTransactionError } = await import(base + 'transaction-coordination/application/foundation-transaction-error.js');
    const observations = [];
    for (const kind of ['scaffold', 'transaction', 'cancellation', 'lookalike']) {
      for (const json of [false, true]) {
        for (const fault of ['none', 'code', 'message', 'write']) {
          const trace = [], sentinel = Object.freeze({ fault });
          const error = kind === 'scaffold' ? new ScaffoldError('SCAFFOLD_INPUT_INVALID', 'failure')
            : kind === 'transaction' ? new FoundationTransactionError({ requestedMutation: 'attach', status: {
              state: 'manual-recovery-required', diagnostics: [{ code: 'FOUNDATION_TRANSACTION_ACTIVE', message: 'failure' }]
            } }) : kind === 'cancellation' ? new ProcessCancellationError('failure') : { name: 'ScaffoldError', code: 'SCAFFOLD_INPUT_INVALID', message: 'failure' };
          let codeReads = 0;
          const code = error.code;
          Object.defineProperty(error, 'code', { get() {
            trace.push('code');
            if (fault === 'code') throw sentinel;
            codeReads++;
            return codeReads === 1 ? code : 'SCAFFOLD_APPLY_CONFLICT';
          }});
          Object.defineProperty(error, 'message', { get() {
            trace.push('message');
            if (fault === 'message') throw sentinel;
            return 'failure';
          }});
          const writeOut = process.stdout.write, writeErr = process.stderr.write, previous = process.exitCode;
          let stdout = '', stderr = '', rejected = false;
          process.stdout.write = (text) => { trace.push('stdout'); if (fault === 'write') throw sentinel; stdout += text; return true; };
          process.stderr.write = (text) => { trace.push('stderr'); if (fault === 'write') throw sentinel; stderr += text; return true; };
          process.exitCode = 17;
          try { await runFoundationCli(() => { throw error; }, ['status', ...(json ? ['--json'] : [])]); }
          catch (thrown) { assert.equal(thrown, sentinel); rejected = true; }
          finally {
            observations.push({ kind, json, fault, trace, stdout, stderr, rejected, exitCode: process.exitCode });
            process.stdout.write = writeOut; process.stderr.write = writeErr; process.exitCode = previous;
          }
        }
      }
    }
    console.log(JSON.stringify(observations));
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
