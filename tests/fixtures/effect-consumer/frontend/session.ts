import { declareModule, defineContract, type CapabilitiesOf } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { effectFor, implement } from "@get-modular/effect";
import { Context, Effect, Stream } from "effect";
import { ProtocolError, type Progress, type SessionId } from "../sdk/index.ts";
import { httpProgressClient, type ProgressClient } from "./client.ts";

interface ProgressView {
  readonly watch: (session: SessionId, display: (value: Progress) => void) => Effect.Effect<void, Error>;
  readonly advance: ProgressClient["advance"];
}
const HttpPort = defineContract<ProgressClient>()({ id: "consumer/http", revision: 1 });
interface Ports extends CapabilitiesOf<typeof HttpPort> {}
export class BrowserRoots extends Context.Service<BrowserRoots, { readonly view: ProgressView }>()("consumer/BrowserRoots") {}

function view(client: ProgressClient): ProgressView {
  return {
    advance: client.advance,
    watch: (session, display) => Effect.suspend(() => {
      let ready = false;
      let previous: Progress | undefined;
      return Stream.runForEach(client.events(session), (frame) => Effect.try({
        try: () => {
          if (frame.sessionId !== session) throw new ProtocolError("Wrong session in stream");
          if (frame.kind === "ready") {
            if (ready) throw new ProtocolError("Duplicate ready");
            ready = true;
            return;
          }
          if (!ready) throw new ProtocolError("State arrived before subscription readiness");
          if (previous !== undefined && (frame.revision < previous.revision || (frame.revision === previous.revision && frame.completed !== previous.completed))) {
            throw new ProtocolError("Inconsistent state revision");
          }
          previous = frame;
          display(frame);
        },
        catch: (cause) => cause instanceof ProtocolError ? cause : new ProtocolError("Display failed", { cause }),
      }));
    }),
  };
}

export async function prepareBrowser() {
  const owner = { authority: "consumer", path: ["browser"] };
  const http = implement<Ports>()(
    declareModule({ moduleId: "consumer/http", implementationId: "consumer/http", owner, provides: [HttpPort.provide()], slots: [] }),
    () => Effect.sync(() => {
      const client = httpProgressClient();
      return { instance: client, capabilities: { [HttpPort.id]: client } };
    }),
  );
  const model = implement<Ports>()(
    declareModule({ moduleId: "consumer/view", implementationId: "consumer/view", owner, provides: [], slots: [HttpPort.slot("http", required())] }),
    (dependencies) => Effect.succeed({ instance: view(dependencies.http), capabilities: {} }),
  );
  const result = await effectFor<Ports>().prepare({ profileId: "consumer/browser", modules: [http, model], roots: { view: model } });
  if (result.status !== "prepared") throw new Error("Browser composition rejected", { cause: result });
  return result.prepared;
}
