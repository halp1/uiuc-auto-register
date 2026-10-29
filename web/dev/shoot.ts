// Screenshot helper for the mock preview: bun web/dev/shoot.ts
import { mkdirSync } from "node:fs";

const base = process.env.BASE ?? "http://localhost:3999";
const out = process.env.OUT ?? ".impeccable/review";
mkdirSync(out, { recursive: true });

const shots: { name: string; path: string; width: number; height: number; script?: string }[] = [
  { name: "desktop", path: "/?mock=1", width: 1440, height: 900 },
  { name: "mobile", path: "/?mock=1", width: 390, height: 844 },
  { name: "guard", path: "/?mock=1&scenario=guard&mode=live", width: 1440, height: 900 },
  { name: "empty", path: "/?mock=1&scenario=empty", width: 1440, height: 900 },
  { name: "course", path: "/course/120271/CS/225?mock=1", width: 1440, height: 900 },
  { name: "course-mobile", path: "/course/120271/CS/225?mock=1", width: 390, height: 844 },
  { name: "search", path: "/search?q=cs&mock=1", width: 1440, height: 900 },
  { name: "activity", path: "/activity?mock=1", width: 1440, height: 900 },
  { name: "settings", path: "/settings?mock=1", width: 1440, height: 900 },
  { name: "settings-mobile", path: "/settings?mock=1", width: 390, height: 844 },
  { name: "settings-ticket", path: "/settings?mock=1&mode=rehearsal#ticket", width: 1440, height: 900 },
  {
    name: "settings-ticket-edited",
    path: "/settings?mock=1&mode=rehearsal#ticket",
    width: 1440,
    height: 900,
    // edit the date by hand: the Auto detect switch turns off in the form
    script: `(() => { const i = document.getElementById('ticket-at'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '2026-11-02T08:00'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  },
  { name: "plan", path: "/plan?mock=1", width: 1440, height: 900 },
  { name: "plan-wide", path: "/plan?mock=1", width: 1920, height: 1080 },
  { name: "plan-mobile", path: "/plan?mock=1", width: 390, height: 844 },
  {
    name: "plan-compare",
    path: "/plan?mock=1",
    width: 1440,
    height: 900,
    // pin schedule 2, then preview schedule 1 so the overlay shows
    script: `(() => { const l = document.querySelector('[role=listbox][aria-label=Schedules]'); l?.focus(); const k = (key) => l?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); k('ArrowDown'); setTimeout(() => k('p'), 100); setTimeout(() => k('ArrowUp'), 200); })()`,
  },
  {
    name: "plan-target",
    path: "/plan?mock=1",
    width: 1440,
    height: 900,
    script: `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Target this schedule'))?.click()`,
  },
];

const only = process.argv.slice(2);
for (const s of shots) {
  if (only.length && !only.includes(s.name)) continue;
  await using v = new Bun.WebView({ width: s.width, height: s.height });
  await v.navigate(base + s.path);
  await Bun.sleep(1500);
  if (s.script) {
    await v.evaluate(s.script);
    await Bun.sleep(400);
  }
  await Bun.write(`${out}/${s.name}.png`, await v.screenshot());
  console.log("wrote", s.name);
}
