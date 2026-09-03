/** Compare raw UTF-16 code units without Unicode normalization. */
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
