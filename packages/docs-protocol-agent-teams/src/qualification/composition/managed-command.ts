import { createQualificationCli } from "../adapters/inbound/qualification-cli.js";
import { runDocsProtocolQualificationV2 } from "./qualification.js";
import { readManagedQualificationProfileInput } from
  "../../consumer-integration/composition/qualification-v3-boundary.js";

export const managedQualificationCommand = createQualificationCli({
  readProfile: readManagedQualificationProfileInput,
  qualify: runDocsProtocolQualificationV2
});
