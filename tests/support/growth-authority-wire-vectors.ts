const d = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
export function emptyCandidate(decisions: readonly unknown[] = []) {
  return {
    trustedBase: { status: "unavailable", reasons: ["candidate"] },
    trustedBaseReference: { status: "unavailable", reasons: ["candidate"] },
    retainedHistory: { status: "unavailable", reasons: ["candidate"] },
    released: [],
    decisions,
    acceptedBreakingDecisions: {
      acceptedDecisionIds: [],
      acceptedDecisionPaths: [],
      growthDecisionAuthority: { status: "unavailable", reasons: ["candidate"] },
    },
    authority: { status: "unverified", reasons: ["candidate"] },
  };
}

export function validGrowthDecision() {
  return {
    contractRevision: "foundation:sdk-growth:c0:5",
    decisionId: "ADR-1",
    ownerRef: "owner/team",
    stability: "supported",
    transitions: [d("1")],
    coordinates: [
      {
        packageName: "fixture",
        exportPath: ".",
        resolutionBranch: [],
        subject: { kind: "package" },
      },
    ],
    changeFingerprint: d("2"),
    consumerEvidenceRefs: [
      {
        useCase: "test",
        repository: "repo",
        source: { tree: "1".repeat(40), contentDigest: d("3"), commit: null },
        artifactDigest: null,
      },
    ],
    exposureRationale: "exposed",
    compatibilityRationale: "compatible",
    lifecycle: { kind: "ordinary" },
  };
}
export function invalidCustodyPaths() {
  return ["a/../b", "a//b", "a\\b", "/a", "a%2fb", "C:a", "a.", "a ", "CON", "e\u0301", "a\u0000b"];
}
export function ambiguousArchiveFiles() {
  return [
    [
      { path: "a", contentHex: "" },
      { path: "a", contentHex: "" },
    ],
    [
      { path: "A", contentHex: "" },
      { path: "a", contentHex: "" },
    ],
    [
      { path: "a", contentHex: "" },
      { path: "a/b", contentHex: "" },
    ],
    [
      { path: "Foo/bar", contentHex: "" },
      { path: "foo", contentHex: "" },
    ],
    [
      { path: "foo", contentHex: "" },
      { path: "Foo/bar", contentHex: "" },
    ],
    [
      { path: "foo/BAR/baz", contentHex: "" },
      { path: "FOO/bar", contentHex: "" },
    ],
    [
      { path: "Foo\\bar", contentHex: "" },
      { path: "foo", contentHex: "" },
    ],
  ];
}
export function invalidArchiveManifests() {
  return [
    {},
    { "unrelated.txt": "unrelated" },
    { "PACKAGE.JSON": '{"name":"fixture","version":"0.0.0"}' },
    { "package.json": "null" },
    { "package.json": "{" },
    { "package.json": Buffer.from([255]) },
    { "package.json": JSON.stringify({ name: "unrelated", version: "0.0.0" }) },
    { "package.json": JSON.stringify({ name: "fixture", version: "9.9.9" }) },
  ];
}

export const makeLocal = () => ({
  ...emptyCandidate(),
  released: [
    {
      packageName: "fixture",
      policy: { packageName: "fixture" },
      releaseEvidence: {
        status: "available",
        value: { packageName: "fixture", packageVersion: "1.0.0", declaredBump: "minor" },
      },
      evidence: {
        kind: "released",
        typed: { status: "unavailable", reasons: ["candidate"] },
        artifact: { status: "unavailable", reasons: ["candidate"] },
      },
    },
  ],
});
