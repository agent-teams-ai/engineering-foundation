import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  requirePublicDocsDecision,
  verifyPublicExactDocsCoordinates,
} from "./public-docs-install-e2e.mjs";
import { releaseState } from "./release-publish.mjs";

async function readAuthority() {
  return JSON.parse(await readFile(new URL(
    "../architecture/foundation/open-source-docs-release.json",
    import.meta.url,
  ), "utf8"));
}

export function publicDocsReleaseQualificationDecision({ authority, release }) {
  const coordinates = Object.values(authority.packages).map(({ name, version }) => ({
    name,
    version,
  }));
  const publicVersions = new Map(
    release.packages.public.map(({ name, version }) => [name, version]),
  );
  const target = coordinates.every(({ name, version }) => publicVersions.get(name) === version);
  return Object.freeze({
    action: target ? "require" : "skip",
    coordinates: Object.freeze(coordinates.map((coordinate) => Object.freeze(coordinate))),
    reason: target ? "exact-release-target" : "release-not-target",
  });
}

export async function main({
  cwd = process.cwd(),
  inspectReleaseState = releaseState,
  loadAuthority = readAuthority,
  qualify = verifyPublicExactDocsCoordinates,
  write = (line) => process.stdout.write(line),
} = {}) {
  const [authority, release] = await Promise.all([
    loadAuthority(),
    inspectReleaseState(cwd),
  ]);
  const releaseDecision = publicDocsReleaseQualificationDecision({ authority, release });
  if (releaseDecision.action === "skip") {
    write("Public Docs Protocol release qualification SKIP: current release is not the exact authority target.\n");
    return releaseDecision;
  }

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "public-docs-release-e2e-"));
  try {
    const decision = requirePublicDocsDecision(
      await qualify({ temporaryRoot }),
      { required: true },
    );
    write(
      `Public Docs Protocol release qualification PASS: ${decision.coordinates
        .map(({ name, version }) => `${name}@${version}`)
        .join(", ")}; provenance commit ${decision.commit}; ` +
      `${decision.matrix.length} install profiles.\n`,
    );
    return Object.freeze({ ...releaseDecision, qualification: decision });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
