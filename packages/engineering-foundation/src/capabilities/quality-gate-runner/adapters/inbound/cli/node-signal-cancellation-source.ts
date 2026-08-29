import type {
  QualityGateCancellationSource,
  QualityGateOperatorCancellation
} from "./quality-gate-cli.js";

export class NodeSignalQualityGateCancellationSource
implements QualityGateCancellationSource {
  subscribe(
    onCancellation: (cancellation: QualityGateOperatorCancellation) => void
  ): () => void {
    const onInterrupt = () => { onCancellation("interrupt"); };
    const onTerminate = () => { onCancellation("terminate"); };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    return () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    };
  }
}
