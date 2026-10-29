import { Check, Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";

/** Recovery codes shown once, with Copy, Download and an "I saved these" gate. */
export function RecoveryCodes({
  codes,
  onSavedChange,
  saved,
}: {
  codes: string[];
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const text = codes.join("\n");

  function download() {
    const blob = new Blob([`YUAR recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "yuar-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-black px-5 py-4">
        {codes.map(code => (
          <li key={code} className="select-all font-mono text-sm tracking-wide tabular-nums text-fg">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              // Clipboard blocked. The codes are selectable.
            }
          }}
        >
          {copied ? <Check className="text-ready" aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" size="sm" onClick={download}>
          <Download aria-hidden />
          Download
        </Button>
      </div>
      <label className="flex items-center gap-2.5 text-sm">
        <Checkbox checked={saved} onCheckedChange={v => onSavedChange(v === true)} />I saved these codes
      </label>
    </div>
  );
}

/** New password plus confirm, with the 8 character minimum and a mismatch error. */
export function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  idPrefix,
  label = "Password",
  autoFocus,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  idPrefix: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const short = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-new`}>{label}</Label>
        <Input
          id={`${idPrefix}-new`}
          type="password"
          autoComplete="new-password"
          autoFocus={autoFocus}
          value={password}
          aria-invalid={short || undefined}
          aria-describedby={`${idPrefix}-new-hint`}
          onChange={e => onPassword(e.target.value)}
        />
        <p id={`${idPrefix}-new-hint`} className={short ? "text-xs text-error-fg" : "text-xs text-fg-muted"}>
          At least 8 characters
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-confirm`}>Confirm</Label>
        <Input
          id={`${idPrefix}-confirm`}
          type="password"
          autoComplete="new-password"
          value={confirm}
          aria-invalid={mismatch || undefined}
          onChange={e => onConfirm(e.target.value)}
        />
        {mismatch && <p className="text-xs text-error-fg">Passwords don't match</p>}
      </div>
    </div>
  );
}

export function newPasswordValid(password: string, confirm: string) {
  return password.length >= 8 && password === confirm;
}
