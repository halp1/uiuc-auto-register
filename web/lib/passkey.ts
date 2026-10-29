import { startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import type { AuthStatus, PasskeyInfo } from "../../src/core/types";
import { api, isMock } from "./api";
import { deviceName } from "./auth";

/** The browser prompt was dismissed. Not worth an error message. */
export function isPasskeyCancel(error: unknown) {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

export async function registerPasskey(name = deviceName()): Promise<PasskeyInfo> {
  const options = await api.passkeyRegisterOptions();
  // The mock has no authenticator to talk to, so it skips the browser prompt.
  const response = isMock ? { mock: true } : await startRegistration({ optionsJSON: options as never });
  return api.passkeyRegisterVerify(response, name);
}

export async function signInWithPasskey(remember: boolean): Promise<AuthStatus> {
  const options = await api.passkeyLoginOptions();
  const response = isMock ? { mock: true } : await startAuthentication({ optionsJSON: options as never });
  return api.passkeyLoginVerify(response, remember);
}

export function cancelPasskeyPrompt() {
  WebAuthnAbortService.cancelCeremony();
}
