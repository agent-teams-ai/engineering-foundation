import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { digest, jsonFile } from "./campaign-support.ts";

const selectedArgument = process.argv[2];
assert(
  selectedArgument && process.argv.length === 3,
  "Select one existing owned evidence directory",
);
const selected = selectedArgument;
assert(isAbsolute(selected) && resolve(selected) === selected);
if (!existsSync(selected)) {
  console.log("EF70_EVIDENCE_ABSENT: bootstrap did not create its evidence root.");
} else {
  assert.equal(realpathSync(selected), selected);
  const rootStat = lstatSync(selected);
  assert(rootStat.isDirectory() && rootStat.uid === process.geteuid?.());
  const runner = process.env["RUNNER_TEMP"];
  const run = process.env["GITHUB_RUN_ID"],
    attempt = process.env["GITHUB_RUN_ATTEMPT"];
  assert(runner && run && attempt && /^[1-9][0-9]*$/u.test(run) && /^[1-9][0-9]*$/u.test(attempt));
  assert.equal(selected, join(realpathSync(runner), "ef70-evidence-" + run + "-" + attempt));
  const manifest: {
    path: string;
    bytes: number;
    mode: number;
    sha256: string;
    metadataUnchangedDuringRead: boolean;
  }[] = [];
  const files: { path: string; sha256: string; base64: string }[] = [];
  let total = 0,
    selectedTotal = 0,
    entries = 0;
  function visit(directory: string, depth: number): void {
    assert(depth <= 16 && manifest.length <= 20_000, "Evidence census exceeds bounds");
    for (const name of readdirSync(directory).toSorted()) {
      assert(++entries <= 40_000, "Evidence entry census exceeds bounds");
      const path = join(directory, name),
        before = lstatSync(path, { bigint: true });
      assert(!before.isSymbolicLink(), "Evidence must not contain aliases");
      if (before.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      assert(before.isFile() && before.nlink === 1n && before.size <= 32n * 1024n * 1024n);
      const content = readFileSync(path),
        after = lstatSync(path, { bigint: true }),
        nameInRoot = relative(selected, path);
      total += content.length;
      assert(total <= 512 * 1024 * 1024, "Evidence census exceeds total byte bound");
      const metadataUnchangedDuringRead =
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs;
      const sha256 = digest(content);
      assert(manifest.length < 20_000, "Evidence file census exceeds bounds");
      manifest.push({
        path: nameInRoot,
        bytes: content.length,
        mode: Number(before.mode & 0o777n),
        sha256,
        metadataUnchangedDuringRead,
      });
      const parts = nameInRoot.split("/");
      const originalProof = /^case-[a-z0-9-]+$/u.test(parts[0] ?? "") && parts[1] === "proofs";
      const duplicateProof = parts.length > 2 && parts[2] === "proofs";
      const include =
        originalProof ||
        (!duplicateProof &&
          (name.endsWith(".json") || name === "actual-cli.stdout" || name === "actual-cli.stderr"));
      if (include) {
        selectedTotal += content.length;
        assert(selectedTotal <= 64 * 1024 * 1024, "Selected transport exceeds byte bound");
        files.push({ path: nameInRoot, sha256, base64: content.toString("base64") });
      }
    }
  }
  visit(selected, 0);
  const complete = existsSync(join(selected, "orchestration/campaign-complete.json"));
  const bootstrapPath = join(selected, "bootstrap-result.json");
  const bootstrap = existsSync(bootstrapPath) ? jsonFile(bootstrapPath) : undefined;
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      evidenceClass: "observed-hosted-campaign-evidence-capsule",
      hostRepository: process.env["GITHUB_REPOSITORY"],
      hostSource: process.env["GITHUB_SHA"],
      harnessRevision: bootstrap?.["harnessRevision"] ?? process.env["EF70_HARNESS_REVISION"],
      harnessTree: bootstrap?.["harnessTree"],
      producerPreflight: bootstrap?.["producerPreflight"],
      run,
      attempt,
      campaignCompletionMarkerPresent: complete,
      observation:
        "Captured file bytes; a failure snapshot does not establish closed streams or reconciled processes.",
      selection:
        "All JSON except duplicate per-operation proof copies; original case proofs and actual CLI streams. Full raw evidence remains in the Actions artifact.",
      manifest,
      files,
    }) + "\n",
  );
  const compressed = gzipSync(payload, { level: 6 });
  assert(compressed.length <= 16 * 1024 * 1024, "Compressed evidence exceeds log transport bound");
  const metadata = {
    schemaVersion: 1,
    encoding: "gzip-base64",
    payloadSha256: digest(payload),
    compressedSha256: digest(compressed),
    payloadBytes: payload.length,
    compressedBytes: compressed.length,
    fileCount: manifest.length,
    transportedFileCount: files.length,
    capturedBytes: total,
    selectedBytes: selectedTotal,
    allCapturedMetadataUnchangedDuringRead: manifest.every(
      (entry) => entry.metadataUnchangedDuringRead,
    ),
    scope: "Actual test evidence only; no qualification or rollout authority.",
  };
  writeFileSync(
    join(selected, "evidence-capsule-manifest.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log("EF70_EVIDENCE_CAPSULE " + JSON.stringify(metadata));
  const encoded = compressed.toString("base64"),
    chunkSize = 12_000;
  const count = Math.ceil(encoded.length / chunkSize);
  for (let index = 0; index < count; index += 1) {
    console.log(
      "EF70_EVIDENCE_CHUNK " +
        JSON.stringify({
          index,
          count,
          sha256: metadata.compressedSha256,
          base64: encoded.slice(index * chunkSize, (index + 1) * chunkSize),
        }),
    );
  }
}
