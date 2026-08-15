function canonicalMarkdown(value) {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function searchableMarkdown(value) {
  return canonicalMarkdown(value).replaceAll(/\s+/gu, " ");
}

export function releaseSections(body) {
  const normalized = body.replaceAll("\r\n", "\n");
  const releases = [...normalized.matchAll(/^# Releases\s*$/gmu)].at(-1);
  if (releases === undefined) {
    throw new Error("pull request body does not contain a # Releases section");
  }
  const value = normalized.slice(releases.index);
  const matches = [
    ...value.matchAll(/^## (@agent-teams\/[A-Za-z0-9._-]+)@([^\s]+)\s*$/gmu),
  ];
  if (matches.length === 0) {
    throw new Error("pull request release body does not contain package releases");
  }
  if (new Set(matches.map((match) => match[1])).size !== matches.length) {
    throw new Error("pull request release body contains a duplicate package release");
  }
  return new Map(
    matches.map((match, index) => [
      match[1],
      value.slice(match.index, matches[index + 1]?.index ?? value.length).trim(),
    ]),
  );
}

export function missingSummaryViolations(packageName, generatedRelease, changesets) {
  let unmatchedRelease = searchableMarkdown(generatedRelease);
  const violations = [];
  for (const changeset of changesets.toSorted(
    (left, right) => right.summary.length - left.summary.length,
  )) {
    const summary = searchableMarkdown(changeset.summary);
    const index = unmatchedRelease.indexOf(summary);
    if (index === -1) {
      violations.push(
        `${packageName} changelog is missing the summary from ${changeset.path}`,
      );
      continue;
    }
    unmatchedRelease =
      unmatchedRelease.slice(0, index) +
      " ".repeat(summary.length) +
      unmatchedRelease.slice(index + summary.length);
  }
  return violations;
}
