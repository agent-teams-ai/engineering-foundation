interface CanaryEvidence extends Record<string, unknown> {
  repository_id: number;
  repository: string;
  observed_cohort_id: string;
  observed_record_digest: string;
  observed_event_digest: string;
}
interface CanaryRegistry {
  events: { sequence: number; canary_evidence: CanaryEvidence[] }[];
  cohorts: { canary_repositories: { repository_id: number; repository: string }[] }[];
}
export function canaryDriftMutations(): [string, (value: CanaryRegistry) => void][] {
  return [
    [
      "wrong repository ID",
      (value) => {
        value.events[1]!.canary_evidence[0]!.repository_id++;
      },
    ],
    [
      "wrong repository name",
      (value) => {
        value.events[1]!.canary_evidence[0]!.repository = "agent-teams-ai/other";
      },
    ],
    [
      "wrong observed cohort",
      (value) => {
        value.events[1]!.canary_evidence[0]!.observed_cohort_id = "other";
      },
    ],
    [
      "wrong observed record",
      (value) => {
        value.events[1]!.canary_evidence[0]!.observed_record_digest = `sha256:${"a".repeat(64)}`;
      },
    ],
    [
      "wrong observed event",
      (value) => {
        value.events[1]!.canary_evidence[0]!.observed_event_digest = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "duplicate evidence",
      (value) => {
        value.events[1]!.canary_evidence.push(value.events[1]!.canary_evidence[0]!);
      },
    ],
    [
      "incomplete declared set",
      (value) => {
        value.cohorts[0]!.canary_repositories.push({
          repository_id: 2,
          repository: "agent-teams-ai/other",
        });
      },
    ],
    [
      "global sequence gap",
      (value) => {
        value.events[1]!.sequence = 3;
      },
    ],
  ];
}
