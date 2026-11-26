import { Effect, Schema } from "effect";
import { type Frame, ProtocolError, maxFrameBytes } from "./contract.ts";

const identity = Schema.Literals(["left", "right"]);
const frame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), sessionId: identity }),
  Schema.Struct({
    kind: Schema.Literal("progress"),
    sessionId: identity,
    revision: Schema.Natural,
    completed: Schema.Natural,
  }),
]);

export function decodeFrame(value: unknown): Effect.Effect<Frame, ProtocolError> {
  return Schema.decodeUnknownEffect(frame, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((cause) => new ProtocolError("Invalid progress frame", { cause })),
  );
}

/** Retains at most one bounded incomplete frame; input chunks are never retained. */
export function frameDecoder() {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    push(chunk: Uint8Array): readonly unknown[] {
      const values: unknown[] = [];
      let offset = 0;
      for (let index = 0; index <= chunk.length; index += 1) {
        if (index !== chunk.length && chunk[index] !== 10) continue;
        const length = pending.length + index - offset;
        if (length > maxFrameBytes) throw new ProtocolError("Frame exceeds byte limit");
        const bytes = new Uint8Array(length);
        bytes.set(pending);
        bytes.set(chunk.subarray(offset, index), pending.length);
        if (index === chunk.length) {
          pending = bytes;
        } else {
          try {
            const value: unknown = JSON.parse(decoder.decode(bytes));
            values.push(value);
          } catch (cause) {
            throw new ProtocolError("Malformed frame", { cause });
          }
          pending = new Uint8Array(0);
        }
        offset = index + 1;
      }
      return values;
    },
    finish(): void {
      if (pending.length !== 0) throw new ProtocolError("Truncated frame");
    },
  };
}
