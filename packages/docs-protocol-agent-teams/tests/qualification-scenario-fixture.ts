export function qualificationScenarios() {
  return ["adr", "note"].map((type) => ({
    id: type,
    type,
    intent: { id: type, title: type, owner: "fixture", summary: "fixture" },
    expected: {
      documentPath: `docs/${type}.md`,
      reachability: { state: "not-required" },
      goldenFile: `${type}.golden`,
      goldenDigest: `sha256:${type}`,
      metadataStorage: "frontmatter",
    },
  }));
}
