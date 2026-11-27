import { join } from "node:path";
import {
  authorityRevision,
  cohort,
  command,
  fetchObserved,
  fixtures,
  git,
  github,
  installedFiles,
  producerRoot,
  rawRoot,
  record,
  retain,
  selected,
  type Row,
} from "./bootstrap-io.ts";
import { authenticatePublishedController } from "./controller-authentication.ts";

/** Historical campaign retains its fixed authority, cohort, fixtures and observation ports. */
export function authenticateController(
  centralRoot: string,
  installation: string,
  node26: string,
  npmEntrypoint: string,
  coordinates: readonly Row[],
): Promise<Row[]> {
  return authenticatePublishedController(
    {
      fixtures,
      producerRoot,
      rawRoot,
      command,
      fetchObserved,
      git,
      github,
      installedFiles,
      record,
      retain,
      selected,
    },
    {
      installation,
      node26,
      npmEntrypoint,
      coordinates,
      authorityRevision,
      candidatePath: join(
        centralRoot,
        "governance/evidence/docs-cohorts/" + cohort + "/candidate-input.json",
      ),
    },
  );
}
