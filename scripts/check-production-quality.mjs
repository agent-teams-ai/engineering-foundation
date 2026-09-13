import { readFile, readdir } from "node:fs/promises";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { classify, kind, problem, sourceFiles } from "./feature-modules/profile.mjs";
import { executesScript, productionGates } from "./feature-modules/commands.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ambientIds = ["clock", "environment", "randomness", "timers"].map((name) => `foundation-no-ambient-${name}`);
export async function checkProductionQuality({ repositoryRoot = defaultRoot, inventory = PUBLISHABLE_PACKAGES } = {}) {
  const problems = [], files = [];
  const readJson = async (path) => JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
  const readYaml = async (path) => YAML.parse(await readFile(join(repositoryRoot, path), "utf8"));
  const pkg = await readJson("package.json");
  const profile = await readJson("architecture/foundation/feature-modules.json");
  const sgconfig = await readYaml("sgconfig.yml");
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
  files.push(...await validateFileCoverage({ repositoryRoot, inventory, rules }, problems));
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
async function validateFileCoverage({ repositoryRoot, inventory, rules }, problems) {
  const files = [];
  for (const { root } of inventory) {
    const sourceRoot = `${root}/src`;
    const moduleFiles = await sourceFiles(repositoryRoot, sourceRoot);
    if (!moduleFiles.length) {problem(problems, "production-source", `${sourceRoot} contains no source.`);}
    for (const file of moduleFiles) {
      files.push(file);
      if (!file.endsWith(".ts")) {problem(problems, "source-language", `${file}: this TypeScript-only adoption requires an explicit extension before adding another source language.`);}
      for (const rule of rules.filter(({ id }) => ambientIds.includes(id))) {
        if (!rule.files?.some((pattern) => matchesGlob(file, pattern))) {problem(problems, "ambient-coverage", `${rule.id}: ${file}`);}
      }
    }
  }
  return files;
}
async function main(args) {
  if (args.length) {throw new Error("Usage: check-production-quality.mjs");}
  const result = await checkProductionQuality();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome !== "passed") { process.exitCode = 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
