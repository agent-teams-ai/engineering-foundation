import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function pathTraversesSymbolicLink(
  root: string,
  candidate: string
): Promise<boolean> {
  const relation = relative(root, candidate);
  let current = root;
  for (const segment of relation.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}
