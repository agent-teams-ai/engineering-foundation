import { relative, sep } from "node:path";
import { loadConfiguration } from "stack-toolchain";
import { checkEffectProjects } from "stack-toolchain/effect";

const signal = AbortSignal.timeout(120_000);
const configuration = await loadConfiguration({ cwd: process.cwd(), signal });
const projects = configuration.projects.map((path) => relative(configuration.root, path).split(sep).join("/"));
const report = await checkEffectProjects({ cwd: configuration.root, projects, signal, budgetMs: 100_000 });
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.exitCode;
