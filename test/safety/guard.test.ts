import { describe, expect, test } from "bun:test";
import { chooseAction, postSubmitDiff, preSubmitCheck, type RegistrationModel } from "../../src/banner/guard";
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
  test("picks add and drop when unambiguous", () => {
    expect(chooseAction(m("1", null), "add")).toBe("RW");
    expect(chooseAction(m("1", null), "drop")).toBe("DW");
  });
  test("ambiguous or missing returns null", () => {
    const two = [...ACTIONS, { courseRegistrationStatus: "RA", description: "Add (approval)" }];
    expect(chooseAction(m("1", null, "120271", two), "add")).toBeNull();
    expect(chooseAction(m("1", null, "120271", []), "add")).toBeNull();
    expect(chooseAction({ registrationActions: null }, "drop")).toBeNull();
    expect(chooseAction(m("1", null, "120271", [{ courseRegistrationStatus: "X", description: "Drop/Add" }]), "add")).toBeNull();
  });
});

describe("preSubmitCheck", () => {
  const locked = { swapsUnlocked: false };
  const unlocked = { swapsUnlocked: true };

  test("accepts exactly the add CRNs with add actions", () => {
    expect(preSubmitCheck([m("31187", "RW"), m("31225", "RW")], req(["31187", "31225"]), locked)).toEqual({ ok: true });
  });

  test("aborts on extra, missing, wrong-term, or wrong-action models", () => {
    expect(preSubmitCheck([m("31187", "RW"), m("31225", "RW"), m("40000", "RW")], req(["31187", "31225"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW")], req(["31187", "31225"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW", "120268")], req(["31187"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "DW")], req(["31187"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", null)], req(["31187"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "ZZ")], req(["31187"]), locked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW"), m("31187", "RW")], req(["31187"]), locked).ok).toBe(false);
    expect(preSubmitCheck([], req(["31187"]), locked).ok).toBe(false);
  });

  test("an existing registered CRN in the batch aborts", () => {
    const result = preSubmitCheck([m("31187", "RW"), m("55555", "RW")], req(["31187"]), locked);
    expect(result).toEqual({ ok: false, reason: "CRN 55555 is not part of this request" });
  });

  test("drop only when swaps are unlocked and only the named drop", () => {
    const models = [m("31187", "RW"), m("22222", "DW")];
    expect(preSubmitCheck(models, req(["31187"], "22222"), locked).ok).toBe(false);
    expect(preSubmitCheck(models, req(["31187"], "22222"), unlocked)).toEqual({ ok: true });
    expect(preSubmitCheck([m("31187", "RW"), m("22222", "RW")], req(["31187"], "22222"), unlocked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW"), m("33333", "DW")], req(["31187"], "22222"), unlocked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW")], req(["31187"], "22222"), unlocked).ok).toBe(false);
    expect(preSubmitCheck([m("31187", "RW"), m("31187", "DW")], req(["31187"], "31187"), unlocked).ok).toBe(false);
  });
});

describe("postSubmitDiff", () => {
  test("ok when everything before is still there", () => {
    expect(postSubmitDiff(["1", "2"], ["1", "2", "3"], { dropCrn: null })).toEqual({ ok: true, lost: [] });
  });
  test("reports lost CRNs", () => {
    expect(postSubmitDiff(["1", "2", "4"], ["1", "3"], { dropCrn: null })).toEqual({ ok: false, lost: ["2", "4"] });
  });
  test("the named drop may disappear, nothing else", () => {
    expect(postSubmitDiff(["1", "2"], ["1", "3"], { dropCrn: "2" })).toEqual({ ok: true, lost: [] });
    expect(postSubmitDiff(["1", "2"], ["3"], { dropCrn: "2" })).toEqual({ ok: false, lost: ["1"] });
  });
});
