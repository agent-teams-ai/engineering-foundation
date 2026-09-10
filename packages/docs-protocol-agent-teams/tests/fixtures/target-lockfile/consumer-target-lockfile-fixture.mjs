import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "yaml";
export const candidate = await readFile(new URL("./candidate-target-lock.yaml", import.meta.url));
export const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const expected = "sha256:e2c56ef5299a33d83e86279151e32eab0eb4ca19e020a02aa65d657cb3fa5054";
export const lock = parse(candidate.toString());
const names = { repositoryMutation: "repository-mutation", documentAuthoring: "document-authoring",
  docsProtocol: "docs-protocol", docsProtocolAgentTeams: "docs-protocol-agent-teams", engineeringFoundation: "engineering-foundation" };
export const packages = Object.fromEntries(Object.entries(names).map(([role, name]) => {
  const key = Object.keys(lock.packages).find(locator => locator.startsWith(`@agent-teams/${name}@`));
  return [role, { version: key.slice(key.lastIndexOf("@") + 1), integrity: lock.packages[key].resolution.integrity }];
}));
export const target = { cohort: { packages, runtime: { runtimeClosureDigest: expected } } };
export const bytes = value => Buffer.from(JSON.stringify(value));


export function historicalTargetLock() {
  const old = structuredClone(lock);
  delete old.packages["fast-uri@3.1.7"];
  delete old.snapshots["fast-uri@3.1.7"];
  old.packages["fast-uri@3.1.5"] = { resolution: {
    integrity: "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw=="
  } };
  old.snapshots["fast-uri@3.1.5"] = {};
  for (const version of ["8.18.0", "8.20.0"]) {old.snapshots[`ajv@${version}`].dependencies["fast-uri"] = "3.1.5";}
  return old;
}
