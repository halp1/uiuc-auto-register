import { Check, KeyRound, LogOut, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthSessionInfo, AuthStatus, PasskeyInfo } from "../../src/core/types";
import { useAuthError } from "@/components/retry-countdown";
import { NewPasswordFields, RecoveryCodes, newPasswordValid } from "@/components/security";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Card, CardBody, CardFooter, CardTitle, InlineError } from "@/components/ui/list";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { passkeysSupported, requireSignIn, setAuthStatus, useAuthStatus } from "@/lib/auth";
import { relative, useNow } from "@/lib/format";
import { isPasskeyCancel, registerPasskey } from "@/lib/passkey";
import { cn, errorMessage } from "@/lib/utils";

function Section({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function CurrentPassword({ value, onChange, id, autoFocus }: { value: string; onChange: (v: string) => void; id: string; autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Current password</Label>
      <Input id={id} type="password" autoComplete="current-password" autoFocus={autoFocus} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

// ---------- dialogs ----------

/** Turn on password mode: new password, then the codes. */
function EnableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = useAuthError();

  function close() {
    onOpenChange(false);
    setPassword("");
    setConfirm("");
    setCodes(null);
    setSaved(false);
    error.clear();
  }

  async function submit() {
    if (!newPasswordValid(password, confirm)) return;
    setBusy(true);
    error.clear();
    try {
      const res = await api.authConfigure({ mode: "password", password, remember: true });
      setAuthStatus(res.status);
      setCodes(res.recoveryCodes ?? []);
    } catch (e) {
      error.set(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => (o ? onOpenChange(true) : codes ? saved && close() : close())}>
      <DialogContent className="max-w-lg">
        {codes ? (
          <>
            <DialogBody>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>Each code works once if you forget your password. They won't be shown again.</DialogDescription>
              <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={close} disabled={!saved}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={e => {
              e.preventDefault();
              submit();
            }}
          >
            <DialogBody>
              <DialogTitle>Require a password</DialogTitle>
              <DialogDescription className="sr-only">Choose a password for this app</DialogDescription>
              <NewPasswordFields idPrefix="enable-auth" password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} autoFocus />
              <InlineError>{error.text}</InlineError>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!newPasswordValid(password, confirm) || error.blocked}>
                Turn on
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Asks for the current password, then runs an action. Used for turning auth off and new codes. */
function PasswordGateDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  result,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (password: string) => Promise<void>;
  result?: ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const error = useAuthError();

  function close() {
    onOpenChange(false);
    setPassword("");
    error.clear();
  }

  return (
    <Dialog open={open} onOpenChange={o => (o ? onOpenChange(true) : close())}>
      <DialogContent className={result ? "max-w-lg" : undefined}>
        {result ?? (
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (!password) return;
              setBusy(true);
              error.clear();
              try {
                await onConfirm(password);
                setPassword("");
              } catch (err) {
                error.set(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogBody>
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
              <CurrentPassword id="gate-password" value={password} onChange={setPassword} autoFocus />
              <InlineError>{error.text}</InlineError>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant={destructive ? "danger" : "primary"} loading={busy} disabled={!password || error.blocked}>
                {confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const error = useAuthError();

  function close() {
    onOpenChange(false);
    setCurrent("");
    setPassword("");
    setConfirm("");
    error.clear();
  }

  return (
    <Dialog open={open} onOpenChange={o => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-lg">
        <form
          onSubmit={async e => {
            e.preventDefault();
            if (!current || !newPasswordValid(password, confirm)) return;
            setBusy(true);
            error.clear();
            try {
              setAuthStatus(await api.authPassword(current, password));
              close();
            } catch (err) {
              error.set(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>Other devices get signed out.</DialogDescription>
            <CurrentPassword id="change-current" value={current} onChange={setCurrent} autoFocus />
            <NewPasswordFields idPrefix="change-auth" label="New password" password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
            <InlineError>{error.text}</InlineError>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!current || !newPasswordValid(password, confirm) || error.blocked}>
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- lists ----------

function PasskeyRow({ passkey, onChange, onRemove, now }: { passkey: PasskeyInfo; onChange: (p: PasskeyInfo) => void; onRemove: () => void; now: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [busy, setBusy] = useState<"rename" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    const next = name.trim();
    if (!next || next === passkey.name) {
      setEditing(false);
      setName(passkey.name);
      return;
    }
    setBusy("rename");
    setError(null);
    try {
      onChange(await api.passkeyRename(passkey.id, next));
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-col gap-1 bg-black px-3 py-2.5">
      <div className="flex items-center gap-3">
        <KeyRound className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={e => {
                e.preventDefault();
                rename();
              }}
            >
              <Input
                aria-label="Passkey name"
                autoFocus
                maxLength={60}
                className="h-8"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") {
                    setEditing(false);
                    setName(passkey.name);
                  }
                }}
              />
              <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save name" loading={busy === "rename"}>
                {busy !== "rename" && <Check />}
              </Button>
            </form>
          ) : (
            <>
              <p className="truncate text-sm">{passkey.name}</p>
              <p className="truncate text-xs text-fg-muted tabular-nums">
                <span className="font-mono">{passkey.host}</span>
                <span className="text-fg-subtle"> / </span>
                Added {relative(passkey.createdAt, now)}
                <span className="text-fg-subtle"> / </span>
                {passkey.lastUsedAt ? `Used ${relative(passkey.lastUsedAt, now)}` : "Never used"}
              </p>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-1">
            <Button size="icon-sm" variant="ghost" aria-label={`Rename ${passkey.name}`} onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${passkey.name}`}
              className="hover:text-error-fg"
              loading={busy === "remove"}
              onClick={async () => {
                setBusy("remove");
                setError(null);
                try {
                  await api.passkeyRemove(passkey.id);
                  onRemove();
                } catch (e) {
                  setError(errorMessage(e));
                  setBusy(null);
                }
              }}
            >
              {busy !== "remove" && <Trash2 />}
            </Button>
          </div>
        )}
      </div>
      <InlineError>{error}</InlineError>
    </li>
  );
}

function SessionRow({ session, onRevoked, now }: { session: AuthSessionInfo; onRevoked: () => void; now: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-1 bg-black px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            <span className="truncate">{session.device}</span>
            {session.current && (
              <Badge variant="muted" className="h-5 shrink-0 px-2 text-[0.6875rem]">
                This device
              </Badge>
            )}
          </p>
          <p className="truncate text-xs text-fg-muted tabular-nums">
            {session.ip && <span className="font-mono">{session.ip}</span>}
            {session.ip && <span className="text-fg-subtle"> / </span>}
            {session.current ? "Active now" : `Seen ${relative(session.lastSeenAt, now)}`}
          </p>
        </div>
        {!session.current && (
          <Button
            size="xs"
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.authRevokeSession(session.id);
                onRevoked();
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Sign out
          </Button>
        )}
      </div>
      <InlineError>{error}</InlineError>
    </li>
  );
}

// ---------- card ----------

export function SecurityCard() {
  const auth = useAuthStatus();
  const now = useNow(30_000);
  const on = auth?.mode === "password";
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [sessions, setSessions] = useState<AuthSessionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    if (!on) return;
    try {
      const [s, p] = await Promise.all([api.authSessions(), supported ? api.passkeys() : Promise.resolve([] as PasskeyInfo[])]);
      setSessions(s);
      setPasskeys(p);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [on, supported]);

  useEffect(() => {
    load();
  }, [load]);

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

  const refreshStatus = async () => setAuthStatus(await api.authStatus());

  return (
    <Card id="security" className="scroll-mt-20">
      <CardBody>
        <CardTitle>Security</CardTitle>
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p id="require-password" className="text-sm font-medium">
              Require a password
            </p>
            {!on && <p className="mt-0.5 text-[0.8125rem] text-fg-muted">Anyone who can open this page can use it</p>}
          </div>
          <Switch
            aria-labelledby="require-password"
            checked={on}
            onCheckedChange={v => (v ? setEnableOpen(true) : setDisableOpen(true))}
          />
        </div>

        {on && (
          <>
            <Section
              title="Password"
              action={
                <Button size="xs" onClick={() => setChangeOpen(true)}>
                  Change password
                </Button>
              }
            />

            <Section
              title="Passkeys"
              action={
                supported && (
                  <Button
                    size="xs"
                    loading={busy === "passkey"}
                    onClick={() =>
                      run("passkey", async () => {
                        const added = await registerPasskey();
                        setPasskeys(p => [...(p ?? []), added]);
                        await refreshStatus();
                      })
                    }
                  >
                    {busy !== "passkey" && <Plus aria-hidden />}
                    Add passkey
                  </Button>
                )
              }
            >
              {!supported ? (
                <p className="text-[0.8125rem] text-fg-muted">Passkeys need https or localhost.</p>
              ) : passkeys === null ? (
                <Skeleton className="h-14" />
              ) : passkeys.length === 0 ? (
                <p className="text-[0.8125rem] text-fg-muted">None yet</p>
              ) : (
                <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
                  {passkeys.map(p => (
                    <PasskeyRow
                      key={p.id}
                      passkey={p}
                      now={now}
                      onChange={next => setPasskeys(list => list?.map(x => (x.id === next.id ? next : x)) ?? null)}
                      onRemove={() => {
                        setPasskeys(list => list?.filter(x => x.id !== p.id) ?? null);
                        refreshStatus();
                      }}
                    />
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="Recovery codes"
              action={
                <Button size="xs" onClick={() => setCodesOpen(true)}>
                  Make new codes
                </Button>
              }
            >
              <p className={cn("text-[0.8125rem] tabular-nums", (auth?.recoveryCodesLeft ?? 0) <= 2 ? "text-warning" : "text-fg-muted")}>
                {auth?.recoveryCodesLeft ?? 0} left
              </p>
            </Section>

            <Section
              title="Signed-in devices"
              action={
                sessions && sessions.length > 1 ? (
                  <Button
                    size="xs"
                    loading={busy === "others"}
                    onClick={() =>
                      run("others", async () => {
                        await api.authRevokeOthers();
                        setSessions(s => s?.filter(x => x.current) ?? null);
                      })
                    }
                  >
                    Sign out everywhere else
                  </Button>
                ) : undefined
              }
            >
              {sessions === null ? (
                <Skeleton className="h-14" />
              ) : (
                <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
                  {[...sessions]
                    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
                    .map(s => (
                      <SessionRow key={s.id} session={s} now={now} onRevoked={() => setSessions(list => list?.filter(x => x.id !== s.id) ?? null)} />
                    ))}
                </ul>
              )}
            </Section>
          </>
        )}
        <InlineError>{error}</InlineError>
      </CardBody>
      {on && (
        <CardFooter>
          <span className="text-xs text-fg-muted">
            Locked out? Run <code className="font-mono text-fg">bun run reset-auth</code> on the server.
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "logout"}
            onClick={() =>
              run("logout", async () => {
                await api.authLogout();
                requireSignIn();
              })
            }
          >
            {busy !== "logout" && <LogOut aria-hidden />}
            Sign out
          </Button>
        </CardFooter>
      )}

      <EnableDialog
        open={enableOpen}
        onOpenChange={o => {
          setEnableOpen(o);
          if (!o) load();
        }}
      />
      <PasswordGateDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Turn off the password?"
        description="Anyone who can open this page will be able to use it. Passkeys and recovery codes are removed."
        confirmLabel="Turn off"
        destructive
        onConfirm={async currentPassword => {
          const res = await api.authConfigure({ mode: "none", currentPassword });
          setAuthStatus(res.status as AuthStatus);
          setPasskeys(null);
          setSessions(null);
          setDisableOpen(false);
        }}
      />
      <ChangePasswordDialog
        open={changeOpen}
        onOpenChange={o => {
          setChangeOpen(o);
          if (!o) load();
        }}
      />
      <PasswordGateDialog
        open={codesOpen}
        onOpenChange={o => {
          if (!o && newCodes && !codesSaved) return;
          setCodesOpen(o);
          if (!o) {
            setNewCodes(null);
            setCodesSaved(false);
          }
        }}
        title="Make new codes"
        description="Your old codes stop working."
        confirmLabel="Make new codes"
        onConfirm={async currentPassword => {
          const res = await api.authRecoveryCodes(currentPassword);
          setNewCodes(res.recoveryCodes);
          await refreshStatus();
        }}
        result={
          newCodes ? (
            <>
              <DialogBody>
                <DialogTitle>Save your recovery codes</DialogTitle>
                <DialogDescription>Each code works once if you forget your password. They won't be shown again.</DialogDescription>
                <RecoveryCodes codes={newCodes} saved={codesSaved} onSavedChange={setCodesSaved} />
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="primary"
                  disabled={!codesSaved}
                  onClick={() => {
                    setCodesOpen(false);
                    setNewCodes(null);
                    setCodesSaved(false);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : undefined
        }
      />
    </Card>
  );
}

