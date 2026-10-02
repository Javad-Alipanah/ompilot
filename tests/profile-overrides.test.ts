import { expect, test } from "bun:test";
import { pickerOverrides, overridesBeforeSwitch } from "../src/omp/profileOverrides";

const active = { model: "provider-a/model-a", thinking: "high", approvalMode: "write", autoApprove: true };

test("a new profile inherits its own OMP defaults rather than the previous model or approval bypass", () => {
  expect(pickerOverrides("a", "b", active, undefined)).toEqual({ model: "", thinking: "", approvalMode: "", autoApprove: false });
});

test("returning to a profile restores its remembered choices", () => {
  const saved = { model: "provider-b/model-b", thinking: "low", approvalMode: "always-ask", autoApprove: false };
  expect(pickerOverrides("a", "b", active, saved)).toEqual(saved);
  expect(pickerOverrides("a", "b", active, saved)).not.toBe(saved);
});

test("selecting the same effective profile preserves current explicit choices", () => {
  expect(pickerOverrides("a", "a", active, undefined)).toEqual(active);
});

test("manual cross-profile edits do not overwrite the previous profile's bound choices", () => {
  const explicitTarget = { ...active, model: "target/model", autoApprove: false };
  expect(overridesBeforeSwitch("a", "b", explicitTarget, active, false)).toEqual(active);
  expect(overridesBeforeSwitch("a", "b", explicitTarget, active, true)).toEqual(explicitTarget);
  expect(overridesBeforeSwitch("a", "a", explicitTarget, active, false)).toEqual(explicitTarget);
});
