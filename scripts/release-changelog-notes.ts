export function releaseNotes(changelog: string, version: string): string {
  const source = changelog.replaceAll("\r\n", "\n");
  const lines = source.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) {
    throw new Error(`Changelog has no exact ${version} release entry.`);
  }
  const contentLines = lines.slice(start + 1);
  const next = contentLines.findIndex((line) => line.startsWith("## "));
  const content = contentLines
    .slice(0, next < 0 ? undefined : next)
    .join("\n")
    .trim();
  if (content.length === 0) {
    throw new Error(`Changelog entry for ${version} is empty.`);
  }
  return content;
}
