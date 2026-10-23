import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, writeJson } from "./pack-test-support.mjs";
import { packedSdkCases } from "./packed-sdk-cases.ts";
const hash = (value: string | Buffer): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export async function writeSdkQualificationReceipt({
  installedManifest,
  parent,
  artifact,
  baseArtifactDigest,
  candidateArtifactDigest,
  promotion,
  matched,
  broken,
}: {
  installedManifest: string;
  parent: string;
  artifact: { sha256: string };
  baseArtifactDigest: string;
  candidateArtifactDigest: string;
  promotion: unknown;
  matched: { bytes: Buffer };
  broken: { bytes: Buffer };
}) {
  const writerTests = (
    await readFile(
      new URL("../tests/public-api-growth-report-writer.test.mjs", import.meta.url),
      "utf8",
    )
  ).replaceAll(
    "../packages/engineering-foundation/dist/",
    new URL("./dist/", pathToFileURL(installedManifest)).href,
  );
  const packedWriterTest = join(parent, "packed-writer.test.mjs");
  await writeFile(packedWriterTest, writerTests);
  await runCommand(process.execPath, ["--test", packedWriterTest], parent);
  const receipt = {
    outcome: "passed",
    artifactDigest: artifact.sha256,
    sourceIdentity: "synthetic-unverified",
    fixtureArtifacts: { base: baseArtifactDigest, candidate: candidateArtifactDigest },
    promotion,
    cases: packedSdkCases,
    writerTestDigest: hash(writerTests),
    matchedReportDigest: hash(matched.bytes),
    compatibilityReportDigest: hash(broken.bytes),
  };
  await writeJson(join(parent, "qualification.json"), receipt);
  return receipt;
}
