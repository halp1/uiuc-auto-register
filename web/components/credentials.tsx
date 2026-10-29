import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicSettings } from "../../src/core/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { InlineError } from "@/components/ui/list";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

/** Copy text with a short confirmation. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip content={copied ? "Copied" : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className={className}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            // Clipboard can be blocked on plain http. The text is still selectable.
          }
        }}
      >
        {copied ? <Check className="text-ready" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

/** Inline code with a copy button, for commands and flags the user has to paste. */
export function CopyCode({ text }: { text: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-border-strong bg-black py-0.5 pl-2 pr-0.5 align-middle font-mono text-[0.8125rem] text-fg">
      <span className="min-w-0 break-all">{text}</span>
      <CopyButton text={text} label={`Copy ${text}`} className="size-6" />
    </span>
  );
}

const PERIOD = 30;

/**
 * The current 6-digit code for a pasted authenticator key, from POST /api/setup/totp-code.
 * Refetches at every 30 s boundary. Nothing is stored by the server.
 */
export function TotpCode({ secret, onValidChange }: { secret: string; onValidChange?: (valid: boolean) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(PERIOD);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = secret.replace(/\s+/g, "");
  const validRef = useRef(onValidChange);
  validRef.current = onValidChange;

  useEffect(() => {
    if (!key) {
      setCode(null);
      setError(null);
      validRef.current?.(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      setLoading(true);
      try {
        const res = await api.totpCode(key);
        if (cancelled) return;
        setCode(res.code);
        setError(null);
        validRef.current?.(true);
        // Fetch again just after the next window starts.
        timer = setTimeout(load, Math.max(1, res.secondsLeft) * 1000 + 250);
      } catch (e) {
        if (cancelled) return;
        setCode(null);
        setError(errorMessage(e));
        validRef.current?.(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    const debounce = setTimeout(load, 350);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  useEffect(() => {
    const tick = () => setLeft(PERIOD - Math.floor((Date.now() / 1000) % PERIOD));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  if (!key) return null;
  if (error) return <InlineError>{error}</InlineError>;

  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-black px-4 py-3">
      {code ? (
        <span aria-label={`Current code ${code.split("").join(" ")}`} className="font-mono text-[2rem] font-medium leading-none tracking-[0.18em] tabular-nums text-fg">
          {code.slice(0, 3)}
          <span className="ml-[0.18em]">{code.slice(3)}</span>
        </span>
      ) : (
        <Skeleton className="h-8 w-40" />
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="relative inline-flex size-9 items-center justify-center" aria-label={`${left} seconds left`} role="timer">
          <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r={r} fill="none" stroke="var(--color-border-strong)" strokeWidth="2.5" />
            <circle
              cx="18"
              cy="18"
              r={r}
              fill="none"
              stroke={left <= 5 ? "var(--color-warning)" : "var(--color-fg-muted)"}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - left / PERIOD)}
              className="transition-[stroke-dashoffset] duration-200 ease-linear"
            />
          </svg>
          <span className={cn("text-[0.6875rem] tabular-nums", left <= 5 ? "text-warning" : "text-fg-muted")}>{left}</span>
        </span>
        {code && <CopyButton text={code} label="Copy code" />}
        {loading && !code && <span className="sr-only">Loading code</span>}
      </div>
    </div>
  );
}

export interface CredentialDraft {
  netid: string;
  password: string;
  totpSecret: string;
}

/** Fill only what was typed. Blank password or key keeps the saved one. */
export function credentialPatch(draft: CredentialDraft, settings: PublicSettings) {
  const patch: { netid?: string; password?: string; totpSecret?: string } = {};
  const netid = draft.netid.trim();
  if (netid && netid !== (settings.netid ?? "")) patch.netid = netid;
  if (draft.password) patch.password = draft.password;
  const key = draft.totpSecret.replace(/\s+/g, "");
  if (key) patch.totpSecret = key;
  return patch;
}

export function credentialsComplete(draft: CredentialDraft, settings: PublicSettings) {
  return (
    !!(draft.netid.trim() || settings.netid) &&
    !!(draft.password || settings.passwordSet) &&
    !!(draft.totpSecret.trim() || settings.totpSet)
  );
}

function SavedSecret({ label, onReplace }: { label: string; onReplace: () => void }) {
  return (
    <div className="flex h-9 items-center gap-2">
      <span className="flex flex-1 items-center gap-2 text-[0.8125rem] text-fg-muted">
        <Check className="size-4 text-ready" aria-hidden />
        Saved
      </span>
      <Button type="button" variant="secondary" size="xs" onClick={onReplace} aria-label={`Replace ${label}`}>
        Replace
      </Button>
    </div>
  );
}

/** NetID, password, and authenticator key. Saved secrets show as Saved with Replace. */
export function CredentialFields({
  settings,
  draft,
  onChange,
  keyGuide,
  idPrefix = "cred",
}: {
  settings: PublicSettings;
  draft: CredentialDraft;
  onChange: (patch: Partial<CredentialDraft>) => void;
  keyGuide?: ReactNode;
  idPrefix?: string;
}) {
  const [editPassword, setEditPassword] = useState(!settings.passwordSet);
  const [editKey, setEditKey] = useState(!settings.totpSet);
  useEffect(() => {
    if (!settings.passwordSet) setEditPassword(true);
    if (!settings.totpSet) setEditKey(true);
  }, [settings.passwordSet, settings.totpSet]);
  // After a save clears the draft, fall back to the Saved view.
  useEffect(() => {
    if (!draft.password && settings.passwordSet) setEditPassword(false);
    if (!draft.totpSecret && settings.totpSet) setEditKey(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.passwordSet, settings.totpSet]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-netid`}>NetID</Label>
          <Input
            id={`${idPrefix}-netid`}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={settings.netid ?? "jdoe2"}
            className="font-mono"
            value={draft.netid}
            onChange={e => onChange({ netid: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-password`}>Password</Label>
          {editPassword ? (
            <div className="flex gap-2">
              <Input
                id={`${idPrefix}-password`}
                type="password"
                autoComplete="current-password"
                value={draft.password}
                onChange={e => onChange({ password: e.target.value })}
              />
              {settings.passwordSet && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9"
                  onClick={() => {
                    setEditPassword(false);
                    onChange({ password: "" });
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            <SavedSecret label="password" onReplace={() => setEditPassword(true)} />
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-key`}>Authenticator key</Label>
        {keyGuide}
        {editKey ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                id={`${idPrefix}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Secret key from the Microsoft page"
                className="font-mono"
                value={draft.totpSecret}
                onChange={e => onChange({ totpSecret: e.target.value })}
              />
              {settings.totpSet && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9"
                  onClick={() => {
                    setEditKey(false);
                    onChange({ totpSecret: "" });
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <TotpCode secret={draft.totpSecret} />
          </div>
        ) : (
          <SavedSecret label="authenticator key" onReplace={() => setEditKey(true)} />
        )}
      </div>
    </div>
  );
}
