import type { GrowthInstalledInventoryReader } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/growth-authority.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { GrowthAuthorityFixturePorts } from "./growth-authority-test-ports.ts";

import { ReviewRouterGrowthAuthorityAcl } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/reviewrouter-growth-authority-acl.js";
export async function assertIndependentInstalledInventory(
  t: TestContext,
  fixtures: GrowthAuthorityFixturePorts,
) {
  const { request, grant, fingerprint, now, observation, packed, initialPackage, sealEvidence } =
    fixtures;

  const req = request(),
    value = grant(req);
  initialPackage(value, req);
  sealEvidence(value, req);
  // Independently observed installation; never read from a returned grant.
  const installed = [
    { path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"0.0.0"}') },
    { path: "content.txt", bytes: Buffer.from("candidate:fixture:0.0.0") },
  ];
  const installedRoot = await mkdtemp(join(tmpdir(), "growth-independent-inventory-"));
  t.after(() => rm(installedRoot, { recursive: true, force: true }));
  for (const file of installed) {
    await writeFile(join(installedRoot, file.path), file.bytes);
  }
  const transport = {
    async resolve() {
      return JSON.stringify(value);
    },
    async complete() {
      throw new Error("unexpected");
    },
  };
  const cancellation = { throwIfCancelled() {} };
  const reader: GrowthInstalledInventoryReader = {
    async read(identity) {
      assert.deepEqual(Object.keys(identity).toSorted(), [
        "archiveDigest",
        "archiveIntegrity",
        "packageName",
        "packageVersion",
        "source",
      ]);
      return Promise.all(
        (await readdir(installedRoot)).map(async (path) => ({
          path,
          bytes: await readFile(join(installedRoot, path)),
        })),
      );
    },
  };
  await assert.rejects(
    new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now).resolve(
      req,
      cancellation,
    ),
    /installed-inventory-unavailable/,
  );
  const acl = new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now, reader);
  await acl.resolve(req, cancellation);
  for (const observed of [
    [],
    installed.slice(1),
    [...installed, { path: "extra", bytes: Buffer.from("") }],
    installed.map((file) => ({ ...file, bytes: Buffer.from("tampered") })),
  ]) {
    await assert.rejects(
      new ReviewRouterGrowthAuthorityAcl(transport, fingerprint, () => now, {
        async read() {
          return observed;
        },
      }).resolve(req, cancellation),
      /installed-inventory-mismatch/,
    );
  }
  await writeFile(join(installedRoot, "content.txt"), "installed-drift");
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
  await writeFile(join(installedRoot, "content.txt"), "candidate:fixture:0.0.0");
  value.candidates[0] = packed("fixture", "0.0.0", observation("fixture"), "forged-payload");
  sealEvidence(value, req);
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
}

export async function assertReleasedAndCandidateInventory(fixtures: GrowthAuthorityFixturePorts) {
  const { request, grant, fingerprint, now, releasedPackage, sealEvidence } = fixtures;

  const req = request(),
    value = grant(req);
  releasedPackage(value, req);
  sealEvidence(value, req);
  const observed = new Map([
    [
      "0.9.0",
      [
        { path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"0.9.0"}') },
        { path: "content.txt", bytes: Buffer.from("historic:fixture") },
      ],
    ],
    [
      "1.0.0",
      [
        { path: "package.json", bytes: Buffer.from('{"name":"fixture","version":"1.0.0"}') },
        { path: "content.txt", bytes: Buffer.from("candidate:fixture") },
      ],
    ],
  ]);
  const calls: string[] = [];
  const acl = new ReviewRouterGrowthAuthorityAcl(
    {
      async resolve() {
        return JSON.stringify(value);
      },
      async complete() {
        throw new Error("unexpected");
      },
    },
    fingerprint,
    () => now,
    {
      async read(identity) {
        calls.push(identity.packageVersion);
        const files = observed.get(identity.packageVersion);
        assert.ok(files);
        return files;
      },
    },
  );
  const cancellation = { throwIfCancelled() {} };
  await acl.resolve(req, cancellation);
  assert.deepEqual(calls, ["0.9.0", "1.0.0"]);
  const releasedFiles = observed.get("0.9.0");
  assert.ok(releasedFiles);
  releasedFiles[1].bytes = Buffer.from("changed historical installation");
  await assert.rejects(acl.resolve(req, cancellation), /installed-inventory-mismatch/);
}
