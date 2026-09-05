export type ProtobufSchemaId =
  | "contract-protobuf-evolution/v1"
  | "contract-protobuf-evolution-baseline/v1"
  | "contract-protobuf-breaking-qualification/v1";

export type ProtobufSchemaAssertion = (schemaId: ProtobufSchemaId, input: unknown, phase: string) => Promise<void>;
