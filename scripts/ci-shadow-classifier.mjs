import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

const forceFullLabel = "ci:full";
const sensitivePrefixes = Object.freeze([
  ".changeset/",
  ".github/",
  "architecture/",
  "packages/",
  "scripts/",
  "tests/",
]);
const sensitiveExact = new Set([
  "AGENTS.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
]);

function portablePath(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function documentationOnly(path) {
  return path === "README.md" || path.endsWith(".md") && path.startsWith("docs/");
}

function sensitive(path) {
  return sensitiveExact.has(path) || sensitivePrefixes.some((prefix) => path.startsWith(prefix));
}

export function classifyCiShadow(input) {
  const event = input?.event;
  const files = input?.files;
  const labels = input?.labels ?? [];
  if (!Array.isArray(files) || files.length === 0 || !files.every(portablePath) ||
      !Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "unknown-input" });
  }
  if (!new Set(["merge_group", "pull_request", "push", "workflow_dispatch"]).has(event)) {
    return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "unknown-event" });
  }
  if (labels.includes(forceFullLabel)) {
    return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "escape-hatch" });
  }
  if (event === "merge_group") {
    return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "merge-queue" });
  }
  if (files.some(sensitive)) {
    return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "sensitive-change" });
  }
  if (files.every(documentationOnly)) {
    return Object.freeze({ advisory: true, candidate: "reduced", effectivePlan: "full", reason: "docs-only-shadow" });
  }
  return Object.freeze({ advisory: true, candidate: "full", effectivePlan: "full", reason: "unknown-change" });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {throw new Error(`${name} is required`);}
  return value;
}

async function run() {
  const eventPath = process.argv.includes("--github-event")
    ? resolve(process.env.GITHUB_EVENT_PATH ?? "")
    : undefined;
  let input;
  if (eventPath === undefined) {
    input = JSON.parse(await readFile(resolve(argument("--input")), "utf8"));
  } else {
    const payload = JSON.parse(await readFile(eventPath, "utf8"));
    const event = process.env.GITHUB_EVENT_NAME;
    const range = event === "pull_request"
      ? [payload.pull_request?.base?.sha, payload.pull_request?.head?.sha]
      : event === "merge_group"
        ? [payload.merge_group?.base_sha, payload.merge_group?.head_sha]
        : event === "push"
          ? [payload.before, payload.after]
          : [];
    let files = [];
    if (range.length === 2 && range.every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha))) {
      const result = await execute("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", range[0], range[1]], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      files = result.stdout.split("\n").filter(Boolean);
    }
    input = {
      event,
      files,
      labels: Array.isArray(payload.pull_request?.labels)
        ? payload.pull_request.labels.map(({ name }) => name).filter((name) => typeof name === "string")
        : [],
    };
  }
  const result = classifyCiShadow(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    await appendFile(output, `candidate=${result.candidate}\neffective-plan=${result.effectivePlan}\nreason=${result.reason}\n`, "utf8");
  }
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {await run();}
