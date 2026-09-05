import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { digest, kind, portable, problem, validateModule } from "./feature-modules/profile.mjs";
import { observeDependencies, validateObservations, validateSurfaces, validateTopology } from "./feature-modules/dependencies.mjs";
import { executesScript, productionGates } from "./feature-modules/commands.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProfile = "architecture/foundation/feature-modules.json";
async function validateAdoption(repositoryRoot, profile, problems) {
  const standard = profile.standard;
  if (profile.schemaVersion !== 1 || standard.id !== "agent-teams.feature-module-standard" || standard.version !== "v1") {
    problem(problems, "standard-identity", "Adopt agent-teams.feature-module-standard v1 using profile schemaVersion 1.");
  }
  await kind(repositoryRoot, standard.path);
  if (digest(await readFile(join(repositoryRoot, standard.path))) !== standard.digest) {problem(problems, "standard-digest", standard.path);}
  for (const path of [profile.architectureDocument, profile.decision]) {
    if (await kind(repositoryRoot, path) !== "file") {problem(problems, "adoption-document", `Missing ${path}.`);}
  }
  if (Object.values(profile.deviations ?? {}).some((value) => !Array.isArray(value) || value.length)) {
    problem(problems, "unsupported-deviation", "This adoption admits no cycle or layer deviations. Exact primitive files require module exceptions and accepted decisions.");
  }
  for (const field of ["productionRoots", "applicationRoots", "excludedRoots"]) {
    if (!Array.isArray(profile[field])) {throw new Error(`Missing ${field} mapping.`);}
    for (const path of profile[field]) {if (!portable(path)) {throw new Error(`Invalid ${field} path: ${path}`);}}
  }
  if (profile.applicationRoots.length) {problem(problems, "application-root", "This library adoption maps executables as exact module assembly files; independent applications need a reviewed profile extension.");}
  const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  validateEnforcement(pkg, profile, problems);
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  const architecture = await readFile(join(repositoryRoot, profile.architectureDocument), "utf8");
  if (!readme.includes(profile.architectureDocument) || !architecture.includes("feature-modules.json")) {problem(problems, "adoption-reachability", "README must link the architecture document, which links the adoption profile.");}
}
function validateEnforcement(pkg, profile, problems) {
  for (const command of ["pnpm architecture:features:check", "pnpm check", ...productionGates.map(([script]) => `pnpm ${script}`)]) {
    if (!profile.enforcementCommands.includes(command)) {problem(problems, "enforcement-command", `Missing ${command}.`);}
  }
  for (const [script, terminal] of productionGates) {
    if (!executesScript(pkg.scripts, "check", script, terminal)) {
      problem(problems, "enforcement-command", `check must reach ${script} and its exact terminal command through literal scripts joined by &&.`);
    }
  }
  for (const entry of ["check", "check:fast"]) {
    if (!executesScript(pkg.scripts, entry, "architecture:features:check", "node scripts/check-feature-modules.mjs")) {
      problem(problems, "enforcement-command", `${entry} must execute the feature checker through literal scripts joined by &&.`);
    }
  }
}
const key = ({ name, root }) => `${name}:${root}`;
async function validateInventory(repositoryRoot, profile, inventory, problems) {
  if (new Set(profile.modules.map(({ id }) => id)).size !== profile.modules.length) {
    problem(problems, "module-identity", "Module identifiers must be unique.");
  }
  const expected = inventory.map(key).toSorted();
  const actual = profile.modules.map(({ packageName, root }) => key({ name: packageName, root })).toSorted();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {problem(problems, "module-inventory", `Expected ${expected.join(", ")}; actual ${actual.join(", ")}.`);}
  if (profile.topology.packageInventory !== "scripts/publishable-packages.mjs") {problem(problems, "module-inventory", "Reuse the existing publishable package inventory.");}
  for (const module of profile.modules) {
    if (!profile.productionRoots.some((root) => module.root.startsWith(`${root}/`))) {problem(problems, "production-root", module.root);}
    if (profile.excludedRoots.some((root) => module.root.startsWith(`${root}/`) || root.startsWith(`${module.root}/`) || root === module.root)) {problem(problems, "excluded-production", module.root);}
    await kind(repositoryRoot, `${module.root}/package.json`);
    const manifest = JSON.parse(await readFile(join(repositoryRoot, module.root, "package.json"), "utf8"));
    if (manifest.name !== module.packageName) {problem(problems, "module-inventory", `${module.root}: package identity mismatch.`);}
  }
}
export async function validateFeatureModules(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
  const problems = [];
  let profile;
  try {
    const profilePath = options.profilePath ?? defaultProfile;
    await kind(repositoryRoot, profilePath);
    profile = JSON.parse(await readFile(join(repositoryRoot, profilePath), "utf8"));
    await validateAdoption(repositoryRoot, profile, problems);
    await validateInventory(repositoryRoot, profile, options.productionPackages ?? PUBLISHABLE_PACKAGES, problems);
    await kind(repositoryRoot, profile.topology.sourcePolicy);
    const policy = YAML.parse(await readFile(join(repositoryRoot, profile.topology.sourcePolicy), "utf8"));
    const files = [];
    for (const module of profile.modules) {files.push(...await validateModule(repositoryRoot, module, problems, profile));}
    validateTopology(profile, policy, problems);
    const { diagnostics, observations, sourceSnapshots } = await observeDependencies(repositoryRoot, profile.topology.sourcePolicy);
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "error") {problem(problems, "source-policy", JSON.stringify(diagnostic));}
    }
    const surfaces = await validateSurfaces({ repositoryRoot, profile, policy, files, observations, sourceSnapshots }, problems);
    validateObservations(profile, policy, observations, problems, surfaces);
  } catch (error) {
    problem(problems, "input-error", error.message);
  }
  const sortedProblems = problems.toSorted((a, b) => `${a.code}:${a.message}` < `${b.code}:${b.message}` ? -1 : 1);
  return { modules: profile?.modules?.length ?? 0, outcome: problems.length ? "failed" : "passed", problems: sortedProblems };
}
export function planFeature(profile, moduleId, featureId, artifact, source) {
  const module = profile.modules.find(({ id }) => id === moduleId);
  if (!module) {throw new Error(`Unknown module: ${moduleId}`);}
  if (![featureId, artifact].every((name) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name))) {throw new Error("Use lower kebab-case feature/artifact names.");}
  if (module.features.some(({ id }) => id === featureId)) {throw new Error(`Feature already exists: ${featureId}`);}
  if (typeof source !== "string" || !source.trim()) {throw new Error("Supply the real first application artifact with --from; empty scaffolding is prohibited.");}
  if (!portable(module.preferredFeatureRoot)) {throw new Error("Invalid feature root.");}
  const root = `${module.preferredFeatureRoot}/${featureId}/application`;
  const file = `${root}/${artifact}.ts`;
  const testRoot = `${module.root}/tests/features/${featureId}`;
  return {
    operation: "plan-feature", module: moduleId, feature: featureId,
    writes: [{ path: file, content: source, digest: digest(source) }],
    profileEntry: { id: featureId, role: module.role, testRoots: [testRoot], layers: [{ role: "application", roots: [root] }] },
    sourcePolicyBoundary: { id: `${moduleId}.${featureId}.application`, roots: [root], entrypoints: [file], allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } },
    testPolicyBoundary: { id: `${moduleId}.${featureId}.tests`, roots: [testRoot], entrypoints: [], allow: { boundaries: [`${moduleId}.${featureId}.application`], packages: [], builtins: ["node:test", "node:assert/strict"], runtimeReferences: [] } },
    additionalGovernedRoots: [testRoot],
    requirements: "Write the supplied behavior and its first real test, then add these data entries and explicit edges. Run architecture:features:check. This plan grants no writes or empty layers."
  };
}
async function main(args) {
  if (args[0] === "plan" && args[1] === "--") { args = ["plan", ...args.slice(2)]; }
  if (args[0] === "plan") {
    if (args.length !== 6 || args[4] !== "--from") {throw new Error("Usage: plan <module> <feature> <artifact> --from <source-file>");}
    const profile = JSON.parse(await readFile(join(defaultRoot, defaultProfile), "utf8"));
    process.stdout.write(`${JSON.stringify(planFeature(profile, args[1], args[2], args[3], await readFile(args[5], "utf8")), null, 2)}\n`);
    return;
  }
  if (args.some((arg) => arg !== "--json")) {throw new Error("Unknown feature-check argument.");}
  const result = await validateFeatureModules();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.outcome === "passed" ? 0 : 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
