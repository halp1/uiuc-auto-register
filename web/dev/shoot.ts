// Screenshot helper for the mock preview: bun web/dev/shoot.ts
import { mkdirSync } from "node:fs";

const base = process.env.BASE ?? "http://localhost:3999";
const out = ".impeccable/review";
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
];

const only = process.argv.slice(2);
for (const s of shots) {
  if (only.length && !only.includes(s.name)) continue;
  await using v = new Bun.WebView({ width: s.width, height: s.height });
  await v.navigate(base + s.path);
  await Bun.sleep(1500);
  if (s.script) await v.evaluate(s.script);
  await Bun.write(`${out}/${s.name}.png`, await v.screenshot());
  console.log("wrote", s.name);
}
