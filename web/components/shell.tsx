import {
  Activity,
  CalendarRange,
  ChevronsUpDown,
  LayoutGrid,
  Menu,
  Pause,
  Play,
  Search,
  Settings,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AppMark, ModePill, ModeTag } from "@/components/mode";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Status } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { attentionItems } from "@/lib/attention";
import { termName } from "@/lib/format";
import { hrefWithMock, linkClick, navigate, useRoute, type RouteMatch } from "@/lib/router";
import { local, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

const nav = [
  { href: "/", label: "Overview", icon: LayoutGrid, match: (r: RouteMatch) => r.name === "overview" || r.name === "course" },
  { href: "/plan", label: "Plan", icon: CalendarRange, match: (r: RouteMatch) => r.name === "plan" },
  { href: "/search", label: "Search", icon: Search, match: (r: RouteMatch) => r.name === "search" },
  { href: "/activity", label: "Activity", icon: Activity, match: (r: RouteMatch) => r.name === "activity" },
  { href: "/settings", label: "Settings", icon: Settings, match: (r: RouteMatch) => r.name === "settings" },
];

export function focusSearch() {
  navigate("/search");
  requestAnimationFrame(() => document.getElementById("search-input")?.focus());
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const route = useRoute();
  const status = useStore(s => s.status);
  const attention = useStore(attentionItems);
  const top = attention[0];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
        <AppMark />
        <span className="truncate text-sm font-semibold">Auto Register</span>
        {/* <ModeTag status={status} /> */}
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            focusSearch();
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-black px-2.5 text-left text-sm text-placeholder transition-colors duration-150 ease-out hover:border-border-hover hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">Find</span>
          <Kbd aria-hidden>F</Kbd>
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
        {nav.map(item => {
          const active = item.match(route);
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={hrefWithMock(item.href)}
              onClick={linkClick(item.href, onNavigate)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-fg-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent",
                active && "bg-selected text-fg hover:bg-selected",
              )}
            >
              <Icon className="size-[18px] shrink-0" aria-hidden />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="mt-auto p-3">
        {top && (
          <div role="status" className="rounded-lg border border-[#5c3d0a] bg-[#140e02] p-3">
            <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-warning">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              Action Required
            </div>
            <p className="mt-1.5 text-[0.8125rem] font-medium text-fg">{top.title}</p>
            <p className="mt-0.5 line-clamp-3 text-xs text-[#c9b48f]">{top.detail}</p>
            {attention.length > 1 && (
              <p className="mt-1 text-xs text-[#c9b48f] tabular-nums">and {attention.length - 1} more</p>
            )}
            <Button
              size="xs"
              variant="secondary"
              className="mt-3 w-full border-[#5c3d0a] hover:border-warning"
              onClick={() => {
                onNavigate?.();
                navigate(top.href);
              }}
            >
              {top.action}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TermSwitcher() {
  const terms = useStore(s => s.terms);
  const settings = useStore(s => s.settings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = settings?.activeTerm ?? null;

  async function choose(code: string) {
    if (code === active) return;
    setBusy(true);
    setError(null);
    try {
      local.settings(await api.putSettings({ activeTerm: code }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Term: ${termName(terms, active)}. Switch term`}
            disabled={busy}
            className="group flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:opacity-60"
          >
            <span className="truncate">{termName(terms, active)}</span>
            {active && <span className="hidden font-mono text-xs text-fg-muted sm:inline">{active}</span>}
            <ChevronsUpDown className="size-4 shrink-0 text-fg-muted group-hover:text-fg" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Terms</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={active ?? ""} onValueChange={choose}>
            {terms.map(t => (
              <DropdownMenuRadioItem key={t.code} value={t.code}>
                <span className="flex-1">{t.description}</span>
                <span className="font-mono text-xs text-fg-muted">{t.code}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" className="truncate text-xs text-error-fg">
          {error}
        </span>
      )}
    </div>
  );
}

function PauseAllButton() {
  const paused = useStore(s => s.status?.globalPaused ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (paused) await api.resumeAll();
      else await api.pauseAll();
      local.globalPaused(!paused);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const button = (
    <Button
      size="sm"
      variant={paused ? "primary" : "secondary"}
      onClick={toggle}
      loading={busy}
      aria-invalid={error ? true : undefined}
      className={cn(error && "border-error")}
    >
      {!busy && (paused ? <Play aria-hidden /> : <Pause aria-hidden />)}
      <span className="hidden sm:inline">{paused ? "Resume all" : "Pause all"}</span>
      <span className="sr-only sm:hidden">{paused ? "Resume all" : "Pause all"}</span>
    </Button>
  );
  return error ? <Tooltip content={error}>{button}</Tooltip> : button;
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const status = useStore(s => s.status);
  const connection = useStore(s => s.connection);
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-black/95 px-3 sm:px-5">
      <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </Button>
      <TermSwitcher />
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {connection === "reconnecting" && (
          <Status tone="warning" pulse className="text-xs text-fg-muted" role="status">
            Reconnecting
          </Status>
        )}
        {status && <PauseAllButton />}
        {status && <ModePill status={status} />}
      </div>
    </header>
  );
}

/**
 * `fill`: on wide screens the page gets exactly the viewport below the top bar and scrolls its own
 * regions (the Overview's watchlist and activity feed). Narrow screens keep normal page scrolling.
 */
export function Shell({ children, fill = false, wide = false }: { children: ReactNode; fill?: boolean; wide?: boolean }) {
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      focusSearch();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={cn("min-h-dvh md:pl-60", fill && "xl:flex xl:h-dvh xl:min-h-0 xl:flex-col xl:overflow-hidden")}>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-border bg-sidebar md:block">
        <SidebarContent />
      </aside>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent>
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SidebarContent onNavigate={() => setSheet(false)} />
        </SheetContent>
      </Sheet>
      <TopBar onMenu={() => setSheet(true)} />
      <main
        className={cn(
          "mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8 lg:px-8",
          wide && "max-w-[1680px]",
          fill && "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:pb-8",
        )}
      >
        {children}
      </main>
    </div>
  );
}
