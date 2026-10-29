import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * Error text for auth forms. A 429 becomes a live countdown that clears itself.
 * Returns the message to show and whether submitting is blocked.
 */
export function useAuthError() {
  const [message, setMessage] = useState<string | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) {
        setUntil(null);
        setMessage(null);
      }
    }, 250);
    return () => clearInterval(id);
  }, [until]);

  const left = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return {
    blocked: left > 0,
    text: left > 0 ? `Too many tries. Try again in ${left} ${left === 1 ? "second" : "seconds"}.` : message,
    clear: () => setMessage(null),
    set(error: unknown) {
      if (error instanceof ApiError && error.status === 429) {
        setNow(Date.now());
        setUntil(Date.now() + (error.retryAfter ?? 30) * 1000);
        setMessage(null);
      } else setMessage(errorMessage(error));
    },
  };
}
