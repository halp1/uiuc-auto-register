import { useState } from "react";
import type { WantedCourse } from "../../src/core/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { InlineError } from "@/components/ui/list";
import { api } from "@/lib/api";
import { chicagoLocalToIso, courseCode, isoToChicagoLocal } from "@/lib/format";
import { local } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

/** Departments lift cohort restrictions during business hours on the release date. */
const DEFAULT_TIME = "09:00";

/** Hold a course until a release date (a cohort or major restriction lifts then). */
export function WaitUntilDialog({
  course,
  open,
  onOpenChange,
}: {
  course: WantedCourse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const saved = isoToChicagoLocal(course.notBefore);
  const [date, setDate] = useState(saved.slice(0, 10));
  const [time, setTime] = useState(saved.slice(11) || DEFAULT_TIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = courseCode(course);

  function reset(next: boolean) {
    if (next) {
      setDate(saved.slice(0, 10));
      setTime(saved.slice(11) || DEFAULT_TIME);
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit(notBefore: string | null) {
    setBusy(true);
    setError(null);
    try {
      local.upsertWanted(await api.patchWanted(course.id, { notBefore }));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const iso = date && time ? chicagoLocalToIso(`${date}T${time}`) : null;
    if (!iso) return setError("Enter a date and time.");
    void submit(iso);
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent>
        <form
          onSubmit={e => {
            e.preventDefault();
            save();
          }}
        >
          <DialogBody>
            <DialogTitle>Wait to register {code}</DialogTitle>
            <DialogDescription>
              Central time. For 24 hours after, restriction errors are retried instead of blocking {code}.
            </DialogDescription>
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wait-date">Date</Label>
                <Input
                  id="wait-date"
                  type="date"
                  required
                  className="font-mono text-[0.8125rem] tabular-nums"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wait-time">Time</Label>
                <Input
                  id="wait-time"
                  type="time"
                  required
                  className="font-mono text-[0.8125rem] tabular-nums"
                  value={time}
                  onChange={e => setTime(e.target.value)}
                />
              </div>
            </div>
            <InlineError>{error}</InlineError>
          </DialogBody>
          <DialogFooter>
            {course.notBefore && (
              <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={() => void submit(null)}>
                Stop waiting
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
