import assert from "node:assert/strict";
import test from "node:test";
import {
  admitAuthoritySelection,
  assertCurrentAuthority,
  parseAuthorityRevision,
} from "../tools/ef70-managed-campaign/authority-selection.ts";

// Independent response data; these tests perform no GitHub or managed operation.
const revision = "b208d41f81029a39a7100ac04d3309d989b95c42";
const tree = "670e391ce66e343b99d005922a38797e0f2a48b1";
const otherRevision = "8636f328f4ac7b1b6eeb764d1414391849fdc783";

function branch() {
  return { name: "main", protected: true, commit: { sha: revision } };
}

function commit() {
  return { sha: revision, tree: { sha: tree } };
}

test("EF70 admits the explicit current protected Central commit and its immutable tree", () => {
  assert.equal(parseAuthorityRevision(revision), revision);
  const selection = admitAuthoritySelection(revision, branch(), commit());
  assert.deepEqual(selection, {
    revision: "b208d41f81029a39a7100ac04d3309d989b95c42",
    tree: "670e391ce66e343b99d005922a38797e0f2a48b1",
  });
  assert.equal(Object.isFrozen(selection), true);
});

test("EF70 authority input has no default, branch alias, abbreviated or malformed SHA", () => {
  for (const value of [
    undefined,
    null,
    "",
    "main",
    "refs/heads/main",
    "latest",
    "b208d41",
    "0".repeat(40),
    revision.toUpperCase(),
    " " + revision,
    revision + "\n",
    revision + "\0",
    42,
    { revision },
  ]) {
    assert.throws(() => parseAuthorityRevision(value), /explicit immutable/u);
  }
});

test("EF70 refuses a moved protected main instead of selecting its newer commit", () => {
  const current = branch();
  current.commit.sha = otherRevision;
  assert.throws(() => admitAuthoritySelection(revision, current, commit()), /no longer current/u);
});

test("EF70 refuses an unprotected branch and a response for another branch", () => {
  assert.throws(
    () => admitAuthoritySelection(revision, { ...branch(), protected: false }, commit()),
    /must remain protected/u,
  );
  assert.throws(
    () => admitAuthoritySelection(revision, { ...branch(), name: "candidate" }, commit()),
    /fixed Central main/u,
  );
});

test("EF70 refuses a different immutable commit even when its tree matches", () => {
  assert.throws(
    () => admitAuthoritySelection(revision, branch(), { sha: otherRevision, tree: { sha: tree } }),
    /must match the selection/u,
  );
});

test("EF70 requires an immutable Git tree identity from the selected commit", () => {
  for (const value of [
    undefined,
    null,
    {},
    { sha: "" },
    { sha: "0".repeat(40) },
    { sha: "main" },
  ]) {
    assert.throws(() =>
      admitAuthoritySelection(revision, branch(), { sha: revision, tree: value }),
    );
  }
});

test("EF70 refuses malformed authority observations without a fallback", () => {
  for (const value of [undefined, null, [], "main", {}, { protected: true, commit: null }]) {
    assert.throws(() => admitAuthoritySelection(revision, value, commit()));
    assert.throws(() => admitAuthoritySelection(revision, branch(), value));
  }
});

test("EF70 retains its original selection when a later current-main observation moves", () => {
  const initialBranch = branch();
  const initialCommit = commit();
  const selection = admitAuthoritySelection(revision, initialBranch, initialCommit);
  initialBranch.commit.sha = otherRevision;
  initialCommit.tree.sha = "7b932bebee5dc817e5bc643459972d0fff9c6747";
  assert.throws(
    () => assertCurrentAuthority(selection.revision, initialBranch),
    /no longer current/u,
  );
  assert.deepEqual(selection, { revision, tree });
  assertCurrentAuthority(selection.revision, branch());
});
