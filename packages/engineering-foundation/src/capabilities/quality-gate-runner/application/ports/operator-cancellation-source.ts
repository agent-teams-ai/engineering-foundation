export type QualityGateOperatorCancellation = "interrupt" | "terminate";

export interface QualityGateOperatorCancellationSource {
  subscribe(
    onCancellation: (cancellation: QualityGateOperatorCancellation) => void
  ): () => void;
}
