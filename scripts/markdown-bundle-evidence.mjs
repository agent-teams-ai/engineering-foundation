import { createHash } from "node:crypto";

import { inspectCompressedTarArchive, portableEntryIdentity, sha256 } from "./pack-artifact-archive.mjs";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const exactVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const licenseName = /^(?:licen[sc]e|copying)(?:\.[a-z0-9-]+)?$/iu;
const noticeName = /^(?:licen[sc]e|copying|notice)(?:\.[a-z0-9-]+)?$/iu;

function fail(message) {
  throw new Error(`Markdown bundle evidence is invalid: ${message}.`);
}

function regularMembers(archive) {
  const members = new Map();
  const identities = new Set();
  for (const entry of inspectCompressedTarArchive(archive).entries) {
    if (entry.type === "x" || entry.type === "g") {continue;}
    if (entry.type !== "0" && entry.type !== "5") {fail("upstream archive contains a special entry");}
    if (!entry.name.startsWith("package/")) {fail("upstream member escapes package root");}
    const identity = portableEntryIdentity(entry.name);
    if (identities.has(identity)) {fail("upstream archive contains colliding members");}
    identities.add(identity);
    if (entry.type === "0") {members.set(entry.name.slice("package/".length), entry.data);}
  }
  return members;
}

function validateInput(input, members, seen) {
  if (typeof input?.path !== "string" || input.path !== input.path.normalize("NFC") ||
      !Buffer.isBuffer(input.bytes)) {fail("input must have a canonical path and bytes");}
  const identity = portableEntryIdentity(`package/${input.path}`);
  if (seen.has(identity)) {fail("duplicate or normalized-colliding bundle input");}
  seen.add(identity);
  const expected = members.get(input.path);
  if (expected === undefined || !expected.equals(input.bytes)) {fail(`upstream bytes differ for ${input.path}`);}
  return Object.freeze({ path: input.path, sha256: sha256(input.bytes) });
}

function supplementaryNotice(supplement, members, files) {
  if (!Buffer.isBuffer(supplement?.bytes) || !/^[a-f0-9]{64}$/u.test(supplement.sha256 ?? "") ||
      sha256(supplement.bytes) !== supplement.sha256) {fail("supplementary license bytes differ from reviewed hash");}
  // The caller supplies an immutable, reviewed upstream license policy, not an
  // arbitrary license URL inferred from the npm manifest.
  if (typeof supplement.source !== "string" ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/[a-f0-9]{40}\/[A-Za-z0-9._/-]+$/u.test(supplement.source)) {
    fail("supplementary license must name an immutable upstream source");
  }
  const sourcePath = supplement.source.split("/").slice(7).join("/");
  portableEntryIdentity(`package/${sourcePath}`);
  const sourceBytes = members.get(supplement.sourceInput?.path);
  if (sourceBytes === undefined || !/^[a-f0-9]{64}$/u.test(supplement.sourceInput?.sha256 ?? "") ||
      sha256(sourceBytes) !== supplement.sourceInput.sha256 ||
      !files.some(({ path, sha256: digest }) => path === supplement.sourceInput.path && digest === supplement.sourceInput.sha256)) {
    fail("supplementary license does not bind exact bundled source");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(supplement.bytes);
  if (text.trim() === "") {fail("supplementary license is empty");}
  return Object.freeze({ path: "upstream-license-supplement", sha256: supplement.sha256, source: supplement.source, text });
}

// This proves actual esbuild input bytes against the original source-lock SRI.
// It deliberately does not accept a hermetic registry's repacked archive SRI.
export function verifyBundledComponent({ name, version, integrity, archive, inputs, supplement }) {
  if (!packageName.test(name ?? "") || !exactVersion.test(version ?? "") || !sha512Integrity.test(integrity ?? "")) {
    fail("component needs an exact name, version and canonical SHA-512 integrity");
  }
  if (!Buffer.isBuffer(archive) || archive.length > 8 * 1024 * 1024 ||
      `sha512-${createHash("sha512").update(archive).digest("base64")}` !== integrity) {
    fail("upstream archive integrity mismatch");
  }
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 2500) {fail("component needs bounded bundle inputs");}
  const members = regularMembers(archive);
  const manifestBytes = members.get("package.json");
  if (manifestBytes === undefined) {fail("upstream manifest is missing");}
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (manifest.name !== name || manifest.version !== version) {fail("upstream manifest identity mismatch");}
  const seen = new Set();
  const files = inputs.map((input) => validateInput(input, members, seen))
    .toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const licenses = [...members].filter(([path]) => noticeName.test(path)).map(([path, bytes]) => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.trim() === "") {fail(`empty upstream notice ${path}`);}
    return Object.freeze({ path, sha256: sha256(bytes), text });
  }).toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (supplement !== undefined) {licenses.push(supplementaryNotice(supplement, members, files));}
  if (!licenses.some(({ path }) => licenseName.test(path) || path === "upstream-license-supplement")) {
    fail("component has no complete retained license text");
  }
  return Object.freeze({
    name, version, integrity, archiveSha256: sha256(archive), manifestSha256: sha256(manifestBytes),
    files: Object.freeze(files), licenses: Object.freeze(licenses),
  });
}
