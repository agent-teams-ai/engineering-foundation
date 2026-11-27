import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { digest, row, text, type Row } from "./campaign-support.ts";

const output = process.argv[2],
  minimumText = process.argv[3];
assert(output && minimumText && process.argv.length === 4);
assert(isAbsolute(output) && resolve(output) === output && !existsSync(output));
assert(/^[1-9][0-9]*$/u.test(minimumText));
const minimum = Number(minimumText);
assert(Number.isSafeInteger(minimum) && minimum <= 60);
const runner = text(process.env["RUNNER_TEMP"], "actual runner root");
const run = text(process.env["GITHUB_RUN_ID"], "actual run");
const attempt = text(process.env["GITHUB_RUN_ATTEMPT"], "actual attempt");
assert(/^[1-9][0-9]*$/u.test(run) && /^[1-9][0-9]*$/u.test(attempt));
const evidenceRoot = join(realpathSync(runner), "ef70-evidence-" + run + "-" + attempt);
const parent = realpathSync(dirname(output));
assert.equal(parent, dirname(output));
assert(/^case-[a-z0-9][a-z0-9-]{0,63}$/u.test(relative(evidenceRoot, parent)));
assert(/^[1-9][0-9]*-[a-z0-9-]+\.rate-budget\.json$/u.test(relative(parent, output)));
for (const key of [
  "EF70_GITHUB_READ_TOKEN",
  "EF_CAMPAIGN_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NODE_AUTH_TOKEN",
]) {
  assert(
    process.env[key] === undefined,
    "Anonymous rate observer must not receive credential " + key,
  );
}
const startedAt = new Date().toISOString(),
  deadline = Date.now() + 68 * 60_000;
const observations: Row[] = [];
const endpoint = "https://api.github.com/rate_limit";
const headerNames = [
  "date",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
  "x-ratelimit-resource",
  "retry-after",
  "x-github-request-id",
];
function integer(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, label);
  return value;
}
function integerHeader(headers: Row, name: string): number {
  const value = text(headers[name], name);
  assert(/^[0-9]+$/u.test(value), name);
  return integer(Number(value), name);
}
async function observe(): Promise<{ remaining: number; reset: number }> {
  const observedAt = new Date().toISOString();
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "EF70-disposable-campaign-rate-observer",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  assert(Buffer.byteLength(body) <= 64 * 1024, "Rate response exceeds evidence bound");
  const headers: Row = {};
  for (const name of headerNames) {
    headers[name] = response.headers.get(name);
  }
  const observation: Row = {
    observedAt,
    finishedAt: new Date().toISOString(),
    endpoint,
    status: response.status,
    headers,
    body,
    bodySha256: digest(body),
    authorizationHeaderSent: false,
  };
  observations.push(observation);
  writeFileSync(
    output + ".observation-" + observations.length + ".json",
    JSON.stringify(observation, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  assert.equal(response.status, 200, "Non-200 rate response stops before any managed invocation");
  assert.equal(
    headers["retry-after"],
    null,
    "A backoff response cannot admit a managed invocation",
  );
  assert.equal(headers["x-ratelimit-resource"], "core");
  const limit = integerHeader(headers, "x-ratelimit-limit");
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const reset = integerHeader(headers, "x-ratelimit-reset");
  integerHeader(headers, "x-ratelimit-used");
  assert(limit >= minimum && limit <= 60 && remaining <= limit);
  const resources = row(row(JSON.parse(body), "rate response")["resources"], "rate resources");
  const core = row(resources["core"], "core resource");
  integer(core["limit"], "body core limit");
  integer(core["remaining"], "body core remaining");
  integer(core["reset"], "body core reset");
  observation["selectedHeaderRemaining"] = remaining;
  observation["selectedHeaderReset"] = reset;
  observation["bodyMayDifferAcrossRegions"] = true;
  return { remaining, reset };
}
let admitted = false;
try {
  for (let number = 0; number < 4; number += 1) {
    const observed = await observe();
    if (observed.remaining >= minimum) {
      admitted = true;
      break;
    }
    const resumeAt = Math.max(Date.now() + 60_000, observed.reset * 1000 + 1500);
    assert(resumeAt < deadline, "Observed reset exceeds this finite pre-launch wait budget");
    console.log(
      "EF70 rate budget: observed " +
        observed.remaining +
        "; waiting until " +
        new Date(resumeAt).toISOString(),
    );
    while (Date.now() < resumeAt) {
      await wait(Math.min(60_000, resumeAt - Date.now()));
      console.log(
        "EF70 rate budget: waiting for the observed reset; no managed operation started.",
      );
    }
  }
  assert(admitted, "Repeated observed budget deficit; no managed operation started");
  writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        minimumObservedRequests: minimum,
        sufficientBudgetObserved: true,
        observations,
        scope:
          "Anonymous shared-IP budget observation only; not a reservation, authority read or managed-operation retry.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        minimumObservedRequests: minimum,
        sufficientBudgetObserved: false,
        observations,
        error: error instanceof Error ? error.message : String(error),
        managedOperationStarted: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  throw error;
}
