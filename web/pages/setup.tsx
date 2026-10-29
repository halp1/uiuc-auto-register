import { ArrowRight, Bell, Check, ExternalLink, Hash, KeyRound, MessageSquare, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RehearsalReport } from "../../src/core/contracts";
import { NOTIFY_EVENTS, type AuthMode, type NotifyEvent, type OnboardingStep, type PublicSettings, type SettingsPatch } from "../../src/core/types";
import { ConfirmDialog } from "@/components/confirm";
import {
  CopyCode,
  CredentialFields,
  credentialPatch,
  credentialsComplete,
  type CredentialDraft,
} from "@/components/credentials";
import { AppMark } from "@/components/mode";
import { NewPasswordFields, RecoveryCodes, newPasswordValid } from "@/components/security";
import { TestReportView } from "@/components/test-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { InlineError } from "@/components/ui/list";
import { Select } from "@/components/ui/select";
import { Dot, Status } from "@/components/ui/status-dot";
import { api } from "@/lib/api";
import { passkeysSupported, setAuthStatus, useAuthStatus } from "@/lib/auth";
import { isPasskeyCancel, registerPasskey } from "@/lib/passkey";
import { termName } from "@/lib/format";
import { useModeSwitch } from "@/lib/mode-switch";
import { disablePush, enablePush, isIos, pushStateFromError, usePushState } from "@/lib/push";
import { hrefWithMock, linkClick, navigate } from "@/lib/router";
import { local, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

type Step = Exclude<OnboardingStep, "done">;

const STEPS: { id: Step; label: string }[] = [
  { id: "security", label: "Security" },
  { id: "account", label: "Account" },
  { id: "login", label: "Log in" },
  { id: "test", label: "Test" },
  { id: "live", label: "Live" },
  { id: "notify", label: "Notifications" },
];

const NEXT: Record<Step, OnboardingStep> = { security: "account", account: "login", login: "test", test: "live", live: "notify", notify: "done" };

/** Move the saved onboarding step forward (never backward when revisiting earlier steps). */
async function advance(from: Step, settings: PublicSettings) {
  const order = STEPS.map(s => s.id as OnboardingStep).concat("done");
  const next = NEXT[from];
  if (order.indexOf(next) > order.indexOf(settings.onboardingStep)) {
    const saved = await api.setupStep(next);
    local.settings(saved);
  }
  if (next !== "done") navigate(`/setup/${next}`);
}

// ---------- layout ----------

export function SetupPage({ step }: { step: OnboardingStep }) {
  const settings = useStore(s => s.settings)!;
  const current = step === "done" ? "notify" : step;
  const reached = STEPS.findIndex(s => s.id === settings.onboardingStep);
  const index = STEPS.findIndex(s => s.id === current);

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex h-14 items-center gap-2.5 border-b border-border px-4 sm:px-6">
        <AppMark />
        <span className="text-sm font-semibold">Auto Register</span>
        <span className="ml-auto text-xs text-fg-muted tabular-nums">
          Step {index + 1} of {STEPS.length}
        </span>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 md:flex-row md:gap-12 md:pt-12">
        <nav aria-label="Setup steps" className="shrink-0 md:w-44">
          <ol className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5">
            {STEPS.map((s, i) => {
              const done = reached > i || settings.onboardingStep === "done";
              const active = s.id === current;
              const reachable = i <= reached;
              const body = (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums transition-colors duration-150",
                      active ? "border-fg bg-fg text-black" : done ? "border-[#1d4d43] bg-[#06150f] text-ready" : "border-border-strong text-fg-subtle",
                    )}
                  >
                    {done && !active ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn("whitespace-nowrap", active ? "text-fg" : reachable ? "text-fg-muted" : "text-fg-subtle", "max-md:sr-only max-md:[[aria-current]_&]:not-sr-only")}>
                    {s.label}
                  </span>
                </>
              );
              const cls = "flex h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-150";
              return (
                <li key={s.id}>
                  {reachable && !active ? (
                    <a href={hrefWithMock(`/setup/${s.id}`)} onClick={linkClick(`/setup/${s.id}`)} className={cn(cls, "hover:bg-surface-2")}>
                      {body}
                    </a>
                  ) : (
                    <span aria-current={active ? "step" : undefined} aria-disabled={!reachable || undefined} className={cn(cls, active && "bg-selected")}>
                      {body}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="w-full min-w-0 max-w-[560px]">
          {current === "security" && <SecurityStep settings={settings} />}
          {current === "account" && <AccountStep settings={settings} />}
          {current === "login" && <LoginStep settings={settings} />}
          {current === "test" && <TestStep settings={settings} />}
          {current === "live" && <LiveStep settings={settings} />}
          {current === "notify" && <NotifyStep settings={settings} />}
        </main>
      </div>
    </div>
  );
}

function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
      {children && <p className="max-w-[60ch] text-sm text-fg-muted">{children}</p>}
    </div>
  );
}

function StepFooter({ children, error }: { children: ReactNode; error?: string | null }) {
  return (
    <div className="mt-8 flex flex-col gap-3 border-t border-border pt-5">
      <InlineError>{error}</InlineError>
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function ContinueButton({ onClick, disabled, loading, children = "Continue" }: { onClick: () => void; disabled?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <Button variant="primary" onClick={onClick} disabled={disabled} loading={loading}>
      {children}
      {!loading && <ArrowRight aria-hidden />}
    </Button>
  );
}

function Guide({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2.5 text-[0.8125rem] text-fg-muted">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-[0.6875rem] text-fg-muted tabular-nums">
            {i + 1}
          </span>
          <span className="min-w-0 pt-px leading-relaxed [&_b]:font-medium [&_b]:text-fg">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-fg underline decoration-border-hover underline-offset-2 transition-colors duration-150 hover:decoration-fg"
    >
      {children}
      <ExternalLink className="size-3 text-fg-muted" aria-hidden />
    </a>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded border border-border-strong bg-black px-1 font-mono text-[0.75rem] text-fg">{children}</code>;
}

// ---------- security ----------

function ChoiceCard({
  selected,
  onSelect,
  title,
  badge,
  description,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-surface transition-colors duration-150", selected ? "border-border-hover" : "border-border")}>
      <label className="flex cursor-pointer items-start gap-3 p-4 transition-colors duration-150 hover:bg-hover">
        <input type="radio" name="auth-mode" checked={selected} onChange={onSelect} className="peer sr-only" />
        <span
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
            selected ? "border-fg" : "border-border-hover",
          )}
        >
          {selected && <span className="size-2 rounded-full bg-fg" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {title}
            {badge && <Badge variant="muted" className="h-5 px-2 text-[0.6875rem]">{badge}</Badge>}
          </span>
          <span className="mt-0.5 block text-[0.8125rem] text-fg-muted">{description}</span>
        </span>
      </label>
      {selected && children && <div className="flex flex-col gap-4 border-t border-border bg-black p-4">{children}</div>}
    </div>
  );
}

type SecurityPhase = "choose" | "codes" | "passkey";

function SecurityStep({ settings }: { settings: PublicSettings }) {
  const auth = useAuthStatus();
  const [choice, setChoice] = useState<AuthMode | null>(auth?.mode ?? null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phase, setPhase] = useState<SecurityPhase>("choose");
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passkeyAdded, setPasskeyAdded] = useState<string | null>(null);
  const already = auth?.mode != null;

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (!isPasskeyCancel(e)) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const next = () => run("next", () => advance("security", settings));

  const configure = () =>
    run("configure", async () => {
      if (choice === "none") {
        const res = await api.authConfigure({ mode: "none" });
        setAuthStatus(res.status);
        await advance("security", settings);
        return;
      }
      if (!newPasswordValid(password, confirm)) return;
      const res = await api.authConfigure({ mode: "password", password, remember: true });
      setAuthStatus(res.status);
      setPassword("");
      setConfirm("");
      setCodes(res.recoveryCodes ?? []);
      setPhase(res.recoveryCodes?.length ? "codes" : passkeysSupported() ? "passkey" : "choose");
      if (!res.recoveryCodes?.length && !passkeysSupported()) await advance("security", settings);
    });

  if (phase === "codes")
    return (
      <section>
        <StepHeader title="Save your recovery codes">Each code works once if you forget your password. They won't be shown again.</StepHeader>
        <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
        <StepFooter error={error}>
          <ContinueButton
            disabled={!saved}
            loading={busy === "next"}
            onClick={() => (passkeysSupported() ? setPhase("passkey") : next())}
          />
        </StepFooter>
      </section>
    );

  if (phase === "passkey")
    return (
      <section>
        <StepHeader title="Add a passkey">Sign in with your fingerprint, face, or device PIN instead of typing the password.</StepHeader>
        {passkeyAdded ? (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-[#1d4d43] bg-[#06150f] p-4 text-sm">
            <Check className="size-4 text-ready" aria-hidden />
            Added {passkeyAdded}.
          </div>
        ) : (
          <Button variant="primary" onClick={() => run("passkey", async () => setPasskeyAdded((await registerPasskey()).name))} loading={busy === "passkey"}>
            {busy !== "passkey" && <KeyRound aria-hidden />}
            Add a passkey
          </Button>
        )}
        <StepFooter error={error}>
          {passkeyAdded ? (
            <ContinueButton onClick={next} loading={busy === "next"} />
          ) : (
            <Button variant="ghost" onClick={next} disabled={busy !== null}>
              Skip
            </Button>
          )}
        </StepFooter>
      </section>
    );

  return (
    <section>
      <StepHeader title="Protect this app">This app can sign in to Banner as you. Anyone who opens it can change your classes.</StepHeader>
      {already ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Check className="size-4 text-ready" aria-hidden />
            {auth?.mode === "password" ? "Password" : "No password"}
          </p>
          <p className="text-[0.8125rem] text-fg-muted">Change in Settings later</p>
        </div>
      ) : (
        <div role="radiogroup" aria-label="Protection" className="flex flex-col gap-3">
          <ChoiceCard
            selected={choice === "password"}
            onSelect={() => setChoice("password")}
            title="Password"
            badge="Recommended"
            description="You'll sign in with a password. You can add a passkey after."
          >
            <form
              id="security-form"
              onSubmit={e => {
                e.preventDefault();
                configure();
              }}
            >
              <NewPasswordFields idPrefix="setup-auth" password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} autoFocus />
            </form>
          </ChoiceCard>
          <ChoiceCard
            selected={choice === "none"}
            onSelect={() => setChoice("none")}
            title="No password"
            description="Anyone who can open this page can use it. Fine if only you can reach it, like on your own computer."
          />
        </div>
      )}
      <StepFooter error={error}>
        {already ? (
          <ContinueButton onClick={next} loading={busy === "next"} />
        ) : (
          <ContinueButton
            onClick={configure}
            loading={busy === "configure"}
            disabled={!choice || (choice === "password" && !newPasswordValid(password, confirm))}
          />
        )}
      </StepFooter>
    </section>
  );
}

// ---------- a) account ----------

function AccountStep({ settings }: { settings: PublicSettings }) {
  const [draft, setDraft] = useState<CredentialDraft>({ netid: settings.netid ?? "", password: "", totpSecret: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = credentialsComplete(draft, settings);

  async function next() {
    setBusy(true);
    setError(null);
    try {
      const patch = credentialPatch(draft, settings);
      if (Object.keys(patch).length) local.settings(await api.credentials(patch));
      await advance("account", settings);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="account-title">
      <div id="account-title">
        <StepHeader title="Your Illinois account" />
      </div>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (complete) next();
        }}
      >
        <CredentialFields
          idPrefix="setup"
          settings={settings}
          draft={draft}
          onChange={patch => setDraft(d => ({ ...d, ...patch }))}
          keyGuide={
            <div className="mb-2 rounded-lg border border-border bg-surface p-4">
              <Guide
                items={[
                  <>
                    Open <ExtLink href="https://mysignins.microsoft.com/security-info">mysignins.microsoft.com/security-info</ExtLink> and sign in.
                  </>,
                  <>
                    Choose <b>Add sign-in method</b>, then <b>Microsoft Authenticator</b>. Pick the plain one, not "Passkey in Microsoft
                    Authenticator".
                  </>,
                  <>
                    Choose <b>I want to use a different authenticator app</b>, then <b>Next</b>.
                  </>,
                  <>
                    Choose <b>Can't scan image?</b> and copy the secret key.
                  </>,
                  <>Paste the key here. A 6-digit code shows up below.</>,
                  <>
                    Choose <b>Next</b> on the Microsoft page and type that code.
                  </>,
                ]}
              />
            </div>
          }
        />
        <StepFooter error={error}>
          <ContinueButton onClick={next} disabled={!complete} loading={busy} />
        </StepFooter>
      </form>
    </section>
  );
}

// ---------- b) login ----------

const BROWSER_REASONS = new Set([
  "security_info_required",
  "password_change_required",
  "access_blocked",
  "captcha_required",
  "passkey_required",
  "unsupported_mfa_method",
]);

function BackToAccount({ children }: { children: ReactNode }) {
  return (
    <a
      href={hrefWithMock("/setup/account")}
      onClick={linkClick("/setup/account")}
      className="font-medium text-fg underline decoration-border-hover underline-offset-2 hover:decoration-fg"
    >
      {children}
    </a>
  );
}

function LoginFailure({ reason }: { reason: string }) {
  let body: ReactNode;
  if (reason === "browser_launch_failed")
    body = (
      <>
        Chrome couldn't start. This almost always means the container needs one more permission. Add <CopyCode text="--cap-add=SYS_ADMIN" /> to your
        docker run command, or in Coolify open Configuration, General, Custom Docker Options and add it there. Then restart the app.
      </>
    );
  else if (reason === "password_rejected")
    body = (
      <>
        Microsoft rejected the password. <BackToAccount>Change it</BackToAccount>
      </>
    );
  else if (reason === "totp_rejected")
    body = (
      <>
        Microsoft rejected the code. Check that you finished adding the authenticator on the Microsoft page and that the key is right.{" "}
        <BackToAccount>Check the key</BackToAccount>
      </>
    );
  else if (BROWSER_REASONS.has(reason))
    body = <>Microsoft wants you to finish something in your own browser first. Sign in at mysignins.microsoft.com, then try again.</>;
  else if (reason === "missing_credentials")
    body = (
      <>
        Add your account first. <BackToAccount>Go to Account</BackToAccount>
      </>
    );
  else
    body = (
      <>
        Login didn't finish. <span className="font-mono text-[0.8125rem] text-error-fg">{reason}</span>
      </>
    );
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-[#5c1f1f] bg-[#130606] p-4 text-sm leading-relaxed text-fg">
      <Dot tone="error" className="mt-1.5" />
      <p className="min-w-0">{body}</p>
    </div>
  );
}

function LoginStep({ settings }: { settings: PublicSettings }) {
  const status = useStore(s => s.status)!;
  const mode = useModeSwitch();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: true } | { ok: false; reason: string } | null>(
    status.session.state === "warm" ? { ok: true } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function tryLogin() {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await api.setupLogin());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  async function next() {
    setBusy(true);
    try {
      await advance("login", settings);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (status.mode === "simulated" || mode.switching)
    return (
      <section>
        <StepHeader title="Check the login" />
        <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-surface p-5">
          {mode.switching ? (
            <Status tone="warning" pulse className="text-sm">
              Restarting
            </Status>
          ) : (
            <p className="text-sm">The app is in Simulated mode, so it won't log in.</p>
          )}
          <Button variant="primary" size="sm" onClick={() => mode.switchTo("live")} loading={mode.switching} disabled={mode.switching}>
            Switch to Live
          </Button>
          <InlineError>{mode.error}</InlineError>
        </div>
      </section>
    );

  return (
    <section>
      <StepHeader title="Check the login" />
      <div className="flex flex-col gap-4">
        {running ? (
          <div role="status" className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-5">
            <Status tone="warning" pulse className="text-sm">
              {status.session.stage ?? "Starting"}
            </Status>
            <p className="pl-4 text-[0.8125rem] text-fg-muted">Takes up to a minute</p>
          </div>
        ) : result?.ok ? (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-[#1d4d43] bg-[#06150f] p-4 text-sm">
            <Check className="size-4 text-ready" aria-hidden />
            Logged in to Banner.
          </div>
        ) : result ? (
          <LoginFailure reason={result.reason} />
        ) : null}
        {!running && !result?.ok && (
          <div>
            <Button variant={result ? "secondary" : "primary"} onClick={tryLogin}>
              {result ? "Try again" : "Try logging in"}
            </Button>
          </div>
        )}
      </div>
      <StepFooter error={error}>
        <ContinueButton onClick={next} disabled={!result?.ok} loading={busy} />
      </StepFooter>
    </section>
  );
}

// ---------- c) test ----------

function TestStep({ settings }: { settings: PublicSettings }) {
  const terms = useStore(s => s.terms);
  const [term, setTerm] = useState(settings.activeTerm ?? terms[0]?.code ?? "");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RehearsalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function chooseTerm(code: string) {
    setTerm(code);
    setReport(null);
    try {
      local.settings(await api.putSettings({ activeTerm: code }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function run() {
    if (!term) return;
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.rehearsal(term));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  async function next() {
    setBusy(true);
    try {
      await advance("test", settings);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <StepHeader title="Run a test">
        The app logs in and walks through registration for the term you pick. It never adds or drops anything.
      </StepHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex w-56 flex-col gap-1.5">
            <Label htmlFor="setup-term">Term</Label>
            <Select
              id="setup-term"
              value={term || undefined}
              onValueChange={chooseTerm}
              placeholder="Choose a term"
              options={terms.map(t => ({ value: t.code, label: t.description }))}
              disabled={running}
            />
          </div>
          <Button variant={report?.ok ? "secondary" : "primary"} onClick={run} loading={running} disabled={!term}>
            {report ? "Run again" : "Run test"}
          </Button>
        </div>
        {running && (
          <p role="status" className="text-[0.8125rem] text-fg-muted">
            Takes about 20 seconds
          </p>
        )}
        {report && (
          <div className="flex flex-col gap-3">
            <Status tone={report.ok ? "ready" : "error"} className="text-sm">
              {report.ok ? "Passed" : "Failed"}
            </Status>
            <TestReportView report={report} onlyFailed={!report.ok} />
          </div>
        )}
      </div>
      <StepFooter error={error}>
        <ContinueButton onClick={next} disabled={!report?.ok} loading={busy} />
      </StepFooter>
    </section>
  );
}

// ---------- d) live ----------

function LiveStep({ settings }: { settings: PublicSettings }) {
  const status = useStore(s => s.status)!;
  const terms = useStore(s => s.terms);
  const label = termName(terms, settings.activeTerm);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"live" | "next" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = settings.liveEnabled;

  async function turnOn() {
    setBusy("live");
    setError(null);
    try {
      local.settings(await api.live(true, text));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function next() {
    setBusy("next");
    try {
      await advance("live", settings);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <StepHeader title="Turn on Live">
        With Live on, the app registers you the moment a seat opens. With it off, it only tells you what it would have done.
      </StepHeader>
      {status.hotReload ? (
        <p className="rounded-lg border border-[#5c3d0a] bg-[#140e02] p-4 text-sm text-warning">
          Live can't be turned on while running with bun dev. Use bun start.
        </p>
      ) : on ? (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-accent/50 bg-[#020c1a] p-4 text-sm">
          <Dot tone="accent" />
          Live is on for {termName(terms, settings.liveTerm)}.
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (text === label) turnOn();
          }}
        >
          <Label htmlFor="setup-live">
            Type <span className="font-mono">{label}</span> to confirm
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="setup-live" autoComplete="off" placeholder={label} value={text} onChange={e => setText(e.target.value)} className="sm:max-w-64" />
            <Button type="submit" variant="accent" disabled={text !== label || !settings.activeTerm} loading={busy === "live"}>
              Turn on Live
            </Button>
          </div>
        </form>
      )}
      <StepFooter error={error}>
        {!on && (
          <Button variant="ghost" onClick={next} disabled={busy !== null}>
            Not now
          </Button>
        )}
        {on && <ContinueButton onClick={next} loading={busy === "next"} />}
      </StepFooter>
    </section>
  );
}

// ---------- e) notifications ----------

/** Events a newly set up channel gets turned on for. */
const DEFAULT_EVENTS: NotifyEvent[] = ["approval_needed", "registered", "registration_failed", "session_error", "guard_tripped"];

function routingWith(settings: PublicSettings, channel: "discord" | "webhook" | "push"): SettingsPatch["routing"] {
  const routing = { ...settings.routing };
  for (const e of NOTIFY_EVENTS) {
    const r = routing[e] ?? { discord: false, push: false, webhook: false };
    routing[e] = DEFAULT_EVENTS.includes(e) ? { ...r, [channel]: true } : r;
  }
  return routing;
}

type Channel = "dm" | "webhook" | "push";

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function ChannelCard({
  selected,
  onToggle,
  icon,
  title,
  description,
  configured,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  configured: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-surface transition-colors duration-150", selected ? "border-border-hover" : "border-border")}>
      <label className="flex cursor-pointer items-start gap-3 p-4 transition-colors duration-150 hover:bg-hover">
        <Checkbox checked={selected} onCheckedChange={onToggle} className="mt-0.5" />
        <span className="mt-px text-fg-muted [&_svg]:size-4" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {title}
            {configured && (
              <Status tone="ready" className="text-xs font-normal text-fg-muted">
                Ready
              </Status>
            )}
          </span>
          <span className="mt-0.5 block text-[0.8125rem] text-fg-muted">{description}</span>
        </span>
      </label>
      {selected && <div className="flex flex-col gap-4 border-t border-border bg-black p-4">{children}</div>}
    </div>
  );
}

function TestLine({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p role="status" className={cn("text-[0.8125rem]", result.ok ? "text-ready" : "text-error-fg")}>
      {result.text}
    </p>
  );
}

function NotifyStep({ settings }: { settings: PublicSettings }) {
  const dmReady = !!settings.discordTokenHint && !!settings.discordUserId;
  const hookReady = !!settings.discordWebhookHint;
  const [pushState, setPushState] = usePushState();
  const [selected, setSelected] = useState<Set<Channel>>(
    () => new Set<Channel>([...(dmReady ? ["dm" as const] : []), ...(hookReady ? ["webhook" as const] : [])]),
  );
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState(settings.discordUserId ?? "");
  const [hook, setHook] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Channel | "finish", string | null>>>({});
  const [tests, setTests] = useState<Partial<Record<Channel, { ok: boolean; text: string } | null>>>({});
  const [confirmSkip, setConfirmSkip] = useState(false);

  const pushOn = pushState === "on";
  const anyReady = dmReady || hookReady || pushOn;
  const toggle = (c: Channel) =>
    setSelected(s => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  async function run(name: string, channel: Channel | "finish", fn: () => Promise<void>) {
    setBusy(name);
    setErrors(e => ({ ...e, [channel]: null }));
    try {
      await fn();
    } catch (e) {
      setErrors(x => ({ ...x, [channel]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  const saveDm = () =>
    run("dm-save", "dm", async () => {
      const id = userId.trim();
      if (!/^\d{17,20}$/.test(id)) throw new Error("A Discord user ID is 17 to 20 digits.");
      const patch: SettingsPatch = { discordUserId: id, routing: routingWith(settings, "discord") };
      if (token.trim()) patch.discordToken = token.trim();
      else if (!settings.discordTokenHint) throw new Error("Paste the bot token.");
      local.settings(await api.putSettings(patch));
      setToken("");
    });

  const saveHook = () =>
    run("hook-save", "webhook", async () => {
      const url = hook.trim();
      if (!WEBHOOK_URL.test(url)) throw new Error("Paste a Discord webhook URL, starting with https://discord.com/api/webhooks/");
      local.settings(await api.putSettings({ discordWebhookUrl: url, routing: routingWith(settings, "webhook") }));
      setHook("");
    });

  const turnOnPush = () =>
    run("push", "push", async () => {
      try {
        setPushState(await enablePush());
        local.settings(await api.putSettings({ routing: routingWith(settings, "push") }));
      } catch (e) {
        const next = pushStateFromError(e);
        if (next) setPushState(next);
        throw e;
      }
    });

  const sendTest = (channel: Channel) =>
    run(`${channel}-test`, channel, async () => {
      const res = await api.testNotify(channel === "dm" ? "discord" : channel);
      setTests(t => ({ ...t, [channel]: { ok: res.ok, text: res.detail } }));
    });

  const finish = () =>
    run("finish", "finish", async () => {
      const saved = await api.setupStep("done");
      local.settings(saved);
      navigate("/plan?guide=1", { replace: true });
    });

  return (
    <section>
      <StepHeader title="Get notified">Pick at least one so you hear about registrations when this page is closed.</StepHeader>
      <div className="flex flex-col gap-3">
        <ChannelCard
          selected={selected.has("dm")}
          onToggle={() => toggle("dm")}
          icon={<MessageSquare />}
          title="Discord DM"
          description="A private message from your own bot, with Register and Skip buttons. Takes about 5 minutes."
          configured={dmReady}
        >
          <Guide
            items={[
              <>
                Create an application at <ExtLink href="https://discord.com/developers/applications">discord.com/developers/applications</ExtLink>.
              </>,
              <>
                Open <b>Bot</b>, choose <b>Reset Token</b>, and copy the token.
              </>,
              <>
                Open <b>OAuth2</b>, then <b>URL Generator</b>. Tick <Mono>bot</Mono> and <Mono>applications.commands</Mono>, open the link it makes, and add the
                bot to a server you're in. A new empty server works.
              </>,
              <>
                In Discord, turn on <b>Developer Mode</b> under Settings, Advanced. Then right-click your own name and choose <b>Copy User ID</b>.
              </>,
            ]}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-bot-token">Bot token</Label>
              <Input
                id="setup-bot-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder={settings.discordTokenHint ? `Saved, ends in ${settings.discordTokenHint}` : ""}
                value={token}
                onChange={e => setToken(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-user-id">Your user ID</Label>
              <Input
                id="setup-user-id"
                inputMode="numeric"
                autoComplete="off"
                className="font-mono tabular-nums"
                value={userId}
                onChange={e => setUserId(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={saveDm} loading={busy === "dm-save"} disabled={!userId || (!token && !settings.discordTokenHint)}>
              Save
            </Button>
            <Button size="sm" onClick={() => sendTest("dm")} loading={busy === "dm-test"} disabled={!dmReady}>
              {busy !== "dm-test" && <Send aria-hidden />}
              Send test
            </Button>
          </div>
          <InlineError>{errors.dm}</InlineError>
          <TestLine result={tests.dm ?? null} />
        </ChannelCard>

        <ChannelCard
          selected={selected.has("webhook")}
          onToggle={() => toggle("webhook")}
          icon={<Hash />}
          title="Discord channel"
          description="Posts to a channel in a server you own. Takes about a minute. No buttons."
          configured={hookReady}
        >
          <Guide
            items={[
              <>
                In your server, open <b>Server Settings</b>, <b>Integrations</b>, <b>Webhooks</b>.
              </>,
              <>
                Choose <b>New Webhook</b>, pick the channel, then <b>Copy Webhook URL</b>.
              </>,
              <>Paste it here.</>,
            ]}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-webhook">Webhook URL</Label>
            <Input
              id="setup-webhook"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={settings.discordWebhookHint ? `Saved, ends in ${settings.discordWebhookHint}` : "https://discord.com/api/webhooks/..."}
              value={hook}
              onChange={e => setHook(e.target.value)}
            />
            <p className="text-xs text-fg-muted">Anyone with this link can post in that channel.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={saveHook} loading={busy === "hook-save"} disabled={!hook.trim()}>
              Save
            </Button>
            <Button size="sm" onClick={() => sendTest("webhook")} loading={busy === "webhook-test"} disabled={!hookReady}>
              {busy !== "webhook-test" && <Send aria-hidden />}
              Send test
            </Button>
          </div>
          <InlineError>{errors.webhook}</InlineError>
          <TestLine result={tests.webhook ?? null} />
        </ChannelCard>

        <ChannelCard
          selected={selected.has("push")}
          onToggle={() => toggle("push")}
          icon={<Bell />}
          title="Browser"
          description={
            <>
              Notifications from this site on this device.
              {isIos() && " On iPhone, add this site to your Home Screen first."}
            </>
          }
          configured={pushOn}
        >
          <div className="flex flex-wrap items-center gap-2">
            {pushOn ? (
              <Button size="sm" variant="secondary" onClick={() => run("push-off", "push", async () => setPushState(await disablePush()))} loading={busy === "push-off"}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={turnOnPush} loading={busy === "push"} disabled={pushState === "unsupported" || pushState === "checking" || pushState === "denied"}>
                {busy !== "push" && <Bell aria-hidden />}
                Enable
              </Button>
            )}
            <Button size="sm" onClick={() => sendTest("push")} loading={busy === "push-test"} disabled={!pushOn}>
              {busy !== "push-test" && <Send aria-hidden />}
              Send test
            </Button>
            {pushState === "unsupported" && <span className="text-xs text-fg-muted">Not supported in this browser</span>}
            {pushState === "denied" && <span className="text-xs text-error-fg">Blocked in this browser's site settings</span>}
          </div>
          <InlineError>{errors.push}</InlineError>
          <TestLine result={tests.push ?? null} />
        </ChannelCard>
      </div>

      <StepFooter error={errors.finish}>
        <Button variant="primary" onClick={() => (anyReady ? finish() : setConfirmSkip(true))} loading={busy === "finish"}>
          Finish setup
        </Button>
      </StepFooter>
      <ConfirmDialog
        open={confirmSkip}
        onOpenChange={setConfirmSkip}
        title="Continue without notifications?"
        description="You'll only see registrations when this page is open."
        confirmLabel="Continue"
        tone="primary"
        onConfirm={async () => {
          const saved = await api.setupStep("done");
          local.settings(saved);
          navigate("/plan?guide=1", { replace: true });
        }}
      />
    </section>
  );
}
