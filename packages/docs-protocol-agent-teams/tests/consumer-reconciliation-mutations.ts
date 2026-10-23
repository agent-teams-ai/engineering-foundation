interface MutableProvenance extends Record<string, unknown> {
  source_repository_id: number;
  workflow_run_url: string;
  registry_attestation_url: string;
  reconciliation: unknown;
}
type ProvenanceMutation = [description: string, mutate: (value: MutableProvenance) => void];
export function reconciliationMutations(provenance: Record<string, unknown>): ProvenanceMutation[] {
  return [
    [
      "unknown outer key",
      (value) => {
        value.unexpected = true;
      },
    ],
    ...Object.keys(provenance)
      .filter((key) => key !== "reconciliation")
      .map((key): ProvenanceMutation => [
        `missing ${key}`,
        (value) => {
          delete value[key];
        },
      ]),
    [
      "source repository",
      (value) => {
        value.source_repository = "agent-teams-ai/other";
      },
    ],
    [
      "repository ID",
      (value) => {
        value.source_repository_id++;
      },
    ],
    [
      "signature",
      (value) => {
        value.signature_verified = false;
      },
    ],
    [
      "source commit",
      (value) => {
        value.source_commit = "0".repeat(40);
      },
    ],
    [
      "source workflow",
      (value) => {
        value.source_workflow = "../release.yml";
      },
    ],
    [
      "run URL",
      (value) => {
        value.workflow_run_url += "1";
      },
    ],
    [
      "attestation URL",
      (value) => {
        value.registry_attestation_url += "1";
      },
    ],
    [
      "original attempt",
      (value) => {
        value.workflow_run_attempt = 0;
      },
    ],
    [
      "original run ID",
      (value) => {
        value.workflow_run_id = 0;
      },
    ],
    [
      "unknown nested key",
      (value) => {
        (value.reconciliation as Record<string, unknown>).unexpected = true;
      },
    ],
    ...[null, [], "reconciled", true, 2, {}].map((entry): ProvenanceMutation => [
      `nested shape ${JSON.stringify(entry)}`,
      (value) => {
        value.reconciliation = entry;
      },
    ]),
    ...["workflow_run_attempt", "release_job_id"].flatMap((key): ProvenanceMutation[] => [
      [
        `missing ${key}`,
        (value) => {
          delete (value.reconciliation as Record<string, unknown>)[key];
        },
      ],
      ...[null, "2", true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], {}].map(
        (entry): ProvenanceMutation => [
          `${key} ${JSON.stringify(entry)}`,
          (value) => {
            (value.reconciliation as Record<string, unknown>)[key] = entry;
          },
        ],
      ),
    ]),
  ];
}
