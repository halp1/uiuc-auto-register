# Schedule planner (approved plan, working notes for the team)

Contract: `src/core/types.ts` (Plan*, `WantedCourse.planId`, stream message `plans`) and `src/core/api.ts` (plan routes). Do not change the contract without telling the lead.

## Decisions
1. Targeting builds per course `[chosen bundle, ...backups]`. Backups = that course's other bundles that do not conflict with the other target picks, fixed registered classes, or breaks. Ranked by open seats, capped at 20, `generated: true`. Off when `PlanCourse.backups` is false.
2. Targeted courses get armed (UI shows one confirm listing courses and CRNs).
3. Targeting replaces bundles only for watchlist courses in the plan. Others untouched. `planId` set on each targeted wanted course, UI shows a "Plan" tag.
4. Closed sections are included. Each schedule shows open count. `openOnly` filter, off by default.
5. Per course: include toggle, excluded CRNs, lock to one exact bundle.
6. Fixed blocks = `store.latestSchedule(term)` CRNs unless `ignoreRegistered`. No new Banner reads. Plan courses already registered get status `registered` and are skipped.
7. Breaks: list of `{days, start, end}`.
8. Sorts: open (closed asc, minSeats desc), days asc, start desc (latest start), end asc, gaps asc. Ties: gapMin, then key.
9. UI: result list + big week calendar, hover/arrow preview, pin one schedule as compare overlay.
10. Named plans per term, autosaved, term starts with "Plan 1". Limits: 10 plans per term, 12 courses per plan, 20 breaks, 60 excluded CRNs.
11. Sidebar "Plan" between Overview and Search. Route `/plan` and `/plan?id=N`.

## Backend
- `src/engine/schedule.ts` (pure): move `minutes`, `meetingsOverlap`, `sectionsConflict` here (planner.ts imports them). Part of term: two sections conflict only if `partOfTerm` equal or either is full term (null or "1"). `breakHit`, `courseOptions`, `generateSchedules` (DFS fewest options first, prune, stop at 5000 schedules or 1500 ms using an injectable `now`, then openOnly, stats, sort, slice 200), `backupBundles`, `planConflicts`. Untimed meetings never conflict and are left out of stats.
- Store migration 2: tables `plans`, `plan_courses` (UNIQUE plan_id+subject+number, ON DELETE CASCADE), `ALTER TABLE wanted_courses ADD COLUMN plan_id INTEGER`. Methods listPlans (auto-create Plan 1), getPlan, createPlan, updatePlan, deletePlan (clears wanted plan_id), add/update/deletePlanCourse, setWantedPlan.
- Services: `planGenerate(planId)` loads details via existing `courseDetail` 3 at a time, skips seat fetch when every stored seat for the course is under 10 minutes old. `planTarget(planId, picks)` validates on the server (active term, picks cover exactly the included non-registered courses, CRNs belong to the course, picks conflict-free vs each other, breaks and fixed blocks), 409 if an affected wanted course has a bundle in registering or pending_approval, then one transaction: find or create wanted (kind bundles), setBundles, plan_id, armed. Wanted courses with this plan_id from the previous target that are not in the new picks are disarmed (kept). Save target. Emit `control` event "Targeted <plan name>" with all CRNs, then afterWatchlistChange("plan_targeted").
- Routes per `src/core/api.ts`, through `wrap`, validated. Publish `{type:"plans", term, plans}` after plan changes.
- Orchestrator: for a course with planId, skip an open bundle that conflicts with CRNs of other same-term courses in state registered, or the latest schedule snapshot. Filter only, no state change, no new writes.

## Frontend
- Router `{name:"plan", id?: number}`. Nav item with lucide `CalendarRange`. Shell `fill` at xl for plan.
- `web/pages/plan.tsx`: left rail (plan picker with New/Rename/Delete, course list with inline search add, include checkbox, option count, status badge, row menu: Sections sheet with exclude checkboxes and lock bundle, Backups switch; breaks chips + add form with M T W R F toggles and 30 min selects; Ignore registered, Open now only, Sort; Generate primary button with a stale indicator). Middle: results listbox (arrows, Home/End, hover preview), row shows codes+sections, n/m open, days, start to end, pin button, Target badge, "Showing 200 of N". Main: week calendar M to F (+S/U if used), 8 AM to 8 PM extended to fit, one chart color per course, fixed blocks muted striped, breaks hatched, pinned overlay outlines differing blocks, online/arranged strip. "Target this schedule" button, confirm dialog lists courses, CRNs, backups count, says they get armed.
- Overview watchlist rows: small "Plan" badge when `planId` set.
- Mock: plans, a generate result with CS 225, CS 173, MATH 241 with linked sections, target handling. `shoot.ts` gets `plan` and `plan-mobile`.
- Copy rules: no middle dot, no em or en dashes, no semicolons in UI copy. Minimal copy. Accessible names on icon buttons.

## Safety
Never start the real server from the repo dir (the user's `.env` would log into the real account). Never touch the real account. Use `bun web/dev/serve-mock.ts` for UI checks.
