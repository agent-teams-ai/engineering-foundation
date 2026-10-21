import { runCommand, type CommandInput } from './commands.js';

export async function main(args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  let cancelled = 0;
  const interrupt = () => { cancelled = 130; controller.abort(); };
  const terminate = () => { cancelled = 143; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const values = [...args];
    const command = values.shift();
    if (!['typecheck', 'lint', 'format:check', 'compile', 'doctor'].includes(command ?? '')) {
      process.stderr.write('Usage: stack-toolchain typecheck|lint|format:check|compile|doctor [--json] [--config path]\n');
      return 2;
    }
    let json = false;
    let configPath: string | undefined;
    const compileArgs: string[] = [];
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      if (value === '--json' && !json) {json = true;}
      else if (value === '--config' && configPath === undefined && values[index + 1] !== undefined && values[index + 1] !== '' && !values[index + 1]!.startsWith('-')) {configPath = values[++index]!;}
      else if (command === 'compile') {compileArgs.push(value);}
      else {throw new Error(`TOOLCHAIN_UNKNOWN_ARGUMENT:${value}`);}
    }
    const report = await runCommand({ command: command as CommandInput['command'], cwd: process.cwd(),
      signal: controller.signal, ...(configPath === undefined ? {} : { configPath }), compileArgs });
    process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, ...report })}\n`
      : `${report.command}: ${report.status}\n${JSON.stringify(report.details, null, 2)}\n`);
    return cancelled || report.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return cancelled || 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
