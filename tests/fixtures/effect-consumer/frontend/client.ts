import { Effect, Stream } from "effect";
import { decodeFrame, frameDecoder, ProtocolError, TransportError, type Frame, type SessionId } from "../sdk/index.ts";

export interface ProgressClient {
  readonly events: (session: SessionId) => Stream.Stream<Frame, ProtocolError | TransportError>;
  readonly advance: (session: SessionId) => Effect.Effect<void, TransportError>;
}

export function httpProgressClient(): ProgressClient {
  return {
    events: (session) => Stream.unwrap(Effect.gen(function* () {
      // Scope owns cancellation before dispatch, including the headers/reader gap.
      const lifetime = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise({
        try: (pending) => fetch("/api/sessions/" + session + "/events", { signal: AbortSignal.any([lifetime, pending]) }),
        catch: (cause) => new TransportError("Stream request failed", { cause }),
      });
      if (!response.ok || response.headers.get("content-type") !== "application/x-ndjson" || response.body === null) {
        return yield* Effect.fail(new ProtocolError("Expected an NDJSON response body"));
      }
      const decoder = frameDecoder();
      const body = response.body;
      const frames = Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => new TransportError("Response body failed", { cause }) }).pipe(
        Stream.mapEffect((chunk) => Effect.try({ try: () => decoder.push(chunk), catch: (cause) => new ProtocolError("Invalid frame bytes", { cause }) })),
        Stream.flatMap((values) => Stream.fromIterable(values)),
        Stream.mapEffect(decodeFrame),
      );
      return Stream.concat(frames, Stream.drain(Stream.fromEffect(Effect.try({
        try: () => decoder.finish(),
        catch: (cause) => new ProtocolError("Incomplete response", { cause }),
      }))));
    })),
    advance: (session) => Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch("/api/sessions/" + session + "/advance", { method: "POST", signal });
        await response.arrayBuffer();
        if (!response.ok) throw new Error("Advance failed: " + response.status);
      },
      catch: (cause) => new TransportError("Advance request failed", { cause }),
    }),
  };
}
