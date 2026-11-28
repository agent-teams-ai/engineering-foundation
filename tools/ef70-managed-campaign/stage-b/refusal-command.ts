import { join } from "node:path";
import { assertOwnedCasePath, observationChildEnvironment } from "../owned-root.ts";
import {
  array,
  command,
  digest,
  object,
  parse,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
} from "../stage-a/io.ts";
import {
  bytes,
  equal,
  exactPath,
  image,
  selectedBytes,
  sourceCohort,
  type ManagedContext,
} from "./context.ts";
import {
  external,
  relativeFile,
  wrongDigest,
  type RefusalCase,
  type RefusalSelection,
} from "./refusal-contracts.ts";
import { type RefusalPreparation, type RefusalCurrentSelection } from "./refusal-preparation.ts";

export function selectRefusalRuntime(
  c: ManagedContext,
  refusalCase: RefusalCase,
  fault: JsonRecord,
  preservedFiles: Map<string, string>,
) {
  let executable = c.node24;
  const childEnvironment = observationChildEnvironment();
  const environmentDelta: Record<string, string> = {};
  if (refusalCase === "wrong-controller") {
    executable = c.node26;
  }
  if (refusalCase === "wrong-target-runtime") {
    environmentDelta["AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE"] = c.node24;
  }
  if (refusalCase === "wrong-manager") {
    const home = exactPath(fault["corepackHome"], "owned negative Corepack home");
    assertOwnedCasePath(home, "-corepack");
    external(home, [c.consumer, c.installation]);
    const knownGood = parse(
      utf8(bytes(join(home, "lastKnownGood.json"))),
      "actual Corepack default selection",
    );
    if (
      !/^11\.18\.0(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.test(
        string(knownGood["pnpm"], "actual selected pnpm"),
      )
    ) {
      throw new Error(
        "Manager fault requires genuine cached pnpm11.18.0 as the known-good default.",
      );
    }
    Object.assign(environmentDelta, {
      COREPACK_HOME: home,
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_DEFAULT_TO_LATEST: "0",
      // Keep the genuine wrong manager observable to the unchanged owner guard.
      pnpm_config_pm_on_fail: "warn",
    });
    preservedFiles.set("manager-default", join(home, "lastKnownGood.json"));
  }
  Object.assign(childEnvironment, environmentDelta);
  if (refusalCase === "wrong-manager") {
    const observed = command(
      "wrong-manager-witness",
      c.node26,
      [c.corepack, "pnpm", "--version"],
      c.consumer,
      { environment: childEnvironment },
    );
    requireEqual(utf8(observed.stdout).trim(), "11.18.0", "actual wrong manager version");
  }
  return { executable, childEnvironment, environmentDelta };
}

export function selectRefusalInputs(
  c: ManagedContext,
  selected: RefusalSelection,
  custody: {
    retained: RefusalPreparation["retained"];
    currentDigest: string | undefined;
    preservedFiles: Map<string, string>;
  },
) {
  const { refusalCase, fault } = selected;
  const { retained, currentDigest, preservedFiles } = custody;
  let lockPath = c.selectedLock.path,
    lockDigest = c.selectedLock.digest;
  let expect = retained?.digest,
    selectionExpect = currentDigest;
  if (refusalCase === "lock-digest") {
    lockDigest = wrongDigest(fault["wrongDigest"], lockDigest);
  }
  if (refusalCase === "lock-foreign-scope") {
    const changed = selectedBytes(fault["changedLock"], "actual separately selected foreign lock");
    external(changed.path, [c.consumer, c.installation]);
    if (changed.digest === c.selectedLock.digest) {
      throw new Error("Foreign lock has not changed.");
    }
    lockPath = changed.path;
    lockDigest = changed.digest;
    preservedFiles.set("changed-lock", changed.path);
  }
  if (refusalCase === "stale-preparation-digest") {
    expect = wrongDigest(fault["wrongDigest"], retained!.digest);
  }
  if (refusalCase === "stale-current-digest") {
    selectionExpect = wrongDigest(fault["wrongDigest"], currentDigest!);
  }
  return { lockPath, lockDigest, expect, selectionExpect };
}
type RefusalInputs = ReturnType<typeof selectRefusalInputs>;

export function observeRefusalImages(
  c: ManagedContext,
  selected: RefusalSelection,
  preparation: JsonRecord | undefined,
  preservedFiles: Map<string, string>,
): readonly string[] {
  const { refusalCase, fault, contract } = selected;
  const pin = image(c.consumer, ".node-version");
  requireEqual(pin.kind, "file", "real regular pin file");
  if (refusalCase === "pin-bytes") {
    if (pin.sha256 === digest("26.12.1\n")) {
      throw new Error("Pin bytes have not changed.");
    }
    requireEqual(pin.mode, 0o644, "byte-only pin fault");
  } else {
    requireEqual(pin.sha256, digest("26.12.1\n"), "same-pin bytes");
    requireEqual(pin.mode, refusalCase === "pin-mode" ? 0o600 : 0o644, "selected pin mode");
  }
  let expectedMessages: readonly string[] = contract.messages;
  if (refusalCase === "foreign-image" || refusalCase === "host-overlap") {
    const path = relativeFile(fault["path"]);
    const operations = array(
      object(preparation?.["plan"], "actual plan")["operations"],
      "operations",
    ).map((value) => object(value, "operation"));
    const managed = operations.find((entry) => entry["path"] === path);
    if (!managed || path === "architecture/foundation/docs-consumer-integration.json") {
      throw new Error("Select one actual managed non-profile file.");
    }
    const actual = image(c.consumer, path),
      post = object(managed["postimage"], "postimage");
    const original = object(
      array(object(managed["precondition"], "precondition")["acceptedPreimages"], "preimages")[0],
      "original",
    );
    if (actual.sha256 === post["digest"] && actual.mode === post["mode"]) {
      throw new Error("Managed target image has not changed.");
    }
    if (
      refusalCase === "foreign-image" &&
      actual.sha256 === original["digest"] &&
      actual.mode === original["mode"]
    ) {
      throw new Error("Managed source image is still accepted.");
    }
    expectedMessages = [
      refusalCase === "foreign-image"
        ? `current bytes or mode differ at ${path}.`
        : `committed managed postimage changed at ${path}; reverse overlapping Host changes first.`,
    ];
  }
  if (refusalCase === "build-drift") {
    const path = relativeFile(fault["path"]);
    if (!path.startsWith("schemas/") || !path.endsWith(".json")) {
      throw new Error("Build drift must be one inert schema JSON file.");
    }
    const original = selectedBytes(fault["original"], "retained original schema bytes");
    external(original.path, [c.consumer, c.installation]);
    const actualPath = join(c.controllerRoot, path),
      altered = bytes(actualPath);
    if (digest(altered) === original.digest) {
      throw new Error("Selected schema bytes have not changed.");
    }
    equal(
      parse(utf8(altered), "changed inert schema"),
      parse(utf8(original.bytes), "original inert schema"),
      "schema meaning preserved",
    );
    preservedFiles.set("changed-artifact-data", actualPath);
    preservedFiles.set("original-artifact-data", original.path);
  }
  return expectedMessages;
}

export function refusalArguments(
  c: ManagedContext,
  selection: JsonRecord,
  custody: RefusalPreparation,
  current: RefusalCurrentSelection,
  inputs: RefusalInputs,
) {
  const { isPrepare, isCommitted, completionPath, preparationPath } = custody;
  const { currentSelectionPath } = current;
  const { lockPath, lockDigest, expect, selectionExpect } = inputs;
  const commandName = isPrepare ? "upgrade" : isCommitted ? "restore" : "finalize";
  const args = isPrepare
    ? [
        "upgrade",
        "--consumer",
        c.consumer,
        "--to",
        c.targetCohort,
        "--authority-revision",
        c.authorityRevision,
        "--source-generation",
        "2",
        "--target-generation",
        "3",
        "--prepare",
        "--restoration-proof",
        completionPath,
        "--target-lockfile",
        lockPath,
        "--target-lockfile-sha256",
        lockDigest,
        "--json",
      ]
    : isCommitted
      ? [
          "restore",
          "--consumer",
          c.consumer,
          "--from",
          c.targetCohort,
          "--to",
          sourceCohort,
          "--source-generation",
          "3",
          "--target-generation",
          "2",
          "--preparation",
          preparationPath,
          "--expect",
          expect!,
          "--current-revision",
          string(selection["currentRevision"], "current revision"),
          "--current-tree",
          string(selection["currentTree"], "current tree"),
          "--selection",
          currentSelectionPath!,
          ...(selectionExpect === undefined ? [] : ["--selection-expect", selectionExpect]),
          "--json",
        ]
      : [
          "finalize",
          "--consumer",
          c.consumer,
          "--from",
          sourceCohort,
          "--to",
          c.targetCohort,
          "--source-generation",
          "2",
          "--target-generation",
          "3",
          "--preparation",
          preparationPath,
          "--expect",
          expect!,
          "--proof",
          completionPath,
          "--json",
        ];
  return { commandName, args };
}
