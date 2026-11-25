import { checkEffectProjects } from "./effect-check.js";

export async function runEffectCli(args: readonly string[], signal: AbortSignal): Promise<number> {
  if (args.length > 129) throw new Error("EFFECT_ARGUMENT_LIMIT");
  let json = false;
  const projects: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--json" && !json) json = true;
    else if (
      value === "--project" &&
      args[index + 1] !== undefined &&
      !args[index + 1]!.startsWith("-")
    )
      projects.push(args[++index]!);
    else throw new Error(`EFFECT_UNKNOWN_ARGUMENT:${String(value)}`);
  }
  const report = await checkEffectProjects({ cwd: process.cwd(), projects, signal });
  process.stdout.write(
    json
      ? `${JSON.stringify(report)}\n`
      : `${report.command}: ${report.status}\n${JSON.stringify(report.details, null, 2)}\n`,
  );
  return report.exitCode;
}
