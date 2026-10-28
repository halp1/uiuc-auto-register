// Schedule guards around a live registration batch. Pure functions, unit tested in test/safety.

import type { RegisterRequest } from "../core/types";

export interface RegistrationAction {
  courseRegistrationStatus: string;
  description: string;
  [key: string]: unknown;
}

/** A Banner registration model (one row of the working set) as sent to submitRegistration/batch. */
export interface RegistrationModel {
  courseReferenceNumber: string;
  term: string;
  registrationActions?: RegistrationAction[] | null;
  selectedAction?: string | null;
  [key: string]: unknown;
}

export const ADD_ACTION = /web regist|register|add/i;
export const DROP_ACTION = /drop|delete/i;

/**
 * Pick the action code for an add or a drop. Returns null when no action matches or the choice is ambiguous.
 * An add candidate must not also look like a drop, and vice versa.
 */
export function chooseAction(model: Pick<RegistrationModel, "registrationActions">, kind: "add" | "drop"): string | null {
  const actions = Array.isArray(model.registrationActions) ? model.registrationActions : [];
  const wanted = kind === "add" ? ADD_ACTION : DROP_ACTION;
  const other = kind === "add" ? DROP_ACTION : ADD_ACTION;
  const codes = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action.description !== "string" || typeof action.courseRegistrationStatus !== "string") continue;
    if (!action.courseRegistrationStatus) continue;
    if (wanted.test(action.description) && !other.test(action.description)) codes.add(action.courseRegistrationStatus);
  }
  return codes.size === 1 ? [...codes][0]! : null;
}

/** Whether the model's selectedAction is an add or a drop (null when missing, unknown, or both). */
export function selectedActionKind(model: Pick<RegistrationModel, "registrationActions" | "selectedAction">): "add" | "drop" | null {
  const selected = model.selectedAction;
  if (typeof selected !== "string" || !selected) return null;
  const actions = Array.isArray(model.registrationActions) ? model.registrationActions : [];
  const action = actions.find(a => a?.courseRegistrationStatus === selected);
  if (!action || typeof action.description !== "string") return null;
  const add = ADD_ACTION.test(action.description) && !DROP_ACTION.test(action.description);
  const drop = DROP_ACTION.test(action.description) && !ADD_ACTION.test(action.description);
  return add ? "add" : drop ? "drop" : null;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export interface PreSubmitContext {
  swapsUnlocked: boolean;
}

/**
 * Check the exact models about to be submitted. Only request.addCrns with an add action, plus at most
 * request.dropCrn with a drop action when swaps are unlocked, all on request.term. Anything else aborts.
 */
export function preSubmitCheck(models: RegistrationModel[], request: RegisterRequest, ctx: PreSubmitContext): GuardResult {
  if (!Array.isArray(models) || models.length === 0) return { ok: false, reason: "No models to submit" };
  const adds = new Set(request.addCrns);
  if (adds.size === 0 || adds.size !== request.addCrns.length) return { ok: false, reason: "Request add CRNs are empty or repeated" };
  if (request.dropCrn && adds.has(request.dropCrn)) return { ok: false, reason: "Drop CRN is also an add CRN" };
  const seen = new Set<string>();
  let dropSeen = false;
  for (const model of models) {
    const crn = String(model?.courseReferenceNumber ?? "");
    if (!crn) return { ok: false, reason: "Model without a CRN" };
    if (String(model.term ?? "") !== request.term) return { ok: false, reason: `CRN ${crn} is on term ${model.term}, expected ${request.term}` };
    if (seen.has(crn)) return { ok: false, reason: `CRN ${crn} appears twice` };
    seen.add(crn);
    const kind = selectedActionKind(model);
    if (adds.has(crn)) {
      if (kind !== "add") return { ok: false, reason: `CRN ${crn} does not have an add action selected` };
      continue;
    }
    if (request.dropCrn && crn === request.dropCrn) {
      if (!ctx.swapsUnlocked) return { ok: false, reason: "Swaps are locked" };
      if (kind !== "drop") return { ok: false, reason: `CRN ${crn} does not have a drop action selected` };
      dropSeen = true;
      continue;
    }
    return { ok: false, reason: `CRN ${crn} is not part of this request` };
  }
  for (const crn of adds) if (!seen.has(crn)) return { ok: false, reason: `CRN ${crn} is missing from the batch` };
  if (request.dropCrn && !dropSeen) return { ok: false, reason: `Drop CRN ${request.dropCrn} is missing from the batch` };
  return { ok: true };
}

/** Every CRN registered before must still be registered after, except the one named drop. */
export function postSubmitDiff(before: string[], after: string[], request: Pick<RegisterRequest, "dropCrn">): { ok: boolean; lost: string[] } {
  const now = new Set(after);
  const lost = [...new Set(before)].filter(crn => crn !== request.dropCrn && !now.has(crn));
  return { ok: lost.length === 0, lost };
}
