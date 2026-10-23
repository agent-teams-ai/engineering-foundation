interface MutableEntry extends Record<string, unknown> {
  provenance: Record<string, unknown> & { registry_attestation_url: string };
}
interface MutableCohort {
  packages: MutableEntry[];
  assets: {
    skill: Record<string, unknown>;
    asset_catalog: Record<string, unknown>;
    transition_catalog?: unknown;
  };
  reusable_workflow: Record<string, unknown> & { repository_id: number };
  runtime: Record<string, unknown> & { apply_platforms: string[] };
  runtime_closure: Record<string, unknown>;
  canary_repositories: Record<string, unknown>[];
  evidence_references: string[];
  upgrade_from: string[];
}
export function cohortDriftMutations(): [string, (cohort: MutableCohort) => void][] {
  return [
    [
      "wrong package role",
      (cohort) => {
        cohort.packages[0]!.role = "direct";
      },
    ],
    [
      "reordered packages",
      (cohort) => {
        cohort.packages.reverse();
      },
    ],
    [
      "extra package key",
      (cohort) => {
        cohort.packages[0]!.unexpected = true;
      },
    ],
    [
      "missing package key",
      (cohort) => {
        Reflect.deleteProperty(cohort.packages[0]!, "published_at");
      },
    ],
    [
      "extra provenance key",
      (cohort) => {
        cohort.packages[0]!.provenance.unexpected = true;
      },
    ],
    [
      "missing provenance key",
      (cohort) => {
        Reflect.deleteProperty(cohort.packages[0]!.provenance, "source_repository_id");
      },
    ],
    [
      "unbound provenance attestation",
      (cohort) => {
        cohort.packages[0]!.provenance.registry_attestation_url =
          cohort.packages[1]!.provenance.registry_attestation_url;
      },
    ],
    [
      "wrong asset package",
      (cohort) => {
        cohort.assets.skill.package = "@agent-teams/docs-protocol";
      },
    ],
    [
      "extra asset entry key",
      (cohort) => {
        cohort.assets.asset_catalog.unexpected = true;
      },
    ],
    [
      "missing asset container key",
      (cohort) => {
        Reflect.deleteProperty(cohort.assets, "transition_catalog");
      },
    ],
    [
      "wrong reusable workflow repository ID",
      (cohort) => {
        cohort.reusable_workflow.repository_id += 1;
      },
    ],
    [
      "extra reusable workflow key",
      (cohort) => {
        cohort.reusable_workflow.unexpected = true;
      },
    ],
    [
      "wrong runtime platforms",
      (cohort) => {
        cohort.runtime.apply_platforms.reverse();
      },
    ],
    [
      "missing runtime key",
      (cohort) => {
        Reflect.deleteProperty(cohort.runtime, "check_plan_platforms");
      },
    ],
    [
      "wrong runtime closure domain",
      (cohort) => {
        cohort.runtime_closure.domain = "wrong";
      },
    ],
    [
      "unbound runtime closure path",
      (cohort) => {
        cohort.runtime_closure.projection_path = `governance/docs-runtime-closures/sha256-${"1".repeat(64)}.json`;
      },
    ],
    [
      "extra runtime closure key",
      (cohort) => {
        cohort.runtime_closure.unexpected = true;
      },
    ],
    [
      "missing runtime closure key",
      (cohort) => {
        Reflect.deleteProperty(cohort.runtime_closure, "package_count");
      },
    ],
    [
      "extra canary repository key",
      (cohort) => {
        cohort.canary_repositories[0]!.unexpected = true;
      },
    ],
    [
      "missing canary repository key",
      (cohort) => {
        Reflect.deleteProperty(cohort.canary_repositories[0]!, "repository");
      },
    ],
    [
      "duplicate evidence reference",
      (cohort) => {
        cohort.evidence_references.push(cohort.evidence_references[0]!);
      },
    ],
    [
      "missing evidence reference",
      (cohort) => {
        cohort.evidence_references.length = 0;
      },
    ],
    [
      "missing upgrade origin",
      (cohort) => {
        cohort.upgrade_from.length = 0;
      },
    ],
  ];
}
