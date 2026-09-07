import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { classify, kind, problem, sourceFiles, within } from "./feature-modules/profile.mjs";
import { executesScript, productionGates } from "./feature-modules/commands.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ambientIds = ["clock", "environment", "randomness", "timers"].map((name) => `foundation-no-ambient-${name}`);
const typedCommand = productionGates[0][1];
// Selection and execution share the exact pinned-tool invocation. --no-ignore
// disables .eslintignore; Oxlint itself evaluates inherited config exclusions.
export async function runProductionTypedLint({ repositoryRoot = defaultRoot, inventory = PUBLISHABLE_PACKAGES, selectionOnly = false, stdio = "pipe" } = {}) {
  const cli = JSON.parse(await readFile(join(defaultRoot, "node_modules/oxlint/package.json"), "utf8"));
  const bin = typeof cli.bin === "string" ? cli.bin : cli.bin.oxlint;
  const result = spawnSync(process.execPath, [join(defaultRoot, "node_modules/oxlint", bin),
    "--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config", "--no-ignore",
    ...(selectionOnly ? ["--debug", "files"] : []), ...inventory.map(({ root }) => `${root}/src`)
  ], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio });
  if (result.error) {throw result.error;}
  return result;
}
async function validateTypedSelection(repositoryRoot, inventory, files, problems) {
  const selection = await runProductionTypedLint({ repositoryRoot, inventory, selectionOnly: true });
  if (selection.status !== 0) {
    problem(problems, "typed-coverage", `Oxlint selection failed: ${selection.stderr || selection.stdout}`);
    return;
  }
  const selected = new Set(selection.stdout.trim().split(/\r?\n/u).filter(Boolean).map((path) => path.replaceAll("\\", "/")));
  for (const file of files) {if (!selected.has(file)) {problem(problems, "typed-coverage", `${file}: absent from Oxlint effective selection.`);}}
  for (const file of selected) {if (!files.includes(file)) {problem(problems, "typed-coverage", `${file}: outside the counted source universe.`);}}
}
export async function checkProductionQuality({ repositoryRoot = defaultRoot, inventory = PUBLISHABLE_PACKAGES } = {}) {
  const problems = [], files = [];
  const readJson = async (path) => JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
  const readYaml = async (path) => YAML.parse(await readFile(join(repositoryRoot, path), "utf8"));
  const pkg = await readJson("package.json");
  const profile = await readJson("architecture/foundation/feature-modules.json");
  const suppressions = await readYaml("architecture/foundation/suppression-governance.yaml");
  const sgconfig = await readYaml("sgconfig.yml");
  if (!executesScript(pkg.scripts, "lint:typed", "lint:typed", typedCommand)) {problem(problems, "typed-command", "Typed lint must use the inventory-derived runner.");}
  for (const [script, terminal] of productionGates) {
    if (!executesScript(pkg.scripts, "check", script, terminal)) {
      problem(problems, "quality-command", `check must reach ${script} and its exact terminal command through literal scripts joined by &&.`);
    }
  }
  for (const entry of ["check", "check:fast"]) {
    if (!executesScript(pkg.scripts, entry, "quality:scope:check", "node scripts/check-production-quality.mjs")) {
      problem(problems, "scope-command", `${entry} must execute production coverage through literal scripts joined by &&.`);
    }
  }
  await validateInventory(repositoryRoot, inventory, readJson, problems);
  const rules = [];
  for (const directory of sgconfig.ruleDirs) {
    await kind(repositoryRoot, directory);
    for (const name of await readdir(join(repositoryRoot, directory))) {
      if (/\.ya?ml$/u.test(name)) {rules.push(await readYaml(`${directory}/${name}`));}
    }
  }
  for (const id of ambientIds) {
    if (rules.filter((rule) => rule.id === id && rule.severity === "error").length !== 1) {problem(problems, "ambient-rule", `Missing/duplicate/nonblocking ${id}.`);}
  }
  files.push(...await validateFileCoverage({ repositoryRoot, inventory, suppressions, rules }, problems));
  await validateTypedSelection(repositoryRoot, inventory, files, problems);
  validateAmbientExceptions({ rules, profile, files }, problems);
  return { outcome: problems.length ? "failed" : "passed", packages: inventory.length, files: files.length, problems };
}
function validateAmbientExceptions({ rules, profile, files }, problems) {
  for (const rule of rules.filter(({ id }) => ambientIds.includes(id))) {
    for (const path of rule.ignores ?? []) {
      const owner = classify(path, profile);
      if (!files.includes(path) || !(owner?.kind === "assembly" || (owner?.kind === "feature" && ["adapters", "testing"].includes(owner.layer.role)))) {
        problem(problems, "ambient-exception", `${rule.id}: ${path} must be one exact owned infrastructure/testing or process composition artifact.`);
      }
    }
  }
}
async function validateInventory(repositoryRoot, inventory, readJson, problems) {
  // Discover package omissions without introducing a second package catalog.
  for (const name of await readdir(join(repositoryRoot, "packages"))) {
    const root = `packages/${name}`;
    if (await kind(repositoryRoot, `${root}/package.json`) !== "file") {continue;}
    const manifest = await readJson(`${root}/package.json`);
    if (!inventory.some((entry) => entry.root === root && entry.name === manifest.name)) {problem(problems, "package-inventory", `${root}: materialized package is absent from the existing inventory.`);}
  }
}
async function validateFileCoverage({ repositoryRoot, inventory, suppressions, rules }, problems) {
  const files = [];
  for (const { root } of inventory) {
    const sourceRoot = `${root}/src`;
    const moduleFiles = await sourceFiles(repositoryRoot, sourceRoot);
    if (!moduleFiles.length) {problem(problems, "production-source", `${sourceRoot} contains no source.`);}
    for (const file of moduleFiles) {
      files.push(file);
      if (!file.endsWith(".ts")) {problem(problems, "source-language", `${file}: this TypeScript-only adoption requires an explicit extension before adding another source language.`);}
      if (!suppressions.governedRoots.some((governedRoot) => within(file, governedRoot))) {problem(problems, "suppression-coverage", file);}
      for (const rule of rules.filter(({ id }) => ambientIds.includes(id))) {
        if (!rule.files?.some((pattern) => matchesGlob(file, pattern))) {problem(problems, "ambient-coverage", `${rule.id}: ${file}`);}
      }
    }
  }
  return files;
}
async function main(args) {
  if (args.length > 1 || (args[0] && args[0] !== "typed")) {throw new Error("Usage: check-production-quality.mjs [typed]");}
  const result = await checkProductionQuality();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome !== "passed") { process.exitCode = 1; return; }
  if (args[0] === "typed") {
    const command = await runProductionTypedLint({ stdio: "inherit" });
    process.exitCode = command.status ?? 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
