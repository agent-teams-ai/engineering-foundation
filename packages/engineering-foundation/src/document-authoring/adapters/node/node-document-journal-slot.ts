import { readBoundedRegularFile } from "@agent-teams/repository-mutation";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function documentJournalSlotExists(
  path: string,
  maximumBytes: number
): Promise<boolean> {
  try {
    await readBoundedRegularFile(path, maximumBytes);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}
