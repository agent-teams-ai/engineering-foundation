import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { assertNotCancelled, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiRepositoryEvidence } from "../../../application/ports/public-api-evidence.js";
import type { PublicApiArtifactSnapshot, PublicApiPackagePolicy, PublicApiSnapshot } from "../../../application/model/public-api.js";
import { artifactApiProjection } from "../../../application/policies/artifact-api-projection.js";
import type { PublicApiRepository } from "../../../application/ports/public-api-repository.js";
import type { PublicApiExtractor } from "../../../application/ports/public-api-extractor.js";
import { readArtifactBaselineBytes, mapReleasedArtifactBaseline, writeArtifactBaseline } from "./public-api-artifact-baseline.js";

/** Artifact records use the same release policy, with their own replay/version identity. */
export class ArtifactPublicApiEvidence implements PublicApiRepository, PublicApiExtractor {
  private readonly baselineBytes = new Map<string, Buffer>();

  constructor(
    private readonly typedRepository: PublicApiRepository,
    private readonly current: readonly PublicApiArtifactSnapshot[],
    private readonly evidence: PublicApiRepositoryEvidence
  ) {}

  private snapshot(policy: PublicApiPackagePolicy): PublicApiArtifactSnapshot {
    const snapshot = this.current.find((entry) => entry.packageName === policy.packageName);
    if (snapshot === undefined) { throw new Error(`Artifact observation is missing: ${policy.packageName}.`); }
    return mapReleasedArtifactBaseline(snapshot, policy);
  }

  async readReleasedBaseline(root: string, policy: PublicApiPackagePolicy, signal: AbortSignal | undefined, purpose: "release-promotion"): Promise<PublicApiSnapshot | undefined>;
  async readReleasedBaseline(root: string, policy: PublicApiPackagePolicy, signal?: AbortSignal, purpose?: "compatibility-check"): Promise<PublicApiSnapshot>;
  async readReleasedBaseline(root: string, policy: PublicApiPackagePolicy, signal?: AbortSignal, _purpose = "compatibility-check"): Promise<PublicApiSnapshot | undefined> {
    assertNotCancelled(signal);
    const bytes = await readArtifactBaselineBytes(root, policy, this.evidence);
    if (bytes !== undefined) {
      const baseline = mapReleasedArtifactBaseline(parseStrictJson(bytes.toString("utf8")), policy);
      if (baseline.status === "historical-bootstrap") {
        publicApiInputError("PUBLIC_API_ARTIFACT_BASELINE_HISTORICAL", "A historical namespace artifact is not a compatibility baseline; explicitly fix the initial candidate archive.", "public-api-evidence");
      }
      this.baselineBytes.set(`${root}/${policy.packageName}`, bytes);
      return artifactApiProjection(baseline);
    }
    const current = this.snapshot(policy);
    if (current.wildcardExports.length === 0) { return artifactApiProjection(current); }

    publicApiInputError("PUBLIC_API_ARTIFACT_BASELINE_MISSING", `Missing concrete artifact baseline for ${policy.packageName}; initial fixation requires reviewed artifact evidence, never a normal check.`, "public-api-evidence");
  }

  readReleaseEvidence(...args: Parameters<PublicApiRepository["readReleaseEvidence"]>) {
    return this.typedRepository.readReleaseEvidence(...args);
  }

  extract(_root: string, policy: PublicApiPackagePolicy, version: string, signal?: AbortSignal): Promise<PublicApiSnapshot> {
    assertNotCancelled(signal);
    const snapshot = this.snapshot(policy);
    if (snapshot.packageVersion !== version) { throw new Error(`Manifest changed during artifact inspection: ${policy.packageName}.`); }
    return Promise.resolve(artifactApiProjection(snapshot));
  }

  async writeReleasedBaseline(root: string, policy: PublicApiPackagePolicy, snapshot: PublicApiSnapshot, signal?: AbortSignal, mode: "create" | "replace" = "replace"): Promise<void> {
    const current = this.snapshot(policy);
    if (JSON.stringify(snapshot) !== JSON.stringify(artifactApiProjection(current))) {
      throw new Error("Artifact promotion must use its inspected snapshot.");
    }
    const expectedBytes = this.baselineBytes.get(`${root}/${policy.packageName}`);
    if (mode === "replace" && expectedBytes === undefined) { throw new Error("Artifact baseline must be observed before promotion."); }
    await writeArtifactBaseline({ root, policy, snapshot: current, mode,
      ...(expectedBytes === undefined ? {} : { expectedBytes }), ...(signal === undefined ? {} : { signal }) }, this.evidence);
  }
}
