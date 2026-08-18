import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const OBSERVATION_TIMEOUT_MS = 10_000;

function confirmedTimeout(error) {
  return (
    error?.timedOut === true &&
    error?.killed === true &&
    error?.terminationConfirmed === true
  );
}

async function defaultReadVersion(registryUrl, name, version) {
  try {
    const response = await fetch(
      `${registryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(OBSERVATION_TIMEOUT_MS),
      },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function exactRegistryArchiveObserved({
  archivePath,
  name,
  readArchive = readFile,
  readVersion = defaultReadVersion,
  registryUrl,
  version,
}) {
  const archive = await readArchive(archivePath);
  const metadata = await readVersion(registryUrl, name, version);
  if (metadata === null) {
    return false;
  }
  const expectedIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const expectedShasum = createHash("sha1").update(archive).digest("hex");
  return (
    metadata.name === name &&
    metadata.version === version &&
    metadata.dist?.integrity === expectedIntegrity &&
    metadata.dist?.shasum === expectedShasum
  );
}

export async function publishWithExactEffectReconciliation({
  archivePath,
  name,
  observe = exactRegistryArchiveObserved,
  publish,
  registryUrl,
  version,
}) {
  try {
    await publish();
    return "published";
  } catch (error) {
    if (!confirmedTimeout(error) || !await observe({
      archivePath,
      name,
      registryUrl,
      version,
    })) {
      throw error;
    }
    return "reconciled";
  }
}
