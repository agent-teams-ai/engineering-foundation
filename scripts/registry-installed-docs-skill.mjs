import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isCanonicalPathInside } from "./registry-package-paths.mjs";

const maximumPortableSkillBytes = 1024 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function readInstalledPortableDocsSkill(installedDocsRoot) {
  const canonicalRoot = await realpath(installedDocsRoot);
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "package.json"), "utf8"));
  const qualificationExport = manifest.exports?.["./qualification"]?.import;
  assert(typeof qualificationExport === "string" && qualificationExport.startsWith("./"),
    "Installed Docs Protocol does not declare its qualification import export.");
  const qualificationPath = await realpath(join(canonicalRoot, qualificationExport));
  assert(isCanonicalPathInside(canonicalRoot, qualificationPath),
    "Installed Docs Protocol qualification export escapes its package root.");
  const qualification = await import(pathToFileURL(qualificationPath).href);
  assert(typeof qualification.portableQualificationSkill === "function",
    "Installed Docs Protocol qualification does not expose its portable Skill authority.");
  const skill = qualification.portableQualificationSkill();
  assert(skill instanceof Uint8Array && skill.byteLength > 0 &&
    skill.byteLength <= maximumPortableSkillBytes,
  "Installed Docs Protocol returned an invalid portable Skill asset.");
  return Buffer.from(skill);
}

export async function readInstalledManagedDocsSkill(installedAdapterRoot) {
  assert((await lstat(installedAdapterRoot)).isDirectory(),
    "Managed Skill must resolve from a physical installed adapter package.");
  const root = await realpath(installedAdapterRoot);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert(manifest.name === "@agent-teams/docs-protocol-agent-teams",
    "Managed Skill requires the installed Agent Teams adapter.");
  const paths = ["skills/docs/SKILL.md", "assets/catalog.json"];
  const bytes = await Promise.all(paths.map(async (path) => {
    const resolved = await realpath(join(root, path));
    assert(isCanonicalPathInside(root, resolved) &&
      (await lstat(join(root, path))).isFile(), "Managed Skill authority escapes its installed package.");
    const value = await readFile(resolved);
    assert(value.byteLength > 0 && value.byteLength <= maximumPortableSkillBytes,
      "Installed managed Skill authority exceeds its byte limit.");
    return value;
  }));
  const [skill, catalogBytes] = bytes;
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  assert(catalog.skillPath === paths[0] && catalog.skillDigest ===
    `sha256:${createHash("sha256").update(skill).digest("hex")}`,
  "Installed managed Skill differs from its published catalog authority.");
  return skill;
}
