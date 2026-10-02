export interface ProfileOverrides {
  model: string;
  thinking: string;
  approvalMode: string;
  autoApprove: boolean;
}

export const profileOverrideKeys = ["model", "thinking", "approvalMode", "autoApprove"] as const;

export function overridesBeforeSwitch(
  currentKey: string,
  nextKey: string,
  current: ProfileOverrides,
  bound: ProfileOverrides,
  fromPicker: boolean,
): ProfileOverrides {
  return { ...(fromPicker || currentKey === nextKey ? current : bound) };
}

export function pickerOverrides(
  currentKey: string,
  nextKey: string,
  current: ProfileOverrides,
  saved: ProfileOverrides | undefined,
): ProfileOverrides {
  return {
    ...(currentKey === nextKey
      ? current
      : (saved ?? { model: "", thinking: "", approvalMode: "", autoApprove: false })),
  };
}
