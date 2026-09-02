import { isAbsolute, relative, sep } from "node:path";

export function isLexicallyContainedPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}
