// Private clean-stage I/O only. Package target and A/B build ownership stay unchanged.
export const STAGE_IO_CONCURRENCY = 4;

export async function mapStageIo<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => R | Promise<R>,
  concurrency: number = STAGE_IO_CONCURRENCY,
): Promise<R[]> {
  if (
    !Array.isArray(items) ||
    typeof run !== "function" ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > STAGE_IO_CONCURRENCY
  ) {
    throw new Error("Stage I/O concurrency must be an integer between 1 and 4.");
  }

  const iterator = items.entries();
  const results: R[] = [];
  let failed = false;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const next = iterator.next();
      if (next.done) { return; }

      const [index, item] = next.value;
      try {
        results[index] = await run(item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };

  const settled = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );

  for (const result of settled) {
    if (result.status === "rejected" && !failed) {
      failed = true;
      failure = result.reason;
    }
  }

  if (failed) { throw failure; }
  return results;
}

export const MAX_STAGE_BYTES = 256 * 1024 * 1024;

export interface StageByteState {
  bytes: number;
  reservedBytes?: number;
}

export interface StageByteReservation {
  commit(): void;
  release(): void;
}

export function reserveStageBytes(
  state: StageByteState,
  size: number,
  label: string,
): StageByteReservation {
  const reserved = state.reservedBytes ?? 0;

  if (
    !Number.isSafeInteger(state.bytes) ||
    !Number.isSafeInteger(reserved) ||
    !Number.isSafeInteger(size) ||
    state.bytes < 0 ||
    reserved < 0 ||
    size < 0 ||
    state.bytes + reserved + size > MAX_STAGE_BYTES
  ) {
    throw new Error(`${label} exceeds its bounded byte limit.`);
  }

  state.reservedBytes = reserved + size;
  let active = true;

  return {
    commit(): void {
      if (!active) {
        throw new Error("Stage byte reservation is already settled.");
      }
      active = false;
      state.reservedBytes = (state.reservedBytes ?? 0) - size;
      state.bytes += size;
    },

    release(): void {
      if (!active) { return; }
      active = false;
      state.reservedBytes = (state.reservedBytes ?? 0) - size;
    },
  };
}
