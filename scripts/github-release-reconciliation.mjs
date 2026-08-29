import { spawnSync } from "node:child_process";

export const GITHUB_RECONCILIATION_ATTEMPTS = 37;
export const GITHUB_RECONCILIATION_RETRY_MILLISECONDS = 5_000;

const COMMIT = /^[a-f0-9]{40}$/u;
const RELEASE_TAG = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const STABLE_RELEASE_TAG = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export function githubJson(args, { allowNotFound = false } = {}) {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (allowNotFound && result.status !== 0 && /HTTP 404/u.test(result.stderr)) {
    return;
  }
  if (result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.length === 0 ? undefined : JSON.parse(result.stdout);
}

function assertPolicy(policy) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).toSorted().join("\0") !== "body\0prerelease\0tag\0title" ||
      !RELEASE_TAG.test(policy.tag ?? "") || typeof policy.prerelease !== "boolean" ||
      typeof policy.title !== "string" || policy.title.length === 0 || policy.title.length > 256 ||
      /[\0\r\n]/u.test(policy.title) || typeof policy.body !== "string" ||
      policy.body.length === 0 || Buffer.byteLength(policy.body, "utf8") > 128 * 1024 ||
      policy.body.includes("\0")) {
    throw new Error("GitHub release reconciliation requires one exact bounded data policy.");
  }
}

function assertRelease(release, policy) {
  if (release?.tag_name !== policy.tag || release.name !== policy.title ||
      release.body !== policy.body || release.prerelease !== policy.prerelease ||
      release.draft !== false) {
    throw new Error(
      `Existing GitHub release ${policy.tag} differs from the reviewed changelog evidence or release policy.`,
    );
  }
}

function gitObjectCommit(repository, object, request, depth = 0) {
  if (object?.type === "commit" && COMMIT.test(object.sha ?? "")) {
    return object.sha;
  }
  if (object?.type !== "tag" || !COMMIT.test(object.sha ?? "") || depth >= 4) {
    throw new Error("Git tag does not resolve through a bounded tag chain to one commit.");
  }
  const tag = request([`repos/${repository}/git/tags/${object.sha}`]);
  return gitObjectCommit(repository, tag?.object, request, depth + 1);
}

function assertTagCommit(repository, ref, expectedCommit, request, label) {
  if (gitObjectCommit(repository, ref?.object, request) !== expectedCommit) {
    throw new Error(`${label} Git tag is not bound to the trusted release commit.`);
  }
}

function assertWriteAuthority(repository, expectedCommit, request) {
  if (expectedCommit === undefined) {
    return;
  }
  const main = request([`repos/${repository}/git/ref/heads/main`]);
  if (!COMMIT.test(expectedCommit) || main?.ref !== "refs/heads/main" ||
      main.object?.type !== "commit" || main.object.sha !== expectedCommit) {
    throw new Error("GitHub release reconciliation refused because protected main advanced.");
  }
}

async function reconcileOnce(policy, releaseCommit, options) {
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const request = options.request ?? githubJson;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
      !COMMIT.test(releaseCommit ?? "")) {
    throw new Error("GitHub release reconciliation requires exact repository and commit identities.");
  }
  assertPolicy(policy);
  const encodedTag = encodeURIComponent(policy.tag);
  const refRoute = `repos/${repository}/git/ref/tags/${encodedTag}`;
  let ref = request([refRoute], { allowNotFound: true });
  if (ref === undefined) {
    assertWriteAuthority(repository, options.expectedMainCommit, request);
    ref = request([
      "--method", "POST", `repos/${repository}/git/refs`,
      "-f", `ref=refs/tags/${policy.tag}`, "-f", `sha=${releaseCommit}`,
    ]);
  }
  assertTagCommit(repository, ref, releaseCommit, request, policy.tag);

  const releaseRoute = `repos/${repository}/releases/tags/${encodedTag}`;
  let release = request([releaseRoute], { allowNotFound: true });
  if (release === undefined) {
    assertWriteAuthority(repository, options.expectedMainCommit, request);
    release = request([
      "--method", "POST", `repos/${repository}/releases`,
      "-f", `tag_name=${policy.tag}`, "-f", `target_commitish=${releaseCommit}`,
      "-f", `name=${policy.title}`, "-f", `body=${policy.body}`,
      "-F", `prerelease=${policy.prerelease}`, "-F", "draft=false",
    ]);
  }
  assertRelease(release, policy);

  const finalRef = request([refRoute]);
  assertTagCommit(repository, finalRef, releaseCommit, request, `Final ${policy.tag}`);
  const finalRelease = request([releaseRoute]);
  assertRelease(finalRelease, policy);
  return Object.freeze({ ...policy, commit: releaseCommit });
}

function isTransientGithubFailure(error) {
  return /HTTP (?:502|503|504)\b/u.test(error?.message ?? "");
}

export async function reconcileGithubTagRelease(policy, releaseCommit, options = {}) {
  const attempts = options.attempts ?? GITHUB_RECONCILIATION_ATTEMPTS;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ??
    GITHUB_RECONCILIATION_RETRY_MILLISECONDS;
  const wait = options.wait ?? delay;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > GITHUB_RECONCILIATION_ATTEMPTS ||
      !Number.isSafeInteger(retryDelayMilliseconds) || retryDelayMilliseconds < 0 ||
      retryDelayMilliseconds > GITHUB_RECONCILIATION_RETRY_MILLISECONDS) {
    throw new Error("GitHub release reconciliation retry policy exceeds its bounds.");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await reconcileOnce(policy, releaseCommit, options);
    } catch (error) {
      if (!isTransientGithubFailure(error) || attempt + 1 >= attempts) {
        throw error;
      }
      await wait(retryDelayMilliseconds);
    }
  }
}

async function verifyGithubTagReleaseOnce(tag, releaseCommit, options) {
  const repository = options.repository;
  const request = options.request ?? githubJson;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
      !STABLE_RELEASE_TAG.test(tag ?? "") || !COMMIT.test(releaseCommit ?? "")) {
    throw new Error("GitHub release verification requires exact stable tag, repository, and commit identities.");
  }
  const encodedTag = encodeURIComponent(tag);
  const refRoute = `repos/${repository}/git/ref/tags/${encodedTag}`;
  const releaseRoute = `repos/${repository}/releases/tags/${encodedTag}`;
  const ref = request([refRoute], { allowNotFound: true });
  const release = request([releaseRoute], { allowNotFound: true });
  if (ref === undefined || release === undefined) {
    throw new Error(`GitHub tag or release ${tag} remained absent.`);
  }
  assertTagCommit(repository, ref, releaseCommit, request, tag);
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`GitHub release ${tag} is not the exact stable release.`);
  }
  const finalRef = request([refRoute]);
  const finalRelease = request([releaseRoute]);
  assertTagCommit(repository, finalRef, releaseCommit, request, `Final ${tag}`);
  if (finalRelease?.tag_name !== tag || finalRelease.draft !== false || finalRelease.prerelease !== false) {
    throw new Error(`Final GitHub release ${tag} drifted during verification.`);
  }
  return Object.freeze({ commit: releaseCommit, repository, tag });
}

export async function verifyGithubTagRelease(tag, releaseCommit, options = {}) {
  const attempts = options.attempts ?? 5;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? 2_000;
  const wait = options.wait ?? delay;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5 ||
      !Number.isSafeInteger(retryDelayMilliseconds) || retryDelayMilliseconds < 0 ||
      retryDelayMilliseconds > 2_000) {
    throw new Error("GitHub release verification retry policy exceeds its bounds.");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await verifyGithubTagReleaseOnce(tag, releaseCommit, options);
    } catch (error) {
      const absent = /remained absent/u.test(error?.message ?? "");
      const transient = /HTTP 5\d\d\b|ECONNRESET|ETIMEDOUT|timed out/iu.test(
        error?.message ?? "",
      );
      if ((!absent && !transient) || attempt + 1 >= attempts) {
        throw error;
      }
      await wait(retryDelayMilliseconds);
    }
  }
}

async function cli() {
  const [tag, title, body, prerelease, commit] = process.argv.slice(2);
  if (!/^(?:true|false)$/u.test(prerelease ?? "")) {
    throw new Error("GitHub release reconciliation CLI requires an exact prerelease boolean.");
  }
  const result = await reconcileGithubTagRelease(
    { body, prerelease: prerelease === "true", tag, title },
    commit,
    { expectedMainCommit: commit },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await cli();
}
