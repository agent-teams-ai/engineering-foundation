import { isWithin } from '../../feature-model/domain/model.js';

/** Pairs `[earlier, later]` of ownership roots where one contains the other, in declaration order. */
export function findOverlappingRoots(roots: readonly string[]): Array<readonly [string, string]> {
  return roots.flatMap((root, index) => roots.slice(0, index)
    .filter((earlier) => isWithin(root, earlier) || isWithin(earlier, root))
    .map((earlier): readonly [string, string] => [earlier, root]));
}
