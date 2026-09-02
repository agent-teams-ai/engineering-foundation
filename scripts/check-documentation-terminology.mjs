import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const glossaryPath = "docs/reference/glossary.md";

const requiredSections = [
  "# Foundation Glossary",
  "## Agent writing rules",
  "## Authority",
  "## Evidence",
  "## Cohort",
  "## Journal",
  "## Envelope",
  "## Qualification",
  "### Artifact qualification",
  "### Capability qualification",
  "### Consumer qualification",
  "### Cohort qualification",
  "### Qualified identity is not qualification",
  "## Enforcement",
  "## Relationship map",
];

const requiredEntryPointLinks = [
  ["README.md", "docs/reference/glossary.md"],
  ["docs/README.md", "reference/glossary.md"],
  ["docs/architecture/ownership.md", "../reference/glossary.md"],
  ["docs/architecture/executable-capabilities.md", "../reference/glossary.md"],
  ["docs/architecture/managed-docs-consumer-integration.md", "../reference/glossary.md"],
];

function countExactHeading(source, heading) {
  return source
    .split(/\r?\n/u)
    .filter((line) => line === heading)
    .length;
}

async function sourceAt(path) {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

export async function documentationTerminologyViolations() {
  const violations = [];
  let glossary;
  try {
    glossary = await sourceAt(glossaryPath);
  } catch {
    return [`Missing canonical glossary: ${glossaryPath}.`];
  }

  for (const heading of requiredSections) {
    const count = countExactHeading(glossary, heading);
    if (count !== 1) {
      violations.push(
        `${glossaryPath} must contain exactly one ${JSON.stringify(heading)} heading; found ${count}.`,
      );
    }
  }

  if (!glossary.includes("Never use bare `qualification`")) {
    violations.push(
      `${glossaryPath} must retain the rule that disambiguates qualification scopes.`,
    );
  }

  for (const [path, target] of requiredEntryPointLinks) {
    let source;
    try {
      source = await sourceAt(path);
    } catch {
      violations.push(`Missing terminology entry point: ${path}.`);
      continue;
    }
    if (!source.includes(`](${target})`)) {
      violations.push(`${path} must link to the canonical glossary at ${target}.`);
    }
  }

  return violations.toSorted();
}

const violations = await documentationTerminologyViolations();
if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(`documentation terminology: ${violation}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Documentation terminology contract is valid.\n");
}
