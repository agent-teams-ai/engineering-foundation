import { declareModule, defineContract, type CapabilitiesOf } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { effectFor, implement } from "@get-modular/effect";
import { Context, Effect, PubSub, Semaphore, Stream, type Scope } from "effect";
import type { Progress, SessionId } from "../sdk/index.ts";

interface Session {
  readonly advance: Effect.Effect<Progress, Error>;
  readonly subscribe: Effect.Effect<Stream.Stream<Progress>, never, Scope.Scope>;
}

interface Sessions {
  readonly left: Session;
  readonly right: Session;
}

const SessionsPort = defineContract<Sessions>()({ id: "consumer/sessions", revision: 1 });
interface Ports extends CapabilitiesOf<typeof SessionsPort> {}
export class SessionRoots extends Context.Service<SessionRoots, { readonly api: Sessions }>()(
  "consumer/SessionRoots",
) {}

function session(id: SessionId): Effect.Effect<Session, never, Scope.Scope> {
  return Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      PubSub.sliding<Progress>({ capacity: 1, replay: 1 }),
      PubSub.shutdown,
    );
    const lock = yield* Semaphore.make(1);
    let current: Progress = { sessionId: id, revision: 0, completed: 0 };
    yield* PubSub.publish(hub, current);
    return {
      advance: lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const next = { ...current, revision: current.revision + 1, completed: current.completed + 1 };
            if (!(yield* PubSub.publish(hub, next))) {
              return yield* Effect.fail(new Error("Session source is closed"));
            }
            current = next;
            return next;
          }),
        ),
      ),
      subscribe: Effect.map(PubSub.subscribe(hub), (subscription) =>
        Stream.fromEffectRepeat(PubSub.take(subscription)),
      ),
    };
  });
}

export async function prepareSessions(observe: (kind: "application-acquired" | "application-released") => void, failStartup: boolean) {
  const owner = { authority: "consumer", path: ["progress"] };
  const source = implement<Ports>()(
    declareModule({ moduleId: "consumer/source", implementationId: "consumer/source", owner, provides: [SessionsPort.provide()], slots: [] }),
    () => Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => observe("application-acquired")),
        () => Effect.sync(() => observe("application-released")),
      );
      const value: Sessions = { left: yield* session("left"), right: yield* session("right") };
      if (failStartup) return yield* Effect.fail(new Error("Intentional startup rejection"));
      return { instance: value, capabilities: { [SessionsPort.id]: value } };
    }),
  );
  const api = implement<Ports>()(
    declareModule({ moduleId: "consumer/api", implementationId: "consumer/api", owner, provides: [], slots: [SessionsPort.slot("sessions", required())] }),
    (dependencies) => Effect.succeed({ instance: dependencies.sessions, capabilities: {} }),
  );
  const result = await effectFor<Ports>().prepare({ profileId: "consumer/backend", modules: [source, api], roots: { api } });
  if (result.status !== "prepared") throw new Error("Backend composition rejected", { cause: result });
  return result.prepared;
}
