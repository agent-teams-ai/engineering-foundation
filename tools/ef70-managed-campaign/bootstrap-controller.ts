import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorityRevision,
  cohort,
  command,
  fetchObserved,
  fixtures,
  git,
  github,
  installedFiles,
  invoke,
  json,
  list,
  producerRoot,
  rawRoot,
  record,
  retain,
  row,
  selected,
  sha256,
  text,
  type Row,
} from "./bootstrap-io.ts";

interface ControllerSnapshot {
  readonly manifestBefore: Buffer;
  readonly lockBefore: Buffer;
  readonly locked: Row;
}

function prepareControllerInstallation(installation: string): ControllerSnapshot {
  mkdirSync(installation, { mode: 0o700 });
  copyFileSync(join(fixtures, "controller-package.json"), join(installation, "package.json"));
  copyFileSync(
    join(fixtures, "controller-package-lock.json"),
    join(installation, "package-lock.json"),
  );
  const manifestBefore = readFileSync(join(installation, "package.json"));
  const lockBefore = readFileSync(join(installation, "package-lock.json"));
  assert.equal(
    sha256(manifestBefore),
    "2f5350a11c52ed8f85d869e303e211a41ac09562d2784f7a830be15644600d36",
  );
  assert.equal(
    sha256(lockBefore),
    "6fb0e48a6f95dbfb788977fb73d09aeb12c8b9e3a36e29dfede4bd5bbd850e7e",
  );
  const lock = row(JSON.parse(lockBefore.toString("utf8")), "Frozen controller npm lock");
  assert.equal(lock["lockfileVersion"], 3);
  const locked = row(lock["packages"], "Locked packages");
  assert.equal(Object.keys(locked).length, 14);
  return { manifestBefore, lockBefore, locked };
}

async function acquireArchives(coordinates: readonly Row[], locked: Row): Promise<Row[]> {
  const archiveInputs = list(
    JSON.parse(readFileSync(join(fixtures, "controller-archive-integrity.json"), "utf8")),
    "Retained archive identities",
  ).map((value) => row(value, "Retained archive"));
  assert.equal(archiveInputs.length, 4);
  const archives: Row[] = [];
  for (const [index, input] of archiveInputs.entries()) {
    const name = text(input["name"], "Archive name"),
      version = text(input["version"], "Archive version");
    const matches = coordinates.filter((coordinate) => coordinate["name"] === name);
    assert.equal(matches.length, 1);
    const coordinate = matches[0]!;
    const lockedPackage = row(locked["node_modules/" + name], "Frozen controller coordinate");
    for (const key of ["version", "integrity"]) {
      assert.equal(input[key], coordinate[key]);
      assert.equal(lockedPackage[key], coordinate[key]);
    }
    assert.equal(coordinate["registry"], "https://registry.npmjs.org/");
    assert.equal(lockedPackage["resolved"], input["url"]);
    const metadata = row(
      JSON.parse(
        (
          await fetchObserved(
            "https://registry.npmjs.org/" + encodeURIComponent(name) + "/" + version,
            "controller-" + index + "-metadata",
          )
        ).toString("utf8"),
      ),
      "Public registry metadata",
    );
    assert.equal(metadata["name"], name);
    assert.equal(metadata["version"], version);
    const distribution = row(metadata["dist"], "Published distribution");
    assert.equal(distribution["tarball"], input["url"]);
    assert.equal(distribution["integrity"], input["integrity"]);
    const bytes = await fetchObserved(
      text(input["url"], "Public archive URL"),
      "controller-" + index + "-archive",
    );
    assert.equal(bytes.length, input["bytes"]);
    assert.equal(sha256(bytes), input["sha256"]);
    assert.equal(
      "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      input["integrity"],
    );
    archives.push({
      name,
      version,
      bytes: bytes.length,
      sha256: sha256(bytes),
      integrity: input["integrity"],
      url: input["url"],
      archive: selected(join(rawRoot, "controller-" + index + "-archive.raw")),
      provenance: coordinate["provenance"],
    });
  }
  return archives;
}

function installController(
  installation: string,
  node26: string,
  npmEntrypoint: string,
  snapshot: ControllerSnapshot,
): Row[] {
  const { manifestBefore, lockBefore, locked } = snapshot;
  command(
    "controller-install",
    node26,
    [
      npmEntrypoint,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
    ],
    installation,
  );
  assert(readFileSync(join(installation, "package.json")).equals(manifestBefore));
  assert(readFileSync(join(installation, "package-lock.json")).equals(lockBefore));
  const installed: Row[] = [];
  for (const [location, value] of Object.entries(locked)) {
    if (location === "") {
      continue;
    }
    assert(location.startsWith("node_modules/") && !location.split("/").includes(".."));
    const expected = row(value, "Locked package");
    const archiveUrl = new URL(text(expected["resolved"], "Resolved locked package"));
    assert.equal(archiveUrl.origin, "https://registry.npmjs.org");
    const manifestPath = join(installation, location, "package.json");
    const manifest = json(manifestPath);
    assert.equal(manifest["version"], expected["version"]);
    installed.push({
      location,
      name: manifest["name"],
      version: manifest["version"],
      integrity: expected["integrity"],
      resolved: expected["resolved"],
      manifest: selected(manifestPath),
    });
  }
  record("controller-installed-locked-packages", installed);
  return installed;
}

function compareManagedInventories(installation: string, archives: readonly Row[]): number {
  let fileCount = 0;
  for (const archive of archives) {
    const name = text(archive["name"], "Managed archive"),
      leaf = name.split("/").at(-1)!;
    const expected = json(join(fixtures, "installed-" + leaf + "-inventory.json"));
    assert.equal(expected["name"], name);
    assert.equal(expected["version"], archive["version"]);
    assert.equal(expected["archiveSha256"], archive["sha256"]);
    const actual = installedFiles(join(installation, "node_modules", name));
    const expectedFiles = list(expected["files"], "Authenticated archive file inventory")
      .map((value) => row(value, "Authenticated file"))
      .toSorted((a, b) => (text(a["path"], "File path") < text(b["path"], "File path") ? -1 : 1));
    assert.deepEqual(
      actual,
      expectedFiles,
      "Complete installed bytes/modes differ from the authenticated archive",
    );
    fileCount += actual.length;
    const inventory = record("installed-" + leaf + "-inventory", {
      name,
      version: archive["version"],
      archiveSha256: archive["sha256"],
      files: actual,
    });
    archive["installedInventory"] = selected(inventory);
    archive["installedFileCount"] = actual.length;
    archive["verificationScope"] =
      "Fresh genuine archive SRI/SHA and complete installed file census/bytes/modes against the retained archive-bound inventory.";
  }
  assert.equal(fileCount, 1973);
  return fileCount;
}

async function verifyControllerProvenance(
  installation: string,
  node26: string,
  npmEntrypoint: string,
  archives: readonly Row[],
): Promise<number> {
  const auditBytes = command(
    "controller-signature-audit",
    node26,
    [
      npmEntrypoint,
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry=https://registry.npmjs.org/",
    ],
    installation,
  );
  const audit = row(JSON.parse(auditBytes.toString("utf8")), "Actual npm signature audit");
  assert.deepEqual(audit["invalid"], []);
  assert.deepEqual(audit["missing"], []);
  const auditPath = retain("controller-signature-audit.json", auditBytes);
  const releaseModule = row(
    await import(
      pathToFileURL(join(producerRoot, "scripts/release-publish-ordered-runtime.mjs")).href
    ),
    "Producer provenance verifier",
  );
  const releases = new Map<string, Row>();
  for (const archive of archives) {
    const expected = row(archive["provenance"], "Qualified package provenance");
    assert.equal(expected["source_repository"], "agent-teams-ai/engineering-foundation");
    assert.equal(expected["source_repository_id"], 1316243988);
    assert.equal(expected["source_workflow"], ".github/workflows/release.yml");
    assert.equal(expected["workflow_run_attempt"], 1);
    const runId = expected["workflow_run_id"];
    assert(typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0);
    const runKey = String(runId);
    if (!releases.has(runKey)) {
      const release = await github(
        "engineering-foundation/actions/runs/" + runKey + "/attempts/1",
        "publisher-run-" + runKey,
      );
      assert.equal(release["id"], runId);
      assert.equal(release["run_attempt"], 1);
      assert.equal(release["status"], "completed");
      assert.equal(release["conclusion"], "success");
      assert.equal(release["event"], "push");
      assert.equal(release["head_branch"], "main");
      assert.equal(release["path"], ".github/workflows/release.yml");
      assert.equal(row(release["repository"], "Publisher repository")["id"], 1316243988);
      const sourceCommit = text(expected["source_commit"], "Reviewed release commit");
      assert.match(sourceCommit, /^[0-9a-f]{40}$/u);
      git(producerRoot, "publisher-ancestry-" + runKey, [
        "merge-base",
        "--is-ancestor",
        sourceCommit,
        "7438b7ee4429dc7798cf2b18c81e6bc7788f0f5b",
      ]);
      releases.set(runKey, release);
    }
    assert.equal(releases.get(runKey)!["head_sha"], expected["source_commit"]);
    const provenance = row(
      invoke(releaseModule, "verifiedProvenanceFromNpmAudit", [
        audit,
        archive,
        {
          repository: "https://github.com/agent-teams-ai/engineering-foundation",
          workflow: ".github/workflows/release.yml",
          ref: "refs/heads/main",
          expectedInvocation:
            "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/" +
            runKey +
            "/attempts/1",
        },
      ]),
      "Verified SLSA provenance",
    );
    assert.equal(provenance["commit"], expected["source_commit"]);
    archive["verifiedProvenance"] = provenance;
    archive["signatureAudit"] = selected(auditPath);
  }
  return list(audit["verified"], "Verified audit entries").length;
}

export async function authenticateController(
  centralRoot: string,
  installation: string,
  node26: string,
  npmEntrypoint: string,
  coordinates: readonly Row[],
): Promise<Row[]> {
  const snapshot = prepareControllerInstallation(installation);
  const archives = await acquireArchives(coordinates, snapshot.locked);
  const installed = installController(installation, node26, npmEntrypoint, snapshot);
  const fileCount = compareManagedInventories(installation, archives);
  const verifiedCount = await verifyControllerProvenance(
    installation,
    node26,
    npmEntrypoint,
    archives,
  );
  record("controller-authentication", {
    archives,
    totalManagedFiles: fileCount,
    npmAuditVerifiedCount: verifiedCount,
    installedPackageCount: installed.length,
    authority: {
      revision: authorityRevision,
      candidate: selected(
        join(centralRoot, "governance/evidence/docs-cohorts/" + cohort + "/candidate-input.json"),
      ),
    },
    limit:
      "Signature audit covers its exact verified entries; not an attestation claim for all thirteen installed dependencies.",
  });
  return archives;
}
