import { isAbsolute, relative, sep } from "node:path";

export function isSameCanonicalPath(left, right) {
  return relative(left, right) === "";
}

export function isCanonicalPathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== "" && relation !== ".." &&
    !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
