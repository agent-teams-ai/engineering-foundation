import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { npmSignatureInstallArguments } from "./release-npm-command.ts";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";

const SOURCE = "bdfdf72c10994df939591b88a9dda5d7759cdc39";
const REPOSITORY = "agent-teams-ai/engineering-foundation";
const BRANCH = "refs/heads/test/release-audit-observation-20261126";
const INVOCATION = "https://github.com/" + REPOSITORY + "/actions/runs/45765345338/attempts/1";
const REGISTRY = "https://registry.npmjs.org/";
const SLSA = "https://slsa.dev/provenance/v1";
const PUBLISH = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const OUTPUT = resolve(".qualification-output/release-audit-observation");
const SOURCE_FILES = [
  ".github/workflows/release-audit-observation.yml",
  "scripts/release-audit-observation.ts",
  "tsconfig.ci-tooling.json",
] as const;
const PINS = [
  { name: "@agent-teams/repository-mutation", version: "0.5.1", integrity: "sha512-yZruHqT0qB87NeXIR2BoLjLYhAu7zCdnuLFGnyRz8zVVL7fnZNZix10EzMz/oOAE1EOcVtCw263XZkoVJ4H5iQ==" },
  { name: "@agent-teams/document-authoring", version: "0.3.8", integrity: "sha512-i0mwQRg/ex48fVz+n8NDrubszt2Nx1Wy7jZxUCqWNZcu5H6aVG/ib2iz4vtY5qoedn8MeTT5+wmw1f78KBJBXQ==" },
  { name: "@agent-teams/docs-protocol", version: "0.6.8", integrity: "sha512-4Ywz8K702coWMFGilLX0ih/GesqiAL6jKj0omf/GV78xb7BAHF3UXNBkf6IE02R5Gi9ykTQFxZG+SgqHAXKlNw==" },
  { name: "@agent-teams/docs-protocol-agent-teams", version: "0.7.0", integrity: "sha512-DgnBYQCXvCKh5h2zbD+cO9LKNruLg3492hfmVe7qM7ITb5a5YP1brXT2xdtQcXyXUAIqb29/gCFVPD6fej6QlA==" },
  { name: "@agent-teams/docs-protocol-mcp", version: "0.2.11", integrity: "sha512-SIk4UHo5+BS0WLfQZkdK4piGL+1GqNdY5P/NX/7AGzwKTr2NdfUXN1UkZ8eIM+GKkL9+f5yruaj+udgPiYdCAw==" },
  { name: "@agent-teams/engineering-foundation", version: "4.0.1", integrity: "sha512-fZ1TUE85ke60H9Q/KvdvGMpaX6HNBXXjyOlyqtYMeVzhXT3CvCOrN0F5NkhK0O0Ei/lx0Ev/qARJw/zkiJQaeA==" },
] as const;
type Pin = (typeof PINS)[number];
type ObjectValue = Record<string, unknown>;
type FailureCode = "source" | "identity" | "deadline" | "process" | "json" | "metadata" | "unexpected";
class ObservationFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; }
}
const deadline = Date.now() + 10 * 60_000;
const observations: ObjectValue[] = [];
const report: ObjectValue = {
  kind: "release-audit-observation/v1",
  qualified: false,
  scope: "six-package signature observation; not full publisher reproduction",
  sourceRevision: SOURCE,
  originalInvocation: INVOCATION,
  startedAt: new Date().toISOString(),
  observations,
};

function object(value: unknown): ObjectValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 ? value : null;
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function requireValue(condition: boolean, code: FailureCode): asserts condition {
  if (!condition) throw new ObservationFailure(code);
}
function digest(bytes: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
function run(command: "npm" | "git", args: readonly string[], cwd = process.cwd(), limit = 120_000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ObservationFailure("deadline");
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: Math.min(limit, remaining), killSignal: "SIGKILL",
  });
  const code = result.error && "code" in result.error ? result.error.code : undefined;
  const failure = code === undefined ? null
    : ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES"].includes(String(code)) ? String(code) : "spawn";
  const stdout = result.stdout ?? "";
  return {
    stdout,
    summary: {
      exitCode: result.status, signal: result.signal, failure,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    },
    ok: result.error === undefined && result.status === 0 && result.signal === null,
  };
}
async function saveReport(): Promise<void> {
  await writeFile(join(OUTPUT, "observation.json"), JSON.stringify(report, null, 2) + "\n");
}
function parsed(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new ObservationFailure("json"); }
}

async function sourceIdentity(): Promise<void> {
  requireValue(
    process.version === "v26.11.1" && process.platform === "linux" &&
      process.env["GITHUB_REPOSITORY"] === REPOSITORY &&
      process.env["GITHUB_REF"] === BRANCH && process.env["GITHUB_EVENT_NAME"] === "push",
    "identity",
  );
  const head = run("git", ["rev-parse", "HEAD"], undefined, 10_000);
  const parents = run("git", ["show", "-s", "--format=%P", "HEAD"], undefined, 10_000);
  const paths = run("git", ["diff", "--name-only", SOURCE, "HEAD"], undefined, 10_000);
  requireValue(head.ok && parents.ok && paths.ok, "source");
  requireValue(/^[a-f0-9]{40}$/.test(head.stdout.trim()) &&
    head.stdout.trim() === process.env["GITHUB_SHA"] &&
    parents.stdout.trim() === SOURCE &&
    paths.stdout.trim() === SOURCE_FILES.join("\n"), "source");
  report["observationRevision"] = head.stdout.trim();
  report["runId"] = process.env["GITHUB_RUN_ID"];
  report["runAttempt"] = process.env["GITHUB_RUN_ATTEMPT"];
  report["sourceFiles"] = await Promise.all(SOURCE_FILES.map(async path => ({
    path, digest: digest(await readFile(path)),
  })));
}

async function npmIdentity(): Promise<void> {
  const version = run("npm", ["--version"], undefined, 10_000);
  const versions = run("npm", ["--versions", "--json"], undefined, 10_000);
  report["npmVersionProcess"] = version.summary;
  report["npmVersionsProcess"] = versions.summary;
  requireValue(version.ok && version.stdout.trim() === "11.19.0" && versions.ok, "identity");
  const child = object(parsed(versions.stdout));
  requireValue(child?.["npm"] === "11.19.0" && child["node"] === "26.11.1", "identity");
  let cli: string | undefined;
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", "npm");
    try {
      await access(candidate, constants.X_OK);
      cli = await realpath(candidate);
      break;
    } catch { /* Continue the ordinary executable lookup; no path or error dump. */ }
  }
  requireValue(cli !== undefined, "identity");
  const npmRoot = dirname(dirname(cli));
  const metadata = object(parsed(await readFile(join(npmRoot, "package.json"), "utf8")));
  requireValue(metadata?.["name"] === "npm" && metadata["version"] === "11.19.0", "identity");
  const pacote = object(parsed(await readFile(join(npmRoot, "node_modules/pacote/package.json"), "utf8")));
  report["runtime"] = {
    node: process.version, nodeExecutable: await realpath(process.execPath),
    npm: version.stdout.trim(), npmChildNode: child?.["node"], npmCli: cli,
    pacote: string(pacote?.["version"]),
    npmVerifierDigest: digest(await readFile(join(npmRoot, "lib/utils/verify-signatures.js"))),
    pacoteRegistryDigest: digest(await readFile(join(npmRoot, "node_modules/pacote/lib/registry.js"))),
  };
}

async function configObservation(cwd: string): Promise<ObjectValue[]> {
  const keys = ["offline", "prefer-offline", "cache", "omit", "workspace",
    "workspaces", "include-workspace-root", "registry", "@agent-teams:registry"] as const;
  return keys.map(key => {
    const observed = run("npm", ["config", "get", key], cwd, 10_000);
    const value = observed.stdout.trim();
    let projection: unknown = "unavailable";
    if (observed.ok) {
      if (key === "registry" || key === "@agent-teams:registry") {
        projection = { equalsOfficialRegistry: value === REGISTRY,
          unset: value === "undefined" || value === "null" || value === "" };
      } else if (key === "cache") {
        projection = value.length <= 4096 && !value.includes("\n") ? value : "unexpected";
      } else if (key === "omit") {
        const values = value === "" ? [] : value.split(/\s+/);
        projection = values.every(item => ["dev", "optional", "peer"].includes(item))
          ? values : "unexpected";
      } else if (key === "workspace") {
        projection = { selected: !["", "undefined", "null"].includes(value),
          valueCount: ["", "undefined", "null"].includes(value) ? 0 : value.split("\n").length };
      } else {
        projection = value === "true" ? true : value === "false" ? false
          : ["", "undefined", "null"].includes(value) ? null : "unexpected";
      }
    }
    return { key, process: observed.summary, value: projection };
  });
}

function auditShape(evidence: ObjectValue, pin: Pin): ObjectValue {
  const verified = array(evidence["verified"]);
  const matches = verified.map(object).filter(entry =>
    entry?.["name"] === pin.name && entry["version"] === pin.version);
  const ownerEndpoint = REGISTRY + "-/npm/v1/attestations/" + encodeURIComponent(pin.name) + "@" + pin.version;
  const pacoteEndpoint = REGISTRY + "-/npm/v1/attestations/" + pin.name.replace("/", "%2f") + "@" + pin.version;
  return {
    invalidCount: Array.isArray(evidence["invalid"]) ? evidence["invalid"].length : null,
    missingCount: Array.isArray(evidence["missing"]) ? evidence["missing"].length : null,
    verifiedCount: verified.length,
    targetMatchCount: matches.length,
    sameNameOtherVersionCount: verified.map(object).filter(entry =>
      entry?.["name"] === pin.name && entry["version"] !== pin.version).length,
    targets: matches.map(entry => {
      const attestations = object(entry?.["attestations"]);
      const bundles = array(entry?.["attestationBundles"]);
      return {
        location: string(entry?.["location"]),
        registryEqualsOfficial: entry?.["registry"] === REGISTRY,
        provenancePredicate: string(object(attestations?.["provenance"])?.["predicateType"]),
        attestationsUrlEqualsOwnerEndpoint: attestations?.["url"] === ownerEndpoint,
        attestationsUrlEqualsPacoteEndpoint: attestations?.["url"] === pacoteEndpoint,
        slsaBundleCount: bundles.filter(bundle => object(bundle)?.["predicateType"] === SLSA).length,
        publishBundleCount: bundles.filter(bundle => object(bundle)?.["predicateType"] === PUBLISH).length,
        bundleCount: bundles.length,
        bundlePredicates: bundles.slice(0, 32).map(bundle => string(object(bundle)?.["predicateType"])),
      };
    }),
  };
}

async function observe(pin: Pin, index: number): Promise<void> {
  const folder = String(index + 1) + "-" + pin.name.split("/")[1];
  const destination = join(OUTPUT, folder);
  await mkdir(destination);
  const root = await mkdtemp(join(tmpdir(), "ordered-release-signature-"));
  const observation: ObjectValue = { ...pin, qualified: false, directory: folder };
  observations.push(observation);
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }) + "\n");
    observation["config"] = await configObservation(root);
    await saveReport();
    const install = run("npm", npmSignatureInstallArguments({ ...pin, archivePath: "", registry: REGISTRY }), root);
    observation["install"] = install.summary;
    await saveReport();
    if (!install.ok) { observation["failure"] = "install-process"; return; }
    const audit = run("npm", ["audit", "signatures", "--json", "--include-attestations",
      "--prefer-online", "--registry=" + REGISTRY], root);
    observation["audit"] = audit.summary;
    let evidence: ObjectValue | undefined;
    try { evidence = object(parsed(audit.stdout)); } catch { /* Bounded projection below. */ }
    const publicAudit = evidence !== undefined &&
      Object.keys(evidence).sort().join(",") === "invalid,missing,verified" &&
      ["invalid", "missing", "verified"].every(key => Array.isArray(evidence?.[key]));
    if (!publicAudit || evidence === undefined) {
      observation["failure"] = "audit-json-shape";
      return;
    }
    await writeFile(join(destination, "audit.json"), audit.stdout);
    observation["auditDigest"] = digest(audit.stdout);
    observation["shape"] = auditShape(evidence, pin);
    observation["complete"] = true;
    if (!audit.ok) { observation["ownerAcceptance"] = "not-invoked-process-refusal"; return; }
    try {
      const provenance: unknown = verifiedProvenanceFromNpmAudit(evidence, pin, {
        repository: "https://github.com/" + REPOSITORY,
        workflow: ".github/workflows/release.yml", ref: "refs/heads/main",
        expectedInvocation: INVOCATION,
      });
      if (object(provenance)?.["commit"] !== SOURCE) {
        observation["ownerAcceptance"] = "source-commit-refusal";
      } else {
        observation["ownerAcceptance"] = "accepted";
        observation["verifiedProvenance"] = provenance;
      }
    } catch {
      observation["ownerAcceptance"] = "owner-verifier-refusal";
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    await saveReport();
  }
}

await mkdir(OUTPUT, { recursive: true });
try {
  await sourceIdentity();
  await npmIdentity();
  await saveReport();
  for (const [index, pin] of PINS.entries()) await observe(pin, index);
  report["completed"] = observations.length === PINS.length &&
    observations.every(observation => observation["complete"] === true);
  if (report["completed"] !== true) process.exitCode = 1;
} catch (error) {
  report["completed"] = false;
  report["failure"] = error instanceof ObservationFailure ? error.code : "unexpected";
  process.exitCode = 1;
} finally {
  report["finishedAt"] = new Date().toISOString();
  await saveReport();
  process.stdout.write(JSON.stringify({
    kind: report["kind"], qualified: false, completed: report["completed"],
    packages: observations.map(observation => ({
      name: observation["name"], version: observation["version"],
      ownerAcceptance: observation["ownerAcceptance"], failure: observation["failure"],
    })),
  }) + "\n");
}
