// Independent expected relation. Runtime's nonempty-delta policy remains local.
export const cases = [
  { id: 'same', compatible: true, runtimeMode: 'full' },
  { id: 'body-content', compatible: true, runtimeMode: 'affected-pr' },
  { id: 'closed-content', compatible: false, runtimeMode: 'full' },
  { id: 'chmod', compatible: false, runtimeMode: 'full' },
  { id: 'addition', compatible: false, runtimeMode: 'full' },
  { id: 'deletion', compatible: false, runtimeMode: 'full' },
  { id: 'rename', compatible: false, runtimeMode: 'full' },
] as const;
