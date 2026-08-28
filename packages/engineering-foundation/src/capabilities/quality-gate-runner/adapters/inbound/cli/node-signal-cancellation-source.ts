import type {
  QualityGateOperatorCancellation,
  QualityGateOperatorCancellationSource
} from "../../../application/ports/operator-cancellation-source.js";

export class NodeSignalQualityGateCancellationSource
implements QualityGateOperatorCancellationSource {
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
