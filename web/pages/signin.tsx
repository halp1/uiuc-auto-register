import { ArrowLeft, KeyRound } from "lucide-react";
import { useState } from "react";
import { AppMark } from "@/components/mode";
import { useAuthError } from "@/components/retry-countdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { passkeysSupported, setAuthStatus, useAuthStatus } from "@/lib/auth";
import { isPasskeyCancel, signInWithPasskey } from "@/lib/passkey";
import { start } from "@/lib/store";
import type { AuthStatus } from "../../src/core/types";

async function done(status: AuthStatus) {
  setAuthStatus(status);
  await start();
}

function ErrorLine({ text }: { text: string | null }) {
  return (
    <p role="alert" aria-live="polite" className="min-h-5 text-[0.8125rem] tabular-nums text-error-fg">
      {text}
    </p>
  );
}

function PasswordForm({ onRecover }: { onRecover: () => void }) {
  const auth = useAuthStatus();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const error = useAuthError();
  const showPasskey = !!auth?.passkeyLogin && passkeysSupported();

  async function submit() {
    if (!password || error.blocked) return;
    setBusy("password");
    error.clear();
    try {
      await done(await api.authLogin(password, remember));
    } catch (e) {
      error.set(e);
      setPassword("");
    } finally {
      setBusy(null);
    }
  }

  async function passkey() {
    setBusy("passkey");
    error.clear();
    try {
      await done(await signInWithPasskey(remember));
    } catch (e) {
      if (!isPasskeyCancel(e)) error.set(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signin-password">Password</Label>
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            aria-invalid={error.text ? true : undefined}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2.5 text-[0.8125rem] text-fg-muted">
          <Checkbox checked={remember} onCheckedChange={v => setRemember(v === true)} />
          Remember this device
        </label>
        <ErrorLine text={error.text} />
        <Button type="submit" variant="primary" className="w-full" loading={busy === "password"} disabled={!password || error.blocked || busy === "passkey"}>
          Sign in
        </Button>
      </form>
      {showPasskey && (
        <>
          <div className="flex items-center gap-3 text-xs text-fg-subtle" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="secondary" className="w-full" onClick={passkey} loading={busy === "passkey"} disabled={error.blocked || busy === "password"}>
            {busy !== "passkey" && <KeyRound aria-hidden />}
            Sign in with a passkey
          </Button>
        </>
      )}
      <button
        type="button"
        onClick={onRecover}
        className="self-center rounded text-[0.8125rem] text-fg-muted underline decoration-border-hover underline-offset-2 transition-colors duration-150 hover:text-fg"
      >
        Use a recovery code
      </button>
    </div>
  );
}

function RecoverForm({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const error = useAuthError();
  const short = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = code.trim() && password.length >= 8 && confirm === password && !error.blocked;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    error.clear();
    try {
      await done(await api.authRecover(code.trim(), password, true));
    } catch (e) {
      error.set(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={e => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recover-code">Recovery code</Label>
        <Input
          id="recover-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          className="font-mono uppercase"
          value={code}
          onChange={e => setCode(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recover-new">New password</Label>
        <Input
          id="recover-new"
          type="password"
          autoComplete="new-password"
          value={password}
          aria-invalid={short || undefined}
          aria-describedby="recover-new-hint"
          onChange={e => setPassword(e.target.value)}
        />
        <p id="recover-new-hint" className={short ? "text-xs text-error-fg" : "text-xs text-fg-muted"}>
          At least 8 characters
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recover-confirm">Confirm password</Label>
        <Input
          id="recover-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          aria-invalid={mismatch || undefined}
          onChange={e => setConfirm(e.target.value)}
        />
        {mismatch && <p className="text-xs text-error-fg">Passwords don't match</p>}
      </div>
      <ErrorLine text={error.text} />
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ready}>
        Reset password and sign in
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 self-center rounded text-[0.8125rem] text-fg-muted transition-colors duration-150 hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to sign in
      </button>
    </form>
  );
}

export function SignInPage() {
  const [recovering, setRecovering] = useState(false);
  const auth = useAuthStatus();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <main className="flex w-full max-w-[360px] flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AppMark className="size-9" />
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{recovering ? "Reset your password" : "Sign in to YUAR"}</h1>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          {recovering ? <RecoverForm onBack={() => setRecovering(false)} /> : <PasswordForm onRecover={() => setRecovering(true)} />}
        </div>
        {auth?.passkeyLogin && !passkeysSupported() && <p className="text-center text-xs text-fg-subtle">Passkeys need https or localhost.</p>}
      </main>
    </div>
  );
}
