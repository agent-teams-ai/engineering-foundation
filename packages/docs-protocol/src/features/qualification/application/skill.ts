import { portableBootstrapDesiredFiles } from "../../portable-bootstrap/application.js";

export function portableQualificationSkill(): Buffer {
  const skill = portableBootstrapDesiredFiles("qualification/project", "qualification/owner")
    .find(({ path }) => path === ".agents/skills/docs-authoring/SKILL.md");
  if (skill === undefined) {
    throw new Error("Portable qualification Skill is missing from the core bootstrap authority.");
  }
  return Buffer.from(skill.bytes);
}

