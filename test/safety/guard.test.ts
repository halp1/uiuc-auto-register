import { describe, expect, test } from "bun:test";
import { chooseAction, postSubmitDiff, preSubmitCheck, type RegistrationAction, type RegistrationModel } from "../../src/banner/guard";
import type { RegisterRequest } from "../../src/core/types";

const ACTIONS = [
  { courseRegistrationStatus: "RW", description: "**Web Registered**" },
  { courseRegistrationStatus: "DW", description: "Web Drop" },
];
const m = (crn: string, selectedAction: string | null, term = "120271", actions = ACTIONS): RegistrationModel => ({
  courseReferenceNumber: crn,
  term,
  registrationActions: actions,
  selectedAction,
});
const req = (addCrns: string[], dropCrn: string | null = null, term = "120271"): RegisterRequest => ({ term, bundleId: 1, addCrns, dropCrn });

describe("chooseAction", () => {
  test.each<[string, RegistrationAction[] | null, "add" | "drop", string | null]>([
    ["unambiguous add", ACTIONS, "add", "RW"],
    ["unambiguous drop", ACTIONS, "drop", "DW"],
    ["two add candidates", [...ACTIONS, { courseRegistrationStatus: "RA", description: "Add (approval)" }], "add", null],
    ["no actions", [], "add", null],
    ["null actions", null, "drop", null],
    ["description that is both add and drop", [{ courseRegistrationStatus: "X", description: "Drop/Add" }], "add", null],
  ])("%s", (_name, actions, kind, expected) => {
    expect(chooseAction({ registrationActions: actions }, kind)).toBe(expected);
  });
});

describe("preSubmitCheck", () => {
  const locked = { swapsUnlocked: false };
  const unlocked = { swapsUnlocked: true };

  test.each<[string, RegistrationModel[], RegisterRequest, { swapsUnlocked: boolean }]>([
    ["exactly the add CRNs", [m("31187", "RW"), m("31225", "RW")], req(["31187", "31225"]), locked],
    ["add plus the named drop with swaps unlocked", [m("31187", "RW"), m("22222", "DW")], req(["31187"], "22222"), unlocked],
  ])("accepts %s", (_name, models, request, ctx) => {
    expect(preSubmitCheck(models, request, ctx)).toEqual({ ok: true });
  });

  test.each<[string, RegistrationModel[], RegisterRequest, { swapsUnlocked: boolean }]>([
    ["an extra CRN", [m("31187", "RW"), m("31225", "RW"), m("40000", "RW")], req(["31187", "31225"]), locked],
    ["an already registered CRN in the batch", [m("31187", "RW"), m("55555", "RW")], req(["31187"]), locked],
    ["a missing add", [m("31187", "RW")], req(["31187", "31225"]), locked],
    ["a wrong term", [m("31187", "RW", "120268")], req(["31187"]), locked],
    ["a drop action on an add", [m("31187", "DW")], req(["31187"]), locked],
    ["no selected action", [m("31187", null)], req(["31187"]), locked],
    ["an unknown action", [m("31187", "ZZ")], req(["31187"]), locked],
    ["a repeated CRN", [m("31187", "RW"), m("31187", "RW")], req(["31187"]), locked],
    ["an empty batch", [], req(["31187"]), locked],
    ["a drop while swaps are locked", [m("31187", "RW"), m("22222", "DW")], req(["31187"], "22222"), locked],
    ["the named drop with an add action", [m("31187", "RW"), m("22222", "RW")], req(["31187"], "22222"), unlocked],
    ["a drop of a different CRN", [m("31187", "RW"), m("33333", "DW")], req(["31187"], "22222"), unlocked],
    ["the named drop missing", [m("31187", "RW")], req(["31187"], "22222"), unlocked],
    ["a drop CRN that is also an add", [m("31187", "RW"), m("31187", "DW")], req(["31187"], "31187"), unlocked],
  ])("aborts on %s", (_name, models, request, ctx) => {
    expect(preSubmitCheck(models, request, ctx).ok).toBe(false);
  });
});

describe("postSubmitDiff", () => {
  test.each<[string, string[], string[], string | null, { ok: boolean; lost: string[] }]>([
    ["everything kept, one added", ["1", "2"], ["1", "2", "3"], null, { ok: true, lost: [] }],
    ["lost CRNs reported", ["1", "2", "4"], ["1", "3"], null, { ok: false, lost: ["2", "4"] }],
    ["the named drop may disappear", ["1", "2"], ["1", "3"], "2", { ok: true, lost: [] }],
    ["only the named drop may disappear", ["1", "2"], ["3"], "2", { ok: false, lost: ["1"] }],
  ])("%s", (_name, before, after, dropCrn, expected) => {
    expect(postSubmitDiff(before, after, { dropCrn })).toEqual(expected);
  });
});
