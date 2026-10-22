import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileGithubTagRelease,
  reconcileGithubTagReleaseCli,
  verifyGithubTagRelease,
} from "../scripts/github-release-reconciliation.mjs";

const repository = "example/releases";
const releaseCommit = "a".repeat(40);
const operatingMain = "b".repeat(40);
const advancedMain = "c".repeat(40);

interface Policy {
  tag: string;
  title: string;
  body: string;
  prerelease: boolean;
}
interface GitRef {
  ref: string;
  object: { type: "commit"; sha: string };
}
interface Release {
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
}

function githubFixture(policy: Policy, mainCommit = releaseCommit) {
  const calls: string[][] = [];
  const state: {
    ref: GitRef | undefined;
    release: Release | undefined;
    mainCommit: string;
    mainAfterTag: string | undefined;
  } = { ref: undefined, release: undefined, mainCommit, mainAfterTag: undefined };
  const root = `repos/${repository}`;
  const refRoute = `${root}/git/ref/tags/${encodeURIComponent(policy.tag)}`;
  const releaseRoute = `${root}/releases/tags/${encodeURIComponent(policy.tag)}`;
  function request(args: string[], options?: { allowNotFound?: boolean }) {
    calls.push([...args]);
    if (args[0] === `${root}/git/ref/heads/main`) {
      return { ref: "refs/heads/main", object: { type: "commit", sha: state.mainCommit } };
    }
    if (args[0] === refRoute || args[0] === releaseRoute) {
      const value = args[0] === refRoute ? state.ref : state.release;
      if (value === undefined) {
        assert.equal(options?.allowNotFound, true);
      }
      return value;
    }
    assert.equal(args[0], "--method");
    assert.equal(args[1], "POST");
    const fields: Partial<Record<string, string>> = {};
    for (let index = 3; index < args.length; index += 2) {
      assert.ok(args[index] === "-f" || args[index] === "-F");
      const pair = args.at(index + 1);
      assert.ok(pair !== undefined);
      const equals = pair.indexOf("=");
      assert.ok(equals > 0);
      fields[pair.slice(0, equals)] = pair.slice(equals + 1);
    }
    const field = (name: string) => {
      const value = fields[name];
      assert.ok(value !== undefined);
      return value;
    };
    if (args[2] === `${root}/git/refs`) {
      state.ref = { ref: field("ref"), object: { type: "commit", sha: field("sha") } };
      if (state.mainAfterTag !== undefined) {
        state.mainCommit = state.mainAfterTag;
      }
      return state.ref;
    }
    assert.equal(args[2], `${root}/releases`);
    state.release = {
      tag_name: field("tag_name"),
      target_commitish: field("target_commitish"),
      name: field("name"),
      body: field("body"),
      prerelease: field("prerelease") === "true",
      draft: field("draft") === "true",
    };
    return state.release;
  }
  return { calls, state, options: { repository, request, attempts: 1 } };
}

function releasePolicy(tag: string, prerelease = false): Policy {
  return { tag, title: tag, body: "Reviewed changelog evidence.", prerelease };
}

for (const value of [
  releasePolicy("stack-toolchain@0.0.0", true),
  releasePolicy("stack-toolchain@0.1.0"),
  releasePolicy("@agent-teams/engineering-foundation@2.1.1"),
  releasePolicy("@agent-teams/docs-protocol@0.0.0-bootstrap.1", true),
]) {
  void test(`creates and reuses exact GitHub tag/release ${value.tag}`, async () => {
    const api = githubFixture(value);
    const result: unknown = await reconcileGithubTagRelease(value, releaseCommit, {
      ...api.options,
      expectedMainCommit: releaseCommit,
    });
    assert.deepEqual(result, { ...value, commit: releaseCommit });
    assert.deepEqual(api.state.ref, {
      ref: `refs/tags/${value.tag}`,
      object: { type: "commit", sha: releaseCommit },
    });
    assert.deepEqual(api.state.release, {
      tag_name: value.tag,
      target_commitish: releaseCommit,
      name: value.title,
      body: value.body,
      prerelease: value.prerelease,
      draft: false,
    });
    const reused: unknown = await reconcileGithubTagRelease(value, releaseCommit, api.options);
    assert.deepEqual(reused, result);
    assert.equal(api.calls.filter((args) => args[0] === "--method").length, 2);
    if (value.prerelease) {
      await assert.rejects(
        verifyGithubTagRelease(value.tag, releaseCommit, api.options),
        /exact stable (?:tag|release)/u,
      );
    } else {
      assert.deepEqual(await verifyGithubTagRelease(value.tag, releaseCommit, api.options), {
        commit: releaseCommit,
        repository,
        tag: value.tag,
      });
    }
    assert.equal(api.calls.filter((args) => args[0] === "--method").length, 2);
  });
}

for (const tag of [
  "",
  " stack-toolchain@0.0.0",
  "stack-toolchain@0.1.0 ",
  "stack-toolchain@0.1.0\n",
  "Stack-Toolchain@0.1.0",
  ".package@0.1.0",
  "_package@0.1.0",
  "package/path@0.1.0",
  "@scope/name/path@0.1.0",
  "@scope/@0.1.0",
  "@@scope/name@0.1.0",
  "name@@0.1.0",
  "name@01.0.0",
  "name@0.01.0",
  "name@0.1",
  "name@v0.1.0",
  "name@0.1.0+build",
  "name@0.1.0-",
  "name@0.1.0/other",
]) {
  void test(`rejects malformed release tag ${JSON.stringify(tag)} before requests`, async () => {
    const api = githubFixture(releasePolicy(tag));
    await assert.rejects(
      reconcileGithubTagRelease(releasePolicy(tag), releaseCommit, api.options),
      /exact bounded data policy/u,
    );
    await assert.rejects(
      verifyGithubTagRelease(tag, releaseCommit, api.options),
      /exact stable tag/u,
    );
    assert.deepEqual(api.calls, []);
  });
}

void test("CLI retains five-argument release/current-main binding", async () => {
  const value = releasePolicy("@agent-teams/engineering-foundation@2.1.1");
  const api = githubFixture(value);
  const result: unknown = await reconcileGithubTagReleaseCli(
    [value.tag, value.title, value.body, "false", releaseCommit],
    api.options,
  );
  assert.deepEqual(result, { ...value, commit: releaseCommit });
  assert.equal(api.calls.filter((args) => args[0]?.endsWith("/heads/main")).length, 2);
  assert.equal(api.state.ref?.object.sha, releaseCommit);
});

void test("CLI binds recovery tags to original source and writes to current operating main", async () => {
  const value = releasePolicy("stack-toolchain@0.0.0", true);
  const api = githubFixture(value, operatingMain);
  const result: unknown = await reconcileGithubTagReleaseCli(
    [value.tag, value.title, value.body, "true", releaseCommit, operatingMain],
    api.options,
  );
  assert.deepEqual(result, { ...value, commit: releaseCommit });
  assert.equal(api.state.ref?.object.sha, releaseCommit);
  const release = api.state.release;
  assert.ok(release !== undefined);
  assert.equal(release.target_commitish, releaseCommit);
  assert.equal(release.prerelease, true);
  assert.equal(api.calls.filter((args) => args[0]?.endsWith("/heads/main")).length, 2);
  const writes = api.calls.filter((args) => args[0] === "--method");
  assert.equal(writes.length, 2);
  assert.ok(writes[0]?.includes(`sha=${releaseCommit}`));
  assert.ok(writes[1]?.includes(`target_commitish=${releaseCommit}`));
});

void test("CLI refuses advanced operating main before any write", async () => {
  const value = releasePolicy("stack-toolchain@0.0.0", true);
  const api = githubFixture(value, advancedMain);
  await assert.rejects(
    reconcileGithubTagReleaseCli(
      [value.tag, value.title, value.body, "true", releaseCommit, operatingMain],
      api.options,
    ),
    /protected main advanced/u,
  );
  assert.equal(
    api.calls.some((args) => args[0] === "--method"),
    false,
  );
});

void test("CLI rechecks operating main between tag and release creation", async () => {
  const value = releasePolicy("stack-toolchain@0.0.0", true);
  const api = githubFixture(value, operatingMain);
  api.state.mainAfterTag = advancedMain;
  await assert.rejects(
    reconcileGithubTagReleaseCli(
      [value.tag, value.title, value.body, "true", releaseCommit, operatingMain],
      api.options,
    ),
    /protected main advanced/u,
  );
  assert.equal(api.state.ref?.object.sha, releaseCommit);
  assert.equal(api.state.release, undefined);
  assert.equal(api.calls.filter((args) => args[0] === "--method").length, 1);
});

void test("reuse refuses a tag bound to operating main rather than original source", async () => {
  const value = releasePolicy("stack-toolchain@0.0.0", true);
  const api = githubFixture(value, operatingMain);
  api.state.ref = { ref: `refs/tags/${value.tag}`, object: { type: "commit", sha: operatingMain } };
  await assert.rejects(
    reconcileGithubTagReleaseCli(
      [value.tag, value.title, value.body, "true", releaseCommit, operatingMain],
      api.options,
    ),
    /not bound to the trusted release commit/u,
  );
  assert.equal(
    api.calls.some((args) => args[0] === "--method"),
    false,
  );
});

for (const invalid of ["", "a".repeat(39), "g".repeat(40), "A".repeat(40), `${releaseCommit} `]) {
  void test(`CLI rejects either malformed commit ${JSON.stringify(invalid)} before requests`, async () => {
    const value = releasePolicy("stack-toolchain@0.0.0", true);
    const api = githubFixture(value);
    for (const [source, main] of [
      [invalid, operatingMain],
      [releaseCommit, invalid],
    ]) {
      await assert.rejects(
        reconcileGithubTagReleaseCli(
          [value.tag, value.title, value.body, "true", source, main],
          api.options,
        ),
        /exact release and protected-main commit identities/u,
      );
    }
    assert.deepEqual(api.calls, []);
  });
}

void test("CLI rejects extra arguments and nonexact prerelease booleans", async () => {
  const value = releasePolicy("stack-toolchain@0.1.0");
  const api = githubFixture(value);
  for (const args of [
    [value.tag, value.title, value.body, "false"],
    [value.tag, value.title, value.body, "false", releaseCommit, operatingMain, "extra"],
    [value.tag, value.title, value.body, "false ", releaseCommit],
  ]) {
    await assert.rejects(reconcileGithubTagReleaseCli(args, api.options), /CLI requires/u);
  }
  assert.deepEqual(api.calls, []);
});
