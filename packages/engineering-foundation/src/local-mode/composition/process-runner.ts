import { NodeProcessRunner } from "../../process-execution/node-process-runner.js";
import type { ProcessRequest, ProcessRunner } from "../../process-execution/types.js";

export { NodeProcessRunner };

interface EnvironmentBoundProcessRequest extends ProcessRequest {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export function createNodeProcessRunner(
  environment: Readonly<NodeJS.ProcessEnv>
): ProcessRunner {
  const runner = new NodeProcessRunner();
  const snapshot = Object.freeze({ ...environment });
  return {
    run: (request) =>
      runner.run({ ...request, environment: snapshot } as EnvironmentBoundProcessRequest)
  };
}
