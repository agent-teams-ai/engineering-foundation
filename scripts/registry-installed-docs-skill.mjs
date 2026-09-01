import { readFile, realpath } from "node:fs/promises";
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
