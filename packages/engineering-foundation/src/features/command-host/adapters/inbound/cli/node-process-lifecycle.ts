import type { CommandCancellation, CommandSignal } from "../../../api.js";

export const nodeCommandCancellation: CommandCancellation = {
  async withSignal<T>(signals: readonly CommandSignal[], operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    for (const signal of signals) { process.once(signal, cancel); }
    try {
      return await operation(controller.signal);
    } finally {
      for (const signal of signals) { process.removeListener(signal, cancel); }
    }
  }
};
