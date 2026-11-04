import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveNodeToolInvocation } from "./repository-command.mts";
import { resolveQualificationExecutables } from "./executable-policy.mts";
import { admitRepositoryTypeScript } from "./typescript-admission.ts";

const root = process.cwd();

function observed(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Native tool qualification failed for ${command}: ${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

const nodeRuntime = await resolveQualificationExecutables("node");
const compiler = await admitRepositoryTypeScript(root);
const expected = [
  {
    name: "oxlint",
    entry: resolve(root, "node_modules/oxlint/bin/oxlint"),
    args: ["--version"],
    output: /^Version: 1\.83\.0$/u,
  },
  {
    name: "typescript",
    entry: compiler.entry,
    args: ["--version"],
    output: new RegExp(`^Version ${compiler.version.replaceAll(".", "\\.")}$`, "u"),
  },
  // Nx 23.3.0 removes Axios and uses the patched TOML parser.
  {
    name: "nx",
    entry: resolve(root, "node_modules/nx/dist/bin/nx.js"),
    args: ["--version"],
    output: /^Nx Version:\r?\n- Local: v23\.3\.0\r?\n- Global: [^\r\n]+$/u,
  },
  // esbuild's supported JS entry resolves its optional native package in the
  // package's own installed context; do not assume root hoisting or a platform map.
  {
    name: "esbuild",
    entry: resolve(root, "node_modules/esbuild/bin/esbuild"),
    args: ["--version"],
    output: /^0\.28\.2$/u,
  },
] as const;

for (const tool of expected) {
  const invocation = resolveNodeToolInvocation(tool.entry, tool.args, [], nodeRuntime.node);
  const output = observed(invocation.command, invocation.args);
  if (!tool.output.test(output)) {
    throw new Error(`${tool.name} version mismatch: ${output}`);
  }
}

const oxcManifest = JSON.parse(
  await readFile(resolve(root, "node_modules/oxc-parser/package.json"), "utf8"),
) as { readonly version?: string };
if (oxcManifest.version !== "0.142.0") {
  throw new Error(`Oxc parser version mismatch: ${oxcManifest.version ?? "missing"}`);
}
const oxcExpression =
  "require('oxc-parser').parseSync('qualification.ts','export const value: number = 1;');";
observed(nodeRuntime.node, ["-e", `${oxcExpression} process.stdout.write('node');`]);

// The Bun proof is separate from the Node CLI launchers. The Bun install path
// supplies its admitted absolute executable; Node-profile qualification may
// omit it without substituting Node for this API startup proof.
if (process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"] !== undefined) {
  const bunRuntime = await resolveQualificationExecutables("bun");
  const bunOutput = observed(
    bunRuntime.bun ??
      (() => {
        throw new Error("Admitted Bun executable is unavailable.");
      })(),
    ["-e", `${oxcExpression} process.stdout.write(process.versions.bun ?? 'missing');`],
  );
  if (bunOutput !== "1.4.3") {
    throw new Error(`Oxc API startup did not run under admitted Bun 1.4.3: ${bunOutput}`);
  }
  process.stdout.write(
    "Pinned Oxlint, TypeScript 7, Node/Bun Oxc, Nx and esbuild tools qualified.\n",
  );
} else {
  process.stdout.write(
    "Pinned Oxlint, TypeScript 7, Node Oxc, Nx and esbuild tools qualified; selected-Bun Oxc API qualification was not requested.\n",
  );
}
