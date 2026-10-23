import type { Diagnostic, ManifestSnapshot, PackageChange, PlannedRelease, WorkspacePackage } from './model.js';
import { nonVersion, reject, same, version, type CandidateFacts } from './relations.js';

function identity(snapshot: ManifestSnapshot, p: WorkspacePackage): boolean {
  return snapshot.file.type === 'file' && snapshot.file.mode === '100644'
    && snapshot.semantic['name'] === p.name
    && (snapshot.semantic['private'] === true) === (p.classification === 'private')
    && (version(snapshot.semantic) !== null || (p.classification === 'private' && p.versioning !== 'versioned'));
}

function checkVersions(p: WorkspacePackage, before: ManifestSnapshot, after: ManifestSnapshot, plan: PlannedRelease | undefined, diagnostics: Diagnostic[]): PackageChange | null {
  const at = { packageName: p.name, path: p.manifestPath };
  const oldVersion = version(before.semantic);
  const newVersion = version(after.semantic);
  if (plan === undefined) {
    if (oldVersion !== newVersion) { reject(diagnostics, 'plan.unexpected-version', at, 'Manifest version changed without an exact planned release.'); }
  } else if (plan.oldVersion !== version(p.before.semantic) || plan.oldVersion !== oldVersion || plan.newVersion !== newVersion) {
    reject(diagnostics, 'plan.version-mismatch', at, 'Observed old/new versions do not equal the complete frozen plan.');
  }
  return oldVersion === newVersion ? null : Object.freeze({ packageName: p.name, manifestPath: p.manifestPath, oldVersion, newVersion });
}

function checkManifestDiff(p: WorkspacePackage, before: ManifestSnapshot, after: ManifestSnapshot, facts: CandidateFacts, diagnostics: Diagnostic[]): void {
  const at = { packageName: p.name, path: p.manifestPath };
  const changed = version(before.semantic) !== version(after.semantic);
  const fileChanged = !same(before.file, after.file);
  const diff = facts.diff.get(p.manifestPath);
  const plan = facts.releases.get(p.name);
  const plannedEdit = plan !== undefined && plan.oldVersion !== plan.newVersion;
  if (fileChanged && (!plannedEdit || !changed)) { reject(diagnostics, 'diff.inconsistent', at, 'Manifest bytes or mode changed without a planned version edit.'); }
  if (fileChanged || changed || diff !== undefined) {
    if (diff?.kind !== 'modified' || !same(diff.before, before.file) || !same(diff.after, after.file)
      || !fileChanged || (changed && before.file.digest === after.file.digest)) {
      reject(diagnostics, 'diff.inconsistent', at, 'Manifest snapshots and the complete modified-file diff do not agree.');
    }
  }
}

export function checkManifests(facts: CandidateFacts, diagnostics: Diagnostic[]): PackageChange[] {
  const changes: PackageChange[] = [];
  for (const observation of facts.observedManifests.values()) {
    if (!facts.manifests.has(observation.manifestPath)) { reject(diagnostics, 'package.unknown', { path: observation.manifestPath }, 'Observed manifest is outside the classified inventory.'); }
  }
  for (const p of facts.packages.values()) {
    const at = { packageName: p.name, path: p.manifestPath };
    const observed = facts.observedManifests.get(p.manifestPath);
    if (!identity(p.before, p)) { reject(diagnostics, 'manifest.identity', at, 'Accepted manifest identity, visibility, mode or version is inconsistent with its classification.'); }
    if (observed === undefined || observed.before === null || observed.after === null) {
      reject(diagnostics, 'manifest.missing', at, 'Both independently observed manifest snapshots are required.');
      continue;
    }
    if (!same(p.before, observed.before)) { reject(diagnostics, 'manifest.source-mismatch', at, 'Observed before manifest differs from the accepted source snapshot.'); }
    if (!identity(observed.before, p) || !identity(observed.after, p)) { reject(diagnostics, 'manifest.identity', at, 'Observed manifest identity, visibility, mode or version differs from its classification.'); }
    const change = checkVersions(p, observed.before, observed.after, facts.releases.get(p.name), diagnostics);
    if (change !== null) { changes.push(change); }
    if (!same(nonVersion(observed.before.semantic), nonVersion(observed.after.semantic))) { reject(diagnostics, 'manifest.content-changed', at, 'Only the exact planned version may change in a manifest.'); }
    checkManifestDiff(p, observed.before, observed.after, facts, diagnostics);
  }
  return changes;
}
