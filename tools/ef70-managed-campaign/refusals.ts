import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  digest,
  row,
  text,
  type Campaign,
  type HelperResult,
  type PreparedCase,
  type Row,
} from "./campaign-support.ts";
import {
  completionPath,
  fileFault,
  freshDirectory,
  mismatchedDigest,
  preparedRefusalCases,
  proofImages,
  readRegular,
  retain,
  runRefusal,
  type PreparedRefusal,
} from "./refusal-custody.ts";
export { preparedRefusalCases } from "./refusal-custody.ts";

type RefusalDirectory = (name: PreparedRefusal) => string;
type RefusalRecorder = (name: PreparedRefusal, result: HelperResult) => void;

function installationImages(campaign: Campaign, root: string): Row[] {
  const images: Row[] = [];
  function visit(path: string, depth: number): void {
    assert(depth <= 32 && images.length < 10_000);
    const stat = lstatSync(path),
      name = relative(root, path) || ".";
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      assert(!isAbsolute(target), "Installation copy cannot retain absolute symlink aliases");
      const within = relative(root, realpathSync(path));
      assert(
        within !== "" && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`),
      );
      images.push({ path: name, kind: "symlink", mode: stat.mode & 0o777, target });
    } else if (stat.isDirectory()) {
      images.push({ path: name, kind: "directory", mode: stat.mode & 0o777 });
      for (const child of readdirSync(path).toSorted()) {
        visit(join(path, child), depth + 1);
      }
    } else {
      assert(stat.isFile() && stat.nlink === 1);
      images.push({
        path: name,
        kind: "file",
        mode: stat.mode & 0o777,
        bytes: stat.size,
        sha256: campaign.selected(path).sha256,
      });
    }
  }
  visit(root, 0);
  return images;
}

async function refuseWrongManager(
  campaign: Campaign,
  prepared: PreparedCase,
  evidence: string,
): Promise<HelperResult> {
  const name = "wrong-manager";
  const home = join(campaign.root, `case-${prepared.name}-wrong-manager-corepack`);
  freshDirectory(home);
  const environment = {
    ...campaign.environment,
    COREPACK_HOME: home,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_DEFAULT_TO_LATEST: "0",
  };
  await campaign.command(
    `${prepared.name}-negative-manager-materialize`,
    campaign.node26Executable,
    [campaign.corepackEntrypoint, "install", "--global", "pnpm@11.18.0"],
    prepared.root,
    { environment },
  );
  const knownGoodPath = join(home, "lastKnownGood.json");
  const knownGood = row(
    JSON.parse(readRegular(knownGoodPath).content.toString("utf8")),
    "actual negative Corepack default",
  );
  assert(
    /^11\.18\.0(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.test(text(knownGood["pnpm"], "actual manager")),
  );
  assert(!existsSync(join(home, "v1/pnpm/11.20.0")));
  retain(join(evidence, "actual-manager-default.json"), readRegular(knownGoodPath).content);
  return await runRefusal(campaign, prepared, name, {
    directory: evidence,
    fault: { corepackHome: home },
  });
}

async function refuseWrongRoot(
  campaign: Campaign,
  prepared: PreparedCase,
  evidence: string,
  completion: string,
): Promise<HelperResult> {
  const name = "wrong-root";
  const other = await campaign.createCase(`${prepared.name}-refusal-root`);
  const selected: PreparedCase = {
    ...other,
    preparation: prepared.preparation,
    selection: { ...other.selection, completionPath: completion },
  };
  assert.notEqual(other.root, prepared.root);
  return await runRefusal(campaign, selected, name, { directory: evidence, fault: {} });
}

async function refuseBuildDrift(
  campaign: Campaign,
  prepared: PreparedCase,
  evidence: string,
): Promise<HelperResult> {
  const name = "build-drift";
  const originalInstallation = campaign.controllerInstallation;
  const copy = join(campaign.root, `controller-${prepared.name}-build-drift`);
  assert(!existsSync(copy));
  const originalImages = installationImages(campaign, originalInstallation);
  cpSync(originalInstallation, copy, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  assert.equal(realpathSync(copy), copy);
  assert.deepEqual(installationImages(campaign, copy), originalImages);
  const schema = "schemas/docs-protocol-command-envelope/v1.schema.json";
  const relativeSchema = join("node_modules/@agent-teams/docs-protocol-agent-teams", schema);
  const originalSchema = readRegular(join(originalInstallation, relativeSchema));
  const copiedSchema = readRegular(join(copy, relativeSchema));
  assert(
    copiedSchema.image.device !== originalSchema.image.device ||
      copiedSchema.image.inode !== originalSchema.image.inode,
  );
  assert.equal(copiedSchema.image.sha256, originalSchema.image.sha256);
  const altered = Buffer.concat([copiedSchema.content, Buffer.from("\n")]);
  assert.deepEqual(
    JSON.parse(altered.toString("utf8")),
    JSON.parse(copiedSchema.content.toString("utf8")),
  );
  const original = join(evidence, "selected-original-schema.json");
  retain(original, copiedSchema.content);
  const result = await fileFault(campaign, prepared, name, {
    directory: evidence,
    path: join(copy, relativeSchema),
    content: altered,
    mode: copiedSchema.image.mode,
    fault: { path: schema, original: campaign.selected(original) },
    fields: { controllerInstallation: copy },
  });
  assert.deepEqual(installationImages(campaign, copy), originalImages);
  assert.deepEqual(installationImages(campaign, originalInstallation), originalImages);
  campaign.record(`${prepared.name}-build-copy-restored`, {
    originalInstallation,
    copy,
    completeOriginalAndCopyImages: originalImages,
    originalInstallationUnchanged: true,
    copiedSchemaRestored: true,
  });
  return result;
}

async function refuseForeignImage(
  campaign: Campaign,
  prepared: PreparedCase,
  evidence: string,
): Promise<HelperResult> {
  const name = "foreign-image";
  const preparation = row(
    JSON.parse(readRegular(prepared.preparation.path).content.toString("utf8")),
    "genuine preparation",
  );
  const operations = row(preparation["plan"], "actual preparation plan")["operations"];
  assert(Array.isArray(operations));
  const operation = operations
    .map((value: unknown) => row(value, "managed operation"))
    .find((value) => value["path"] === "package.json");
  assert(operation !== undefined, "package.json must be an actual managed non-profile path");
  const path = join(prepared.root, "package.json"),
    original = readRegular(path);
  const altered = Buffer.concat([original.content, Buffer.from("\n")]);
  assert.deepEqual(
    JSON.parse(altered.toString("utf8")),
    JSON.parse(original.content.toString("utf8")),
  );
  const accepted = row(operation["precondition"], "managed precondition")["acceptedPreimages"];
  assert(Array.isArray(accepted) && accepted.length > 0);
  const source = row(accepted[0], "actual original image");
  const target = row(operation["postimage"], "actual target image");
  assert.equal(original.image.sha256, source["digest"]);
  assert.equal(original.image.mode, source["mode"]);
  assert.notEqual(digest(altered), source["digest"]);
  assert.notEqual(digest(altered), target["digest"]);
  return await fileFault(campaign, prepared, name, {
    directory: evidence,
    path,
    content: altered,
    mode: original.image.mode,
    fault: { path: "package.json" },
  });
}

async function refuseLockInputs(
  campaign: Campaign,
  prepared: PreparedCase,
  directory: RefusalDirectory,
  remember: RefusalRecorder,
): Promise<void> {
  const lock = row(prepared.selection["targetLock"], "actual selected target lock");
  const lockPath = text(lock["path"], "actual lock path");
  const originalLock = readRegular(lockPath);
  assert.equal(originalLock.image.sha256, lock["sha256"]);
  for (const name of ["lock-digest", "lock-foreign-scope"] as const) {
    const evidence = directory(name);
    const freshCompletion = join(evidence, "completion.json");
    for (const path of [
      freshCompletion,
      `${freshCompletion}.prepared`,
      `${freshCompletion}.receipt`,
    ]) {
      assert(!existsSync(path));
    }
    let fault: Row;
    if (name === "lock-digest") {
      fault = { wrongDigest: mismatchedDigest(originalLock.image.sha256) };
    } else {
      const original = originalLock.content.toString("utf8");
      const marker = "\n  packages/core: {}\n";
      assert.equal(original.split(marker).length, 2);
      assert(!original.includes("packages/ef70-refusal-foreign"));
      const changed = original.replace(marker, `${marker}\n  packages/ef70-refusal-foreign: {}\n`);
      const foreign = join(evidence, "foreign-target-lock.yaml");
      retain(foreign, Buffer.from(changed));
      fault = { changedLock: campaign.selected(foreign) };
      campaign.record(`${prepared.name}-foreign-lock-injection`, {
        original: { path: lockPath, sha256: originalLock.image.sha256 },
        changed: campaign.selected(foreign),
        modification:
          "Only one empty non-root importer is added; no comment, package, snapshot, root pin or managed closure edit.",
      });
    }
    remember(
      name,
      await runRefusal(campaign, prepared, name, {
        directory: evidence,
        fault,
        fields: { completionPath: freshCompletion },
      }),
    );
    assert.deepEqual(readRegular(lockPath).image, originalLock.image);
    for (const path of [
      freshCompletion,
      `${freshCompletion}.prepared`,
      `${freshCompletion}.receipt`,
    ]) {
      assert(!existsSync(path));
    }
  }
}

async function refusePinChanges(
  campaign: Campaign,
  prepared: PreparedCase,
  directory: RefusalDirectory,
  remember: RefusalRecorder,
): Promise<void> {
  const pinPath = join(prepared.root, ".node-version");
  const pin = readRegular(pinPath);
  assert.equal(pin.content.toString("utf8"), "26.12.1\n");
  assert.equal(pin.image.mode, 0o644);
  for (const name of ["pin-bytes", "pin-mode"] as const) {
    remember(
      name,
      await fileFault(campaign, prepared, name, {
        directory: directory(name),
        path: pinPath,
        content:
          name === "pin-bytes" ? Buffer.concat([pin.content, Buffer.from("\n")]) : pin.content,
        mode: name === "pin-mode" ? 0o600 : pin.image.mode,
        fault: {},
      }),
    );
    assert.deepEqual(readRegular(pinPath).image, pin.image);
  }
}

/** Eleven genuine public refusal calls before the first successful finalize. */
export async function runPreparedRefusals(
  campaign: Campaign,
  prepared: PreparedCase,
): Promise<void> {
  const completion = completionPath(prepared);
  assert(existsSync(prepared.preparation.path));
  assert(!existsSync(completion) && !existsSync(`${completion}.receipt`));
  assert.equal(prepared.selection["consumerRoot"], prepared.root);
  assert.equal(realpathSync(prepared.root), prepared.root);
  assert.equal(realpathSync(prepared.evidence), prepared.evidence);
  const initialProofs = proofImages(prepared);
  const initialImages = campaign.images(prepared.root, `${prepared.name}-before-refusals`);
  const results: { refusalCase: PreparedRefusal; output: string }[] = [];
  const directory = (name: PreparedRefusal): string => {
    const path = join(prepared.evidence, `refusal-${name}`);
    freshDirectory(path);
    return path;
  };
  const remember = (name: PreparedRefusal, result: HelperResult): void => {
    results.push({ refusalCase: name, output: result.output });
  };

  for (const name of ["wrong-controller", "wrong-target-runtime"] as const) {
    remember(
      name,
      await runRefusal(campaign, prepared, name, { directory: directory(name), fault: {} }),
    );
  }
  remember(
    "wrong-manager",
    await refuseWrongManager(campaign, prepared, directory("wrong-manager")),
  );
  remember(
    "stale-preparation-digest",
    await runRefusal(campaign, prepared, "stale-preparation-digest", {
      directory: directory("stale-preparation-digest"),
      fault: { wrongDigest: mismatchedDigest(prepared.preparation.sha256) },
    }),
  );
  await refuseLockInputs(campaign, prepared, directory, remember);
  remember(
    "wrong-root",
    await refuseWrongRoot(campaign, prepared, directory("wrong-root"), completion),
  );
  remember("build-drift", await refuseBuildDrift(campaign, prepared, directory("build-drift")));
  await refusePinChanges(campaign, prepared, directory, remember);
  remember(
    "foreign-image",
    await refuseForeignImage(campaign, prepared, directory("foreign-image")),
  );

  assert.deepEqual(
    results.map((result) => result.refusalCase),
    [...preparedRefusalCases],
  );
  assert.deepEqual(proofImages(prepared), initialProofs);
  assert.deepEqual(
    campaign.images(prepared.root, `${prepared.name}-after-refusals`),
    initialImages,
  );
  campaign.record(`${prepared.name}-prepared-refusals-complete`, {
    actualRefusalCount: results.length,
    results,
    originalPreparation: prepared.preparation,
    originalProofsPreserved: true,
    originalTrackedImagesAndModesRestored: true,
    allowedLocalEvidence:
      "foreign-image retains its genuine released lease; all prior local evidence is preserved by the collector.",
    completedBeforeFirstSuccessfulFinalize: true,
    limits:
      "Disposable public admission refusals only; no publication, EF adoption, hosted consumer qualification or CANARY grant.",
  });
}
