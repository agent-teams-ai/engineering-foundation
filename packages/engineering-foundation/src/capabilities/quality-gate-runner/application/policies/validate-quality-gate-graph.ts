import type {
  QualityGatePolicy,
  QualityGateProfile,
  QualityGateTask
} from "../model/quality-gate.js";

export class QualityGateGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityGateGraphError";
  }
}

function duplicate(values: readonly string[]): string | undefined {
  const observed = new Set<string>();
  for (const value of values) {
    if (observed.has(value)) {
      return value;
    }
    observed.add(value);
  }
  return undefined;
}

function dependencies(task: QualityGateTask): readonly string[] {
  return [...task.needs, ...task.after];
}

function assertAcyclic(profile: QualityGateProfile): void {
  const tasks = new Map(profile.tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: readonly string[]): void => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id];
      throw new QualityGateGraphError(
        `Profile ${profile.id} contains a dependency cycle: ${cycle.join(" -> ")}.`
      );
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const task = tasks.get(id);
    for (const dependency of task === undefined ? [] : dependencies(task)) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of profile.tasks) {
    visit(task.id, []);
  }
}

export function validateQualityGatePolicy(policy: QualityGatePolicy): void {
  const duplicateProfile = duplicate(policy.profiles.map(({ id }) => id));
  if (duplicateProfile !== undefined) {
    throw new QualityGateGraphError(`Duplicate profile ID: ${duplicateProfile}.`);
  }
  for (const profile of policy.profiles) {
    const taskIds = profile.tasks.map(({ id }) => id);
    const duplicateTask = duplicate(taskIds);
    if (duplicateTask !== undefined) {
      throw new QualityGateGraphError(
        `Profile ${profile.id} contains duplicate task ID: ${duplicateTask}.`
      );
    }
    const known = new Set(taskIds);
    for (const task of profile.tasks) {
      for (const dependency of dependencies(task)) {
        if (dependency === task.id) {
          throw new QualityGateGraphError(
            `Profile ${profile.id} task ${task.id} cannot depend on itself.`
          );
        }
        if (!known.has(dependency)) {
          throw new QualityGateGraphError(
            `Profile ${profile.id} task ${task.id} references unknown task ${dependency}.`
          );
        }
      }
      const needs = new Set(task.needs);
      const overlap = task.after.find((dependency) => needs.has(dependency));
      if (overlap !== undefined) {
        throw new QualityGateGraphError(
          `Profile ${profile.id} task ${task.id} declares ${overlap} in both needs and after.`
        );
      }
    }
    assertAcyclic(profile);
  }
}
