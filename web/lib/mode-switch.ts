import { useState } from "react";
import type { Mode } from "../../src/core/types";
import { api } from "./api";
import { useStore } from "./store";
import { errorMessage } from "./utils";

export const modeNames: Record<Mode, string> = { live: "Live", rehearsal: "Test", simulated: "Simulated" };

/**
 * Switch the app mode. The server restarts its Banner side, the stream drops and reconnects.
 * `switching` stays true until the running app reports the new mode with the connection open again.
 */
export function useModeSwitch() {
  const status = useStore(s => s.status);
  const connection = useStore(s => s.connection);
  const [target, setTarget] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settled = !!status && !status.restarting && connection === "open" && (!target || status.mode === target);
  const switching = busy || (!!target && !settled) || !!status?.restarting;

  async function switchTo(mode: Mode) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setMode(mode);
      setTarget(res.restarting ? mode : null);
    } catch (e) {
      setError(errorMessage(e));
      setTarget(null);
    } finally {
      setBusy(false);
    }
  }

  return { switching, target, error, switchTo };
}
