/**
 * Compares raw UTF-16 code units in binary order.
 *
 * Inputs are deliberately not normalized. Canonically equivalent Unicode
 * spellings therefore remain distinct identifiers instead of colliding.
 */
export function compareBinaryStrings(left: string, right: string): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

export function compareBinaryStringSequences(
  left: readonly string[],
  right: readonly string[]
): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = compareBinaryStrings(left[index] ?? "", right[index] ?? "");
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}
