import type {
  ManagedProcessExecutor,
  ManagedProcessRequest,
  ManagedProcessResult,
} from "../../packages/engineering-foundation/dist/process-execution/api.js";

export class RecordingManagedProcessExecutor implements ManagedProcessExecutor {
  readonly requests: ManagedProcessRequest[] = [];
  readonly result: ManagedProcessResult;

  constructor(
    result: ManagedProcessResult = {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    },
  ) {
    this.result = result;
  }

  async run(request: ManagedProcessRequest): Promise<ManagedProcessResult> {
    this.requests.push(request);
    return this.result;
  }
}
