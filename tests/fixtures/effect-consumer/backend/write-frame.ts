import { Effect } from "effect";
import { TransportError } from "../sdk/index.ts";

/** Structural Node writable port also permits a controlled backpressure witness. */
export interface FrameSink {
  readonly destroyed: boolean;
  write(value: string): boolean;
  once(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...arguments_: unknown[]) => void): unknown;
}

export function writeFrame(sink: FrameSink, value: string): Effect.Effect<void, TransportError> {
  return Effect.callback((resume) => {
    let finished = false;
    const cleanup = () => {
      sink.removeListener("drain", drained);
      sink.removeListener("close", closed);
      sink.removeListener("error", failed);
    };
    const complete = (result: Effect.Effect<void, TransportError>) => {
      if (finished) return;
      finished = true;
      cleanup();
      resume(result);
    };
    const drained = () => complete(Effect.void);
    const closed = () => complete(Effect.fail(new TransportError("Response closed while writing")));
    const failed = (cause: unknown) => complete(Effect.fail(new TransportError("Response write failed", { cause })));
    sink.once("drain", drained);
    sink.once("close", closed);
    sink.once("error", failed);
    try {
      if (sink.destroyed) closed();
      else if (sink.write(value)) drained();
    } catch (cause) {
      failed(cause);
    }
    return Effect.sync(cleanup);
  });
}
