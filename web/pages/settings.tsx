import { Bell, CircleCheck, CircleX, LogIn, LogOut, RefreshCw, Send, TriangleAlert, X, Zap } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RehearsalReport } from "../../src/core/contracts";
import { NOTIFY_EVENTS, type NotifyEvent, type PublicSettings, type Route, type SettingsPatch } from "../../src/core/types";
import { ConfirmDialog } from "@/components/confirm";
import { SeatCount } from "@/components/data";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Card, CardBody, CardFooter, CardTitle, InlineError, PageHeader } from "@/components/ui/list";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Status } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { api, type SimState } from "@/lib/api";
import { chicagoLocalToIso, countdown, formatDateTime, isoToChicagoLocal, notifyLabels, termName, useNow } from "@/lib/format";
import { setNavigationGuard } from "@/lib/router";
import { local, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

// ---------- shared form plumbing ----------

/** Local form copy of a settings slice that resets when the server value changes and the form is clean. */
function useForm<T>(source: T) {
  const key = JSON.stringify(source);
  const [value, setValue] = useState<T>(source);
  const [base, setBase] = useState(key);
  const dirty = JSON.stringify(value) !== base;
  useEffect(() => {
    if (!dirty) {
      setValue(JSON.parse(key));
    }
    setBase(b => (dirty ? b : key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    value,
    set: (patch: Partial<T>) => setValue(v => ({ ...v, ...patch })),
    dirty,
    reset: () => setValue(JSON.parse(base)),
    commit: (next: T) => {
      setBase(JSON.stringify(next));
      setValue(next);
    },
  };
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, setError, message, setMessage, run };
}

async function saveSettings(patch: SettingsPatch) {
  const next = await api.putSettings(patch);
  local.settings(next);
  return next;
}

function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function Row({ title, hint, control, id }: { title: ReactNode; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p id={id} className="text-sm font-medium">
          {title}
        </p>
        {hint && <p className="mt-0.5 text-[0.8125rem] text-fg-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

// ---------- unsaved changes ----------

/** A card's unsaved edits. save() resolves true when the card saved cleanly. */
interface Pending {
  dirty: boolean;
  save: () => Promise<boolean>;
  reset: () => void;
}

type Registry = {
  register(id: string, pending: Pending): () => void;
  changed(): void;
};

const PendingContext = createContext<Registry | null>(null);

/** Registers a card's unsaved edits with the page-level bar. */
function usePending(id: string, pending: Pending) {
  const registry = useContext(PendingContext);
  const ref = useRef(pending);
  ref.current = pending;
  useEffect(() => {
    if (!registry) return;
    return registry.register(id, {
      get dirty() {
        return ref.current.dirty;
      },
      save: () => ref.current.save(),
      reset: () => ref.current.reset(),
    });
  }, [registry, id]);
  useEffect(() => registry?.changed(), [registry, pending.dirty]);
}

function usePendingRegistry() {
  const map = useRef(new Map<string, Pending>());
  const [, bump] = useState(0);
  const registry = useMemo<Registry>(
    () => ({
      register(id, pending) {
        map.current.set(id, pending);
        bump(n => n + 1);
        return () => {
          map.current.delete(id);
          bump(n => n + 1);
        };
      },
      changed: () => bump(n => n + 1),
    }),
    [],
  );
  const dirtyEntries = [...map.current.values()].filter(p => p.dirty);
  return { registry, dirtyEntries };
}

function UnsavedBar({ entries }: { entries: Pending[] }) {
  const [saving, setSaving] = useState(false);
  const [shake, setShake] = useState(0);
  const visible = entries.length > 0;

  // Leaving with unsaved edits: in-app links nudge the bar instead, the browser asks on reload or close.
  useEffect(() => {
    if (!visible) {
      setShake(0);
      return;
    }
    const release = setNavigationGuard(() => {
      setShake(n => n + 1);
      return false;
    });
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      release();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [visible]);

  async function saveAll() {
    setSaving(true);
    try {
      for (const entry of entries) {
        if (entry.dirty) await entry.save();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 md:left-60 sm:pb-6",
        "transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      )}
    >
      <div
        key={shake}
        role="region"
        aria-label="Unsaved changes"
        className={cn(
          "flex w-full max-w-3xl items-center gap-3 rounded-lg border bg-surface-2 py-2.5 pl-4 pr-2.5 shadow-[0_8px_30px_rgb(0_0_0/0.6)]",
          shake > 0 ? "animate-nudge border-warning" : "border-border-strong",
          visible && "pointer-events-auto",
        )}
      >
        <p className="min-w-0 flex-1 text-sm" aria-live="polite">
          {visible ? "You have unsaved changes" : ""}
        </p>
        <Button variant="ghost" size="sm" disabled={saving || !visible} tabIndex={visible ? 0 : -1} onClick={() => entries.forEach(e => e.reset())}>
          Revert
        </Button>
        <Button variant="primary" size="sm" loading={saving} disabled={!visible} tabIndex={visible ? 0 : -1} onClick={saveAll}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

/** Card footer for a non-blocking note or a save error. Hidden when there is nothing to say. */
function CardNote({ error, note }: { error: string | null; note?: ReactNode }) {
  if (!error && !note) return null;
  return <CardFooter>{error ? <InlineError>{error}</InlineError> : note}</CardFooter>;
}

// ---------- Registration ----------

function RegistrationCard({ settings }: { settings: PublicSettings }) {
  const status = useStore(s => s.status)!;
  const terms = useStore(s => s.terms);
  const form = useForm({
    approvalMode: settings.approvalMode,
    autoAfter: settings.approvalAutoAfterMin === null ? "" : String(settings.approvalAutoAfterMin),
    never: settings.approvalAutoAfterMin === null,
  });
  const action = useAction();
  const [liveOpen, setLiveOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const termLabel = termName(terms, settings.activeTerm);
  const autoAfterNum = Number(form.value.autoAfter);
  const autoInvalid = form.value.approvalMode === "approve" && !form.value.never && (!Number.isInteger(autoAfterNum) || autoAfterNum < 1);

  async function save() {
    if (autoInvalid) {
      action.setError("Enter a whole number of minutes, 1 or more.");
      return false;
    }
    const next = await action.run("save", () =>
      saveSettings({
        approvalMode: form.value.approvalMode,
        approvalAutoAfterMin: form.value.never ? null : autoAfterNum,
      }),
    );
    if (!next) return false;
    form.commit({
      approvalMode: next.approvalMode,
      autoAfter: next.approvalAutoAfterMin === null ? "" : String(next.approvalAutoAfterMin),
      never: next.approvalAutoAfterMin === null,
    });
    return true;
  }
  usePending("registration", { dirty: form.dirty, save, reset: () => (form.reset(), action.setError(null)) });

  async function setLive(enabled: boolean, text?: string) {
    setLiveBusy(true);
    setLiveError(null);
    try {
      local.settings(await api.live(enabled, text));
      setLiveOpen(false);
      setConfirmText("");
    } catch (e) {
      setLiveError(errorMessage(e));
    } finally {
      setLiveBusy(false);
    }
  }

  const liveAvailable = status.mode === "live";

  return (
    <Card id="registration" className="scroll-mt-20">
      <CardBody>
        <CardTitle>Registration</CardTitle>
        <Row
          title="When a seat opens"
          control={
            <Segmented
              aria-label="When a seat opens"
              value={form.value.approvalMode}
              onChange={approvalMode => form.set({ approvalMode })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "approve", label: "Approve" },
              ]}
            />
          }
        />
        {form.value.approvalMode === "approve" && (
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-black p-3">
            <Field label="Register anyway after" htmlFor="auto-after">
              <div className="flex items-center gap-2">
                <Input
                  id="auto-after"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="w-20 tabular-nums"
                  value={form.value.never ? "" : form.value.autoAfter}
                  disabled={form.value.never}
                  aria-invalid={autoInvalid || undefined}
                  onChange={e => form.set({ autoAfter: e.target.value })}
                />
                <span className="text-[0.8125rem] text-fg-muted">minutes</span>
              </div>
            </Field>
            <label className="flex h-9 items-center gap-2 text-[0.8125rem]">
              <Checkbox checked={form.value.never} onCheckedChange={v => form.set({ never: v === true })} />
              Never
            </label>
          </div>
        )}

        <div className="h-px bg-border" />

        <Row
          id="live-label"
          title={
            <span className="inline-flex items-center gap-2">
              <Zap className="size-4 text-fg-muted" aria-hidden />
              Live registration
            </span>
          }
          hint={
            liveAvailable
              ? settings.liveEnabled
                ? `On for ${termName(terms, settings.liveTerm)}`
                : "Run a passing test first"
              : "Needs REGISTRATION_MODE=live on the server"
          }
          control={
            <Switch
              aria-labelledby="live-label"
              checked={settings.liveEnabled}
              disabled={!liveAvailable || liveBusy || !settings.activeTerm}
              loading={liveBusy}
              onCheckedChange={v => {
                if (v) {
                  setLiveError(null);
                  setLiveOpen(true);
                } else setLive(false);
              }}
            />
          }
        />
        {liveError && !liveOpen && <InlineError>{liveError}</InlineError>}
      </CardBody>
      <CardNote error={action.error} />

      <Dialog
        open={liveOpen}
        onOpenChange={o => {
          setLiveOpen(o);
          if (!o) {
            setConfirmText("");
            setLiveError(null);
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={e => {
              e.preventDefault();
              if (confirmText === termLabel) setLive(true, confirmText);
            }}
          >
            <DialogBody>
              <DialogTitle>Turn on Live registration</DialogTitle>
              <DialogDescription>
                Armed bundles will be added to your real {termLabel} schedule when seats open. Existing classes are
                only dropped for a named swap.
              </DialogDescription>
              <Field label={<>Type <span className="font-mono text-fg">{termLabel}</span> to confirm</>} htmlFor="live-confirm">
                <Input
                  id="live-confirm"
                  autoComplete="off"
                  autoFocus
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  aria-invalid={liveError ? true : undefined}
                />
              </Field>
              <InlineError>{liveError}</InlineError>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setLiveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={confirmText !== termLabel} loading={liveBusy}>
                Turn on Live
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------- Polling ----------

function PollingCard({ settings }: { settings: PublicSettings }) {
  const form = useForm({
    interval: String(settings.pollIntervalSec),
    jitter: String(settings.jitterPct),
    overnightSlow: settings.overnightSlow,
  });
  const action = useAction();
  const interval = Number(form.value.interval);
  const jitter = Number(form.value.jitter);
  const intervalBad = !Number.isFinite(interval) || interval < 10;
  const jitterBad = !Number.isFinite(jitter) || jitter < 0 || jitter > 50;

  async function save() {
    if (intervalBad || jitterBad) {
      action.setError(intervalBad ? "Interval must be at least 10 seconds." : "Jitter must be between 0 and 50 percent.");
      return false;
    }
    const next = await action.run("save", () =>
      saveSettings({ pollIntervalSec: interval, jitterPct: jitter, overnightSlow: form.value.overnightSlow }),
    );
    if (!next) return false;
    form.commit({ interval: String(next.pollIntervalSec), jitter: String(next.jitterPct), overnightSlow: next.overnightSlow });
    return true;
  }
  usePending("polling", { dirty: form.dirty, save, reset: () => (form.reset(), action.setError(null)) });

  return (
    <Card id="polling" className="scroll-mt-20">
      <CardBody>
        <CardTitle>Polling</CardTitle>
        <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
          <Field label="Interval" htmlFor="poll-interval">
            <div className="flex items-center gap-2">
              <Input
                id="poll-interval"
                type="number"
                min={10}
                inputMode="numeric"
                className="tabular-nums"
                value={form.value.interval}
                aria-invalid={intervalBad || undefined}
                onChange={e => form.set({ interval: e.target.value })}
              />
              <span className="text-[0.8125rem] text-fg-muted">s</span>
            </div>
          </Field>
          <Field label="Jitter" htmlFor="poll-jitter">
            <div className="flex items-center gap-2">
              <Input
                id="poll-jitter"
                type="number"
                min={0}
                max={50}
                inputMode="numeric"
                className="tabular-nums"
                value={form.value.jitter}
                aria-invalid={jitterBad || undefined}
                onChange={e => form.set({ jitter: e.target.value })}
              />
              <span className="text-[0.8125rem] text-fg-muted">%</span>
            </div>
          </Field>
        </div>
        <Row
          id="overnight-label"
          title="Slow down overnight"
          hint="1 AM to 6 AM Central"
          control={
            <Switch
              aria-labelledby="overnight-label"
              checked={form.value.overnightSlow}
              onCheckedChange={v => form.set({ overnightSlow: v })}
            />
          }
        />
      </CardBody>
      <CardNote error={action.error} note="Minimum 10 seconds" />
    </Card>
  );
}

// ---------- Term and ticket ----------

function TermCard({ settings }: { settings: PublicSettings }) {
  const terms = useStore(s => s.terms);
  const ticket = useStore(s => s.status!.ticket);
  const mode = useStore(s => s.status!.mode);
  const now = useNow(1000);
  const form = useForm({
    activeTerm: settings.activeTerm ?? "",
    ticketAt: isoToChicagoLocal(settings.ticketAt),
    ticketAuto: settings.ticketAuto,
  });
  const action = useAction();
  const detect = useAction();
  const [found, setFound] = useState<string | null>(null);

  const savedLocal = isoToChicagoLocal(settings.ticketAt);

  async function save() {
    const iso = form.value.ticketAt ? chicagoLocalToIso(form.value.ticketAt) : null;
    if (form.value.ticketAt && !iso) {
      action.setError("Enter a full date and time.");
      return false;
    }
    const patch: SettingsPatch = { activeTerm: form.value.activeTerm || null };
    // Only send the ticket when it was edited, so a round trip through the minute-precision field never reads as a manual change.
    if (form.value.ticketAt !== savedLocal) patch.ticketAt = iso;
    if (form.value.ticketAuto !== settings.ticketAuto || patch.ticketAt !== undefined) patch.ticketAuto = form.value.ticketAuto;
    const next = await action.run("save", () => saveSettings(patch));
    if (!next) return false;
    form.commit({ activeTerm: next.activeTerm ?? "", ticketAt: isoToChicagoLocal(next.ticketAt), ticketAuto: next.ticketAuto });
    return true;
  }
  usePending("term", { dirty: form.dirty, save, reset: () => (form.reset(), action.setError(null)) });

  async function checkNow() {
    const term = form.value.activeTerm || settings.activeTerm;
    if (!term) return;
    setFound(null);
    const res = await detect.run("detect", () => api.detectTicket(term));
    if (res && res.found && !res.applied && res.ticketAt) setFound(res.ticketAt);
  }

  const ticketMs = settings.ticketAt ? new Date(settings.ticketAt).getTime() : null;
  const ticketEdited = form.value.ticketAt !== savedLocal;
  const checkedHere = settings.ticketCheckedAt !== null && settings.ticketCheckedTerm === settings.activeTerm && !ticketEdited;
  const source =
    checkedHere && settings.ticketSource === "banner" && settings.ticketAt
      ? `From Banner, checked ${formatCheck(settings.ticketCheckedAt!, now)}`
      : checkedHere && !settings.ticketAt
        ? `Checked ${formatCheck(settings.ticketCheckedAt!, now)}, no ticket posted yet`
        : null;

  return (
    <Card id="ticket" className="scroll-mt-20">
      <CardBody>
        <CardTitle>Term and time ticket</CardTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Active term" htmlFor="active-term">
            <Select
              id="active-term"
              value={form.value.activeTerm || undefined}
              onValueChange={activeTerm => form.set({ activeTerm })}
              placeholder="Choose a term"
              options={terms.map(t => ({ value: t.code, label: t.description }))}
            />
          </Field>
          <Field
            label="Time ticket"
            htmlFor="ticket-at"
            hint={
              <span className="flex flex-col gap-0.5">
                <span>Central time</span>
                {source && <span id="ticket-source">{source}</span>}
              </span>
            }
          >
            <div className="flex gap-2">
              <Input
                id="ticket-at"
                type="datetime-local"
                aria-describedby={source ? "ticket-source" : undefined}
                className="font-mono text-[0.8125rem] tabular-nums"
                value={form.value.ticketAt}
                onChange={e => form.set({ ticketAt: e.target.value, ticketAuto: false })}
              />
              {form.value.ticketAt && (
                <Button variant="ghost" size="sm" className="h-9" onClick={() => form.set({ ticketAt: "", ticketAuto: false })}>
                  Clear
                </Button>
              )}
            </div>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <label className="flex min-w-0 items-center gap-3">
            <Switch
              checked={form.value.ticketAuto}
              onCheckedChange={v => form.set({ ticketAuto: v })}
              aria-describedby="ticket-auto-hint"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Auto detect</span>
              <span id="ticket-auto-hint" className="block text-[0.8125rem] text-fg-muted">
                Reads Banner every 12 hours
              </span>
            </span>
          </label>
          {mode !== "simulated" && (
            <Button size="sm" onClick={checkNow} loading={detect.busy === "detect"} disabled={!(form.value.activeTerm || settings.activeTerm)}>
              {detect.busy !== "detect" && <RefreshCw aria-hidden />}
              Check now
            </Button>
          )}
        </div>
        <InlineError>{detect.error}</InlineError>
        {found && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-black px-3 py-2 text-[0.8125rem]">
            <span className="flex-1 text-fg-muted">
              Banner shows <span className="font-mono text-fg tabular-nums">{formatDateTime(found)}</span>
            </span>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                form.set({ ticketAt: isoToChicagoLocal(found), ticketAuto: true });
                setFound(null);
              }}
            >
              Use it
            </Button>
          </div>
        )}
      </CardBody>
      <CardNote
        error={action.error}
        note={
          ticketMs && ticketMs > now ? (
            <span className="tabular-nums">
              Opens in <span className="font-mono text-fg">{countdown(ticketMs, now)}</span>
              {ticket.phase === "prewarm" && " and the session is warming up"}
            </span>
          ) : null
        }
      />
    </Card>
  );
}

/** "2:14 PM" today, "Oct 27 at 2:14 PM" otherwise, Central time. */
function formatCheck(ts: number, now: number) {
  const day = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "short" }).format(t);
  if (day(ts) === day(now))
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(ts);
  return formatDateTime(ts);
}

// ---------- Notifications ----------

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type PushState = "unsupported" | "denied" | "off" | "on" | "checking";

function usePushState(): [PushState, (s: PushState) => void] {
  const [state, setState] = useState<PushState>("checking");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then(reg => reg?.pushManager.getSubscription())
      .then(sub => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);
  return [state, setState];
}

/** Mirrors the server check: discord.com or discordapp.com, optionally ptb or canary. */
const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function NotificationsCard({ settings }: { settings: PublicSettings }) {
  const form = useForm({ userId: settings.discordUserId ?? "", routing: settings.routing });
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [hookReplacing, setHookReplacing] = useState(false);
  const action = useAction();
  const discord = useAction();
  const webhook = useAction();
  const push = useAction();
  const [pushState, setPushState] = usePushState();
  const [confirmRemove, setConfirmRemove] = useState<"token" | "webhook" | null>(null);

  const tokenSet = !!settings.discordTokenHint;
  const tokenEditing = !tokenSet || replacing;
  const hookSet = !!settings.discordWebhookHint;
  const hookEditing = !hookSet || hookReplacing;
  const hookInvalid = hookUrl.trim().length > 0 && !WEBHOOK_URL.test(hookUrl.trim());
  const dirty = form.dirty || token.length > 0 || hookUrl.length > 0;

  async function save() {
    const patch: SettingsPatch = {};
    if (form.value.userId !== (settings.discordUserId ?? "")) {
      if (form.value.userId && !/^\d{17,20}$/.test(form.value.userId)) {
        action.setError("A Discord user ID is 17 to 20 digits.");
        return false;
      }
      patch.discordUserId = form.value.userId || null;
    }
    if (JSON.stringify(form.value.routing) !== JSON.stringify(settings.routing)) patch.routing = form.value.routing;
    if (token) patch.discordToken = token.trim();
    if (hookUrl.trim()) {
      if (hookInvalid) {
        action.setError("Paste a Discord webhook URL, starting with https://discord.com/api/webhooks/");
        return false;
      }
      patch.discordWebhookUrl = hookUrl.trim();
    }
    const next = await action.run("save", () => saveSettings(patch));
    if (!next) return false;
    form.commit({ userId: next.discordUserId ?? "", routing: next.routing });
    setToken("");
    setReplacing(false);
    setHookUrl("");
    setHookReplacing(false);
    return true;
  }
  const reset = () => {
    form.reset();
    setToken("");
    setReplacing(false);
    setHookUrl("");
    setHookReplacing(false);
    action.setError(null);
  };
  usePending("notifications", { dirty, save, reset });

  async function test(channel: "discord" | "push" | "webhook") {
    const a = channel === "discord" ? discord : channel === "webhook" ? webhook : push;
    const res = await a.run("test", () => api.testNotify(channel));
    if (res) a.setMessage({ ok: res.ok, text: res.detail });
  }

  async function enablePush() {
    await push.run("enable", async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "off");
        throw new Error(permission === "denied" ? "Notifications are blocked for this site in your browser." : "Permission was not granted.");
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await api.vapid();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.pushSubscribe(sub.toJSON());
      setPushState("on");
    });
  }

  async function disablePush() {
    await push.run("disable", async () => {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setPushState("off");
    });
  }

  const setRoute = (event: NotifyEvent, channel: keyof Route, on: boolean) =>
    form.set({ routing: { ...form.value.routing, [event]: { ...form.value.routing[event], [channel]: on } } });

  const guardRoute = form.value.routing.guard_tripped;
  const guardNowhere = !guardRoute?.discord && !guardRoute?.push && !guardRoute?.webhook;

  return (
    <Card id="notifications" className="scroll-mt-20">
      <CardBody className="gap-6">
        <CardTitle>Notifications</CardTitle>

        <section aria-labelledby="discord-title" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h3 id="discord-title" className="text-sm font-medium">
              Discord DM
            </h3>
            <Status tone={tokenSet && settings.discordUserId ? "ready" : "off"} className="text-xs text-fg-muted">
              {tokenSet && settings.discordUserId ? "Configured" : "Not configured"}
            </Status>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Bot token" htmlFor="discord-token">
              {tokenEditing ? (
                <div className="flex gap-2">
                  <Input
                    id="discord-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={replacing ? "New token" : "Paste bot token"}
                    className="font-mono"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                  />
                  {replacing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9"
                      onClick={() => {
                        setReplacing(false);
                        setToken("");
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex h-9 items-center gap-2">
                  <span id="discord-token" className="flex-1 truncate text-[0.8125rem] text-fg-muted">
                    Set, ends in <span className="font-mono text-fg">{settings.discordTokenHint}</span>
                  </span>
                  <Button variant="secondary" size="xs" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                  <Button variant="destructive" size="xs" onClick={() => setConfirmRemove("token")}>
                    Remove
                  </Button>
                </div>
              )}
            </Field>
            <Field label="Your user ID" htmlFor="discord-user">
              <Input
                id="discord-user"
                inputMode="numeric"
                autoComplete="off"
                placeholder="184392011734581248"
                className="font-mono tabular-nums"
                value={form.value.userId}
                onChange={e => form.set({ userId: e.target.value.replace(/\D/g, "") })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => test("discord")} loading={discord.busy === "test"} disabled={!tokenSet || !settings.discordUserId}>
              {discord.busy !== "test" && <Send aria-hidden />}
              Send test
            </Button>
            <span className="text-xs text-fg-muted">The bot must share a server with you.</span>
          </div>
          <TestResult action={discord} />
        </section>

        <div className="h-px bg-border" />

        <section aria-labelledby="webhook-title" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h3 id="webhook-title" className="text-sm font-medium">
              Discord webhook
            </h3>
            <Status tone={hookSet ? "ready" : "off"} className="text-xs text-fg-muted">
              {hookSet ? "Configured" : "Not set"}
            </Status>
          </div>
          <Field label="Webhook URL" htmlFor="discord-webhook" hint={hookEditing ? "Server Settings, Integrations, Webhooks" : undefined}>
            {hookEditing ? (
              <div className="flex gap-2">
                <Input
                  id="discord-webhook"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hookReplacing ? "New webhook URL" : "https://discord.com/api/webhooks/..."}
                  aria-invalid={hookInvalid || undefined}
                  className="font-mono"
                  value={hookUrl}
                  onChange={e => setHookUrl(e.target.value)}
                />
                {hookReplacing && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9"
                    onClick={() => {
                      setHookReplacing(false);
                      setHookUrl("");
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex h-9 items-center gap-2 sm:max-w-[calc(50%-0.5rem)]">
                <span id="discord-webhook" className="flex-1 truncate text-[0.8125rem] text-fg-muted">
                  Set, ends in <span className="font-mono text-fg">{settings.discordWebhookHint}</span>
                </span>
                <Button variant="secondary" size="xs" onClick={() => setHookReplacing(true)}>
                  Replace
                </Button>
                <Button variant="destructive" size="xs" onClick={() => setConfirmRemove("webhook")}>
                  Remove
                </Button>
              </div>
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => test("webhook")} loading={webhook.busy === "test"} disabled={!hookSet}>
              {webhook.busy !== "test" && <Send aria-hidden />}
              Send test
            </Button>
          </div>
          <TestResult action={webhook} />
        </section>

        <div className="h-px bg-border" />

        <section aria-labelledby="push-title" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h3 id="push-title" className="text-sm font-medium">
              Browser push
            </h3>
            <Status
              tone={pushState === "on" ? "ready" : pushState === "denied" ? "error" : "off"}
              className="text-xs text-fg-muted"
            >
              {
                {
                  on: "On for this browser",
                  off: "Off",
                  denied: "Blocked by browser",
                  unsupported: "Not supported here",
                  checking: "Checking",
                }[pushState]
              }
            </Status>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pushState === "on" ? (
              <Button size="sm" variant="secondary" onClick={disablePush} loading={push.busy === "disable"}>
                Turn off
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={enablePush}
                loading={push.busy === "enable"}
                disabled={pushState === "unsupported" || pushState === "checking"}
              >
                {push.busy !== "enable" && <Bell aria-hidden />}
                Enable
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => test("push")} loading={push.busy === "test"} disabled={pushState !== "on"}>
              {push.busy !== "test" && <Send aria-hidden />}
              Send test
            </Button>
          </div>
          {pushState === "unsupported" && (
            <p className="text-xs text-fg-muted">On iPhone, add this site to your Home Screen first.</p>
          )}
          <TestResult action={push} />
        </section>

        <div className="h-px bg-border" />

        <section aria-labelledby="routing-title" className="flex flex-col gap-3">
          <h3 id="routing-title" className="text-sm font-medium">
            Routing
          </h3>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full border-collapse text-[0.8125rem]">
              <thead className="border-b border-border bg-black text-xs text-fg-muted">
                <tr className="h-9">
                  <th scope="col" className="px-3 text-left font-normal">
                    Event
                  </th>
                  <th scope="col" className="w-14 py-1.5 text-center font-normal leading-tight sm:w-24">
                    Discord DM
                  </th>
                  <th scope="col" className="w-16 py-1.5 text-center font-normal leading-tight sm:w-24">
                    Webhook
                  </th>
                  <th scope="col" className="w-12 py-1.5 text-center font-normal leading-tight sm:w-24">
                    Push
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-border">
                {NOTIFY_EVENTS.map(event => {
                  const route = form.value.routing[event] ?? { discord: false, push: false, webhook: false };
                  return (
                    <tr key={event} className="h-10 transition-colors duration-150 hover:bg-hover">
                      <th scope="row" id={`route-${event}`} className="px-3 py-2 text-left font-normal leading-snug">
                        {notifyLabels[event]}
                      </th>
                      <td className="text-center">
                        <Checkbox
                          checked={route.discord}
                          onCheckedChange={v => setRoute(event, "discord", v === true)}
                          aria-label={`${notifyLabels[event]} to Discord DM`}
                        />
                      </td>
                      <td className="text-center">
                        <Checkbox
                          checked={route.webhook ?? false}
                          onCheckedChange={v => setRoute(event, "webhook", v === true)}
                          aria-label={`${notifyLabels[event]} to Discord webhook`}
                        />
                      </td>
                      <td className="text-center">
                        <Checkbox
                          checked={route.push}
                          onCheckedChange={v => setRoute(event, "push", v === true)}
                          aria-label={`${notifyLabels[event]} to push`}
                        />
                      </td>
                    </tr>
                  );
                })}
                {guardNowhere && (
                  <tr className="bg-[#140e02]">
                    <td colSpan={4} className="px-3 py-2.5 text-[0.8125rem] text-warning">
                      <span className="inline-flex items-start gap-2">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                        A tripped safety guard will not reach you anywhere but this page.
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </CardBody>
      <CardNote error={action.error} />
      <ConfirmDialog
        open={confirmRemove === "token"}
        onOpenChange={o => setConfirmRemove(o ? "token" : null)}
        title="Remove the Discord bot token?"
        description="Discord notifications and the Register buttons in DMs stop working until you add a token again."
        confirmLabel="Remove token"
        onConfirm={() => saveSettings({ discordToken: null })}
      />
      <ConfirmDialog
        open={confirmRemove === "webhook"}
        onOpenChange={o => setConfirmRemove(o ? "webhook" : null)}
        title="Remove the Discord webhook?"
        description="Webhook notifications stop until you add one again."
        confirmLabel="Remove webhook"
        onConfirm={() => saveSettings({ discordWebhookUrl: null })}
      />
    </Card>
  );
}

function TestResult({ action }: { action: ReturnType<typeof useAction> }) {
  if (action.error) return <InlineError>{action.error}</InlineError>;
  if (!action.message) return null;
  return (
    <p role="status" className={cn("inline-flex items-center gap-2 text-[0.8125rem]", action.message.ok ? "text-ready" : "text-error-fg")}>
      {action.message.ok ? <CircleCheck className="size-4" aria-hidden /> : <CircleX className="size-4" aria-hidden />}
      {action.message.text}
    </p>
  );
}

// ---------- Session ----------

function SessionCard() {
  const session = useStore(s => s.status!.session);
  const action = useAction();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const signedOut = session.state === "cold" || session.state === "error";
  const stateLabel = {
    cold: session.loggedOut ? "Logged out" : "Cold",
    logging_in: session.stage ?? "Logging in",
    warm: "Warm",
    error: "Error",
  }[session.state];

  return (
    <Card id="session" className="scroll-mt-20">
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Session</CardTitle>
          <Status
            tone={session.state === "warm" ? "ready" : session.state === "error" ? "error" : session.state === "logging_in" ? "warning" : "off"}
            className="text-[0.8125rem]"
          >
            {stateLabel}
          </Status>
        </div>
        {session.lastError && <InlineError>{session.lastError}</InlineError>}
      </CardBody>
      <CardFooter>
        <div className="min-w-0 flex-1">
          <InlineError>{action.error}</InlineError>
        </div>
        <div className="flex flex-wrap gap-2">
          {signedOut && (
            <Button size="sm" onClick={() => action.run("login", api.login)} loading={action.busy === "login"}>
              {action.busy !== "login" && <LogIn aria-hidden />}
              Log in
            </Button>
          )}
          {session.state === "logging_in" ? (
            <Button size="sm" variant="secondary" onClick={() => action.run("cancel", api.logout)} loading={action.busy === "cancel"}>
              {action.busy !== "cancel" && <X aria-hidden />}
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setConfirmLogout(true)} disabled={session.state !== "warm"}>
              <LogOut aria-hidden />
              Log out
            </Button>
          )}
        </div>
      </CardFooter>
      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="Log out of Banner?"
        description="The app stays logged out until you log in again. It still logs in on its own when a seat opens for an armed course or your time ticket is 10 minutes away."
        confirmLabel="Log out"
        onConfirm={api.logout}
      />
    </Card>
  );
}

// ---------- Test (internally "rehearsal") ----------

type TestReport = RehearsalReport;

function stepLabel(name: string): string {
  if (name === "login") return "Log in";
  if (name === "term_open") return "Term open for registration";
  if (name === "read_schedule") return "Read your schedule";
  if (name === "no_writes") return "Nothing submitted";
  if (name === "time_ticket") return "Time ticket";
  const crn = /^crn_(\d+)$/.exec(name);
  if (crn) return `CRN ${crn[1]} exists`;
  return name;
}

function TestCard({ term }: { term: string | null }) {
  const action = useAction();
  const [report, setReport] = useState<TestReport | null>(null);
  const terms = useStore(s => s.terms);

  async function run() {
    if (!term) return;
    const r = await action.run("run", () => api.rehearsal(term));
    if (r) setReport(r as TestReport);
  }

  const readerTerm = report?.readerTerm ?? report?.term ?? term;
  const readerName = termName(terms, readerTerm);
  const opensAt = report?.opensAt ?? null;
  const classes = report?.schedule?.length ?? 0;

  return (
    <Card id="test" className="scroll-mt-20">
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Test</CardTitle>
          {report && (
            <Status tone={report.ok ? "ready" : "error"} className="text-[0.8125rem]">
              {report.ok ? "Passed" : "Failed"}
            </Status>
          )}
        </div>
        <p className="text-[0.8125rem] text-fg-muted">
          Logs in and walks the registration path for {termName(terms, term)} without submitting anything.
        </p>
        {action.busy === "run" && (
          <p role="status" className="text-[0.8125rem] text-fg-muted">
            Running. This takes about 20 seconds.
          </p>
        )}
        {report && opensAt && (
          <p role="status" className="rounded-md border border-border bg-black px-3 py-2.5 text-[0.8125rem] text-fg">
            Registration opens <span className="tabular-nums">{formatDateTime(opensAt)}</span>.
            {report.schedule && readerTerm !== report.term && (
              <span className="text-fg-muted">
                {" "}
                Your schedule reader was checked on {readerName} ({classes} {classes === 1 ? "class" : "classes"}).
              </span>
            )}
          </p>
        )}
        {report && (
          <div className="flex flex-col gap-3">
            <ol className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
              {report.steps.map((step, i) => (
                <li key={i} className="flex items-center gap-3 bg-black px-3 py-2.5 text-[0.8125rem]">
                  {step.ok ? (
                    <CircleCheck className="size-4 shrink-0 text-ready" aria-label="Passed" />
                  ) : (
                    <CircleX className="size-4 shrink-0 text-error-fg" aria-label="Failed" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block">{stepLabel(step.name)}</span>
                    {step.detail && <span className={cn("block text-xs", step.ok ? "text-fg-muted" : "text-error-fg")}>{step.detail}</span>}
                  </span>
                  <span className="font-mono text-xs text-fg-subtle tabular-nums">{(step.ms / 1000).toFixed(1)}s</span>
                </li>
              ))}
            </ol>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[0.8125rem]">
              {report.eligibility && (
                <>
                  <dt className="text-fg-muted">Eligibility</dt>
                  <dd>{report.eligibility.allowed ? "Allowed" : report.eligibility.messages.join(" ") || "Not allowed"}</dd>
                </>
              )}
              {report.schedule && (
                <>
                  <dt className="text-fg-muted">{readerName} classes</dt>
                  <dd className="font-mono tabular-nums">{report.schedule.join(", ") || "None"}</dd>
                </>
              )}
              <dt className="text-fg-muted">Writes blocked</dt>
              <dd className={cn("font-mono tabular-nums", report.blockedWrites > 0 && "text-warning")}>{report.blockedWrites}</dd>
            </dl>
            {report.crnChecks.some(c => !c.exists) && (
              <InlineError>
                Missing CRNs: {report.crnChecks.filter(c => !c.exists).map(c => c.crn).join(", ")}
              </InlineError>
            )}
          </div>
        )}
      </CardBody>
      <CardFooter>
        <div className="min-w-0 flex-1">
          <InlineError>{action.error}</InlineError>
        </div>
        <Button size="sm" variant="primary" onClick={run} loading={action.busy === "run"} disabled={!term}>
          Run test
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------- Simulator ----------

const SIM_ERRORS = [
  "Closed Section",
  "Time Conflict with CRN 31110",
  "Prerequisite and Test Score Error",
  "Major Restriction",
  "Maximum Hours Exceeded",
  "Registration is not open at this time",
  "Linked course required",
];

function SimulatorCard({ term }: { term: string | null }) {
  const wanted = useStore(s => s.wanted);
  const seats = useStore(s => s.seats);
  const [sim, setSim] = useState<SimState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const load = useAction();
  const action = useAction();
  const [errorCrn, setErrorCrn] = useState<string>("any");
  const [errorMsg, setErrorMsg] = useState<string>(SIM_ERRORS[0]!);

  const armedCrns = [...new Set(wanted.filter(w => w.armed && w.term === term).flatMap(w => w.bundles.flatMap(b => b.crns)))];

  async function refresh() {
    const r = await load.run("load", api.sim);
    if (r) setSim(r);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setSeats(crn: string, available: number) {
    if (!term) return;
    await action.run(`seat-${crn}`, () => api.simSeats({ term, crn, available }));
    setDrafts(d => {
      const { [crn]: _, ...rest } = d;
      return rest;
    });
  }

  const schedule = term && sim ? sim.schedule[term] ?? [] : [];

  return (
    <Card id="simulator" className="scroll-mt-20 border-dashed border-border-strong">
      <CardBody>
        <CardTitle>Simulator</CardTitle>
        <div className="flex flex-col gap-2">
          <h3 className="text-[0.8125rem] font-medium">Armed CRNs</h3>
          {armedCrns.length === 0 ? (
            <p className="text-[0.8125rem] text-fg-muted">Arm a course to control its seats here.</p>
          ) : (
            <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
              {armedCrns.map(crn => {
                const seat = term ? seats[`${term}:${crn}`] : undefined;
                const value = drafts[crn] ?? String(seat?.available ?? 0);
                const busy = action.busy === `seat-${crn}`;
                return (
                  <li key={crn} className="flex flex-wrap items-center gap-3 bg-black px-3 py-2">
                    <span className="w-14 font-mono text-[0.8125rem] tabular-nums">{crn}</span>
                    <SeatCount seat={seat} className="w-24" />
                    <div className="ml-auto flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        aria-label={`Seats for ${crn}`}
                        className="h-8 w-16 tabular-nums"
                        value={value}
                        onChange={e => setDrafts(d => ({ ...d, [crn]: e.target.value }))}
                        onKeyDown={e => e.key === "Enter" && setSeats(crn, Math.max(0, Number(value) || 0))}
                      />
                      <Button size="xs" variant="secondary" disabled={busy} onClick={() => setSeats(crn, Math.max(1, Number(value) || 1))}>
                        Open
                      </Button>
                      <Button size="xs" variant="secondary" disabled={busy} onClick={() => setSeats(crn, 0)}>
                        Close
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[0.8125rem] font-medium">Script next error</h3>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              aria-label="CRN"
              mono
              className="sm:w-32"
              value={errorCrn}
              onValueChange={setErrorCrn}
              options={[{ value: "any", label: "Any CRN" }, ...armedCrns.map(c => ({ value: c, label: c }))]}
            />
            <Select
              aria-label="Banner message"
              value={errorMsg}
              onValueChange={setErrorMsg}
              options={SIM_ERRORS.map(m => ({ value: m, label: m }))}
            />
            <Button
              size="default"
              variant="secondary"
              loading={action.busy === "error"}
              onClick={async () => {
                const ok = await action.run("error", () => api.simError({ crn: errorCrn === "any" ? null : errorCrn, message: errorMsg }));
                if (ok) action.setMessage({ ok: true, text: "Next attempt will fail with that message" });
              }}
            >
              Script
            </Button>
          </div>
          {action.message && <p role="status" className="text-[0.8125rem] text-fg-muted">{action.message.text}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[0.8125rem] font-medium">Simulated schedule</h3>
          {load.error ? (
            <InlineError>{load.error}</InlineError>
          ) : !sim ? (
            <p className="text-[0.8125rem] text-fg-muted">Loading</p>
          ) : schedule.length === 0 ? (
            <p className="text-[0.8125rem] text-fg-muted">Empty</p>
          ) : (
            <p className="flex flex-wrap gap-1.5">
              {schedule.map(crn => (
                <span key={crn} className="inline-flex h-6 items-center rounded-full border border-border-strong px-2.5 font-mono text-xs tabular-nums">
                  {crn}
                </span>
              ))}
            </p>
          )}
        </div>
      </CardBody>
      <CardFooter>
        <div className="min-w-0 flex-1">
          <InlineError>{action.error}</InlineError>
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} loading={load.busy === "load"}>
          Refresh
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------- page ----------

export function SettingsPage() {
  const settings = useStore(s => s.settings);
  const mode = useStore(s => s.status!.mode);
  const { registry, dirtyEntries } = usePendingRegistry();

  useEffect(() => {
    if (!location.hash) return;
    // #rehearsal is the card's old anchor.
    const id = location.hash.slice(1) === "rehearsal" ? "test" : location.hash.slice(1);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, []);

  if (!settings) return null;
  return (
    <PendingContext.Provider value={registry}>
      <div className="flex flex-col gap-6 pb-20">
        <PageHeader title="Settings" />
        <div className="flex max-w-3xl flex-col gap-6">
          <RegistrationCard settings={settings} />
          <PollingCard settings={settings} />
          <TermCard settings={settings} />
          <NotificationsCard settings={settings} />
          <SessionCard />
          {(mode === "rehearsal" || mode === "live") && <TestCard term={settings.activeTerm} />}
          {mode === "simulated" && <SimulatorCard term={settings.activeTerm} />}
        </div>
      </div>
      <UnsavedBar entries={dirtyEntries} />
    </PendingContext.Provider>
  );
}
