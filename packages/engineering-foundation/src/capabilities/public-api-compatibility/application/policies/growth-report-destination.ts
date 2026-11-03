import { configurationInputError } from "../configuration-input.js";

/** A report must not replace an input or an ancestor owning an input. */
export function assertGrowthReportDestination(
  destination: string,
  protectedPaths: readonly string[],
): void {
  if (
    protectedPaths.some(
      (path) =>
        destination === path ||
        destination.startsWith(`${path}/`) ||
        path.startsWith(`${destination}/`),
    )
  ) {
    configurationInputError(
      "SDK report path overlaps a protected input, governance, baseline, lockfile or package path.",
    );
  }
}
