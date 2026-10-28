import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import {
  qualityRecord,
  qualityString,
  qualityStrings,
  qualityScriptCommand,
} from "./profile-input.js";
import {
  executesScript,
  qualityHostCommand,
  classifyFormatCoverage,
  assertRepositoryRelativePath,
  assertNotCancelled,
  formatAuthorityEntrypoint,
  rejectFormatCoverage,
  type FormatCoverageObservation,
  type FormatCoveragePorts,
  type FormatAuthorityPolicy,
  type QualityFileReader,
  type QualityObservationPorts,
} from "../api.js";
type FormatInvocation = Parameters<FormatCoveragePorts["read"]>[0];

const records = (value: unknown) => {
  if (!Array.isArray(value)) {
    rejectFormatCoverage("Expected profile records.");
  }
  return value.map((entry: unknown) => qualityRecord(entry));
};
const strings = (value: unknown) =>
  qualityStrings(value).map((path) => {
    assertRepositoryRelativePath(path, "format-coverage");
    return path;
  });

interface FormatObservationDependencies {
  readonly census: QualityObservationPorts["census"];
  readonly readFile: QualityFileReader;
  readonly readYaml: (
    root: string,
    path: string,
    phase: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly assertSchema: (
    id: "quality-format-coverage/v1",
    value: unknown,
    phase: string,
  ) => Promise<void>;
  readonly readGates: (
    root: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<FormatAuthorityPolicy>;
}

async function snapshot(deps: FormatObservationDependencies, input: FormatInvocation) {
  const census = await deps.census.read({
    consumerRoot: input.consumerRoot,
    roots: ["."],
    generatedDirectories: "observe",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const fingerprints = new Map<string, string>();
  let total = 0;
  for (const path of census.filePaths) {
    assertNotCancelled(input.signal);
    const bytes = await deps.readFile({
      root: input.consumerRoot,
      candidate: join(input.consumerRoot, path),
      maxBytes: 4 * 1024 * 1024,
    });
    total += bytes.byteLength;
    if (total > 512 * 1024 * 1024) {
      rejectFormatCoverage("Formatting input byte budget exceeded.");
    }
    fingerprints.set(path, createHash("sha256").update(bytes).digest("hex"));
  }
  return { paths: census.filePaths, fingerprints };
}

function alternateGate(profile: Record<string, unknown>, ids: readonly string[]) {
  const rawGate = profile["alternates"];
  const gate =
    rawGate === undefined
      ? undefined
      : {
          configPath: strings([qualityRecord(rawGate)["configPath"]])[0]!,
          profileId: qualityString(qualityRecord(rawGate)["profileId"]),
        };
  if (ids.length === 0 && gate !== undefined) {
    rejectFormatCoverage("Unused alternate gate is prohibited.");
  }
  return gate;
}

function assertAlternateProfile(
  policy: FormatAuthorityPolicy,
  profileId: string,
  ids: readonly string[],
): void {
  const selected = policy.profiles.find(({ id }) => id === profileId);
  if (
    selected === undefined ||
    selected.concurrency !== 1 ||
    selected.tasks.length !== ids.length ||
    new Set(selected.tasks.map(({ id }) => id)).size !== ids.length ||
    selected.tasks.some(
      (task, index) =>
        !ids.includes(task.id) ||
        task.after.length !== 0 ||
        task.needs.length !== (index === 0 ? 0 : 1) ||
        (index > 0 && task.needs[0] !== selected.tasks[index - 1]?.id),
    )
  ) {
    rejectFormatCoverage(
      "Alternate profile must contain exactly the blocking authority chain once.",
    );
  }
}

function requireFormatScript(
  catalog: Readonly<Record<string, string>>,
  scripts: Record<string, unknown>,
): { readonly formatId: string } {
  const formatId = qualityString(scripts["format"]);
  const expected = catalog[formatId];
  if (
    expected !== "agent-teams-foundation quality format --consumer ." &&
    expected !== "node packages/engineering-foundation/dist/cli.js quality format --consumer ." &&
    !qualityHostCommand(expected, false, "format")
  ) {
    rejectFormatCoverage("Full format script must bind the Foundation formatting command.");
  }
  for (const required of qualityStrings(scripts["required"])) {
    if (required === formatId || !executesScript(catalog, required, formatId, expected!)) {
      rejectFormatCoverage("Required gate does not reach full format coverage.");
    }
  }
  return { formatId };
}

export function createFormatObservations(
  deps: FormatObservationDependencies,
): Pick<FormatCoveragePorts, "read" | "verify"> {
  return {
    async read(input): Promise<FormatCoverageObservation> {
      const profileBytes = await deps.readFile({
        root: input.consumerRoot,
        candidate: join(input.consumerRoot, input.configPath),
        maxBytes: 1024 * 1024,
      });
      const value = await deps.readYaml(
        input.consumerRoot,
        input.configPath,
        "format-coverage",
        input.signal,
      );
      await deps.assertSchema("quality-format-coverage/v1", value, "format-coverage");
      const profile = qualityRecord(value);
      const scripts = qualityRecord(profile["scripts"]);
      const packageBytes = await deps.readFile({
        root: input.consumerRoot,
        candidate: join(input.consumerRoot, "package.json"),
        maxBytes: 1024 * 1024,
      });
      const packageScripts = qualityRecord(
        qualityRecord(
          parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes)),
        )["scripts"],
      );
      const catalog = Object.fromEntries(
        Object.entries(packageScripts).map(([id, command]) => [id, qualityScriptCommand(command)]),
      );
      const { formatId } = requireFormatScript(catalog, scripts);
      const authorities = records(profile["authorities"]);
      const bindings = new Map(
        authorities.map((entry) => [qualityString(entry["id"]), qualityString(entry["script"])]),
      );
      const ids = [...bindings.values()];
      if (
        bindings.size !== authorities.length ||
        new Set(ids).size !== ids.length ||
        ids.includes(formatId)
      ) {
        rejectFormatCoverage("Authority identities and scripts must be unique.");
      }
      const validatorFiles: string[] = [];
      for (const id of [formatId, ...ids]) {
        if (catalog[`pre${id}`] !== undefined || catalog[`post${id}`] !== undefined) {
          rejectFormatCoverage("Format authority hooks are prohibited.");
        }
        if (id === formatId) {
          continue;
        }
        const entrypoint = formatAuthorityEntrypoint(catalog[id]);
        if (entrypoint === undefined) {
          rejectFormatCoverage(
            "Authority must be an explicit contained read-only validator command.",
          );
        }
        validatorFiles.push(entrypoint);
        await deps.readFile({
          root: input.consumerRoot,
          candidate: join(input.consumerRoot, entrypoint),
          maxBytes: 4 * 1024 * 1024,
        });
      }
      const routes = records(profile["routes"]).map((route) => {
        const authority = bindings.get(qualityString(route["authority"]));
        if (authority === undefined) {
          rejectFormatCoverage("Unknown format authority.");
        }
        return {
          authority,
          files: strings(route["files"]),
          trees: records(route["trees"]).map((tree) => ({
            path: strings([tree["path"]])[0]!,
            suffixes: qualityStrings(tree["suffixes"]),
          })),
        };
      });
      const observed = await snapshot(deps, input);
      if (
        observed.fingerprints.get(input.configPath) !==
          createHash("sha256").update(profileBytes).digest("hex") ||
        observed.fingerprints.get("package.json") !==
          createHash("sha256").update(packageBytes).digest("hex") ||
        validatorFiles.some((path) => !observed.fingerprints.has(path))
      ) {
        rejectFormatCoverage(
          "Profile, root metadata or validator source changed or escaped the observed universe.",
        );
      }
      const selection = { maintainedRoots: strings(profile["maintainedRoots"]), routes };
      const classified = classifyFormatCoverage(observed.paths, selection);
      if (ids.some((id) => !classified.authorityFiles.has(id))) {
        rejectFormatCoverage("Every authority must own current inputs.");
      }
      const gate = alternateGate(profile, ids);
      if (gate !== undefined) {
        const policy = await deps.readGates(input.consumerRoot, gate.configPath, input.signal);
        assertAlternateProfile(policy, gate.profileId, ids);
      }
      const budgetMs = profile["budgetMs"];
      if (typeof budgetMs !== "number") {
        rejectFormatCoverage("Missing format budget.");
      }
      return {
        ...observed,
        selection,
        budgetMs,
        authorities: ids,
        ...(gate === undefined ? {} : { gate }),
      };
    },
    async verify(input, observed) {
      const current = await snapshot(deps, input);
      if (
        JSON.stringify(current.paths) !== JSON.stringify(observed.paths) ||
        current.paths.some(
          (path) => current.fingerprints.get(path) !== observed.fingerprints.get(path),
        )
      ) {
        rejectFormatCoverage("Formatting input universe or source bytes changed.");
      }
    },
  };
}
