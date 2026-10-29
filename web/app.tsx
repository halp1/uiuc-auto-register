import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { ONBOARDING_STEPS, type OnboardingStep } from "../src/core/types";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { linkClick, hrefWithMock, navigate, useRoute } from "@/lib/router";
import { reload, useStore } from "@/lib/store";
import { ActivityPage } from "@/pages/activity";
import { CoursePage } from "@/pages/course";
import { OverviewPage } from "@/pages/overview";
import { PlanPage } from "@/pages/plan";
import { SearchPage } from "@/pages/search";
import { SettingsPage } from "@/pages/settings";
import { SetupPage } from "@/pages/setup";
import { SignInPage } from "@/pages/signin";
import { useAuthGate } from "@/lib/auth";

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-16 w-full" />
      <div className="overflow-hidden rounded-lg border border-border">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="flex h-16 items-center gap-4 border-b border-border px-4 last:border-b-0">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-6 w-32 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadFailed({ message }: { message: string }) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
      <h1 className="text-base font-semibold">Could not load the app state</h1>
      <p className="text-sm text-fg-muted">{message}</p>
      <Button onClick={() => reload()} className="mt-2">
        <RefreshCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
      <h1 className="text-base font-semibold">Page not found</h1>
      <Button asChild variant="secondary">
        <a href={hrefWithMock("/")} onClick={linkClick("/")}>
          Go to Overview
        </a>
      </Button>
    </div>
  );
}

/** Where the user is allowed to be: any setup step up to and including the saved one. */
function allowedSetupStep(requested: string | null, current: OnboardingStep): OnboardingStep {
  const order = ONBOARDING_STEPS as readonly string[];
  if (!requested || !order.includes(requested) || requested === "done") return current;
  return order.indexOf(requested) <= order.indexOf(current) ? (requested as OnboardingStep) : current;
}

export function App() {
  const gate = useAuthGate();
  if (gate === "checking") return <BootSplash />;
  if (gate === "signin") return <SignInPage />;
  return <AuthedApp />;
}

function BootSplash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy aria-label="Loading">
      <Skeleton className="size-9 rounded-lg" />
    </div>
  );
}

function AuthedApp() {
  const route = useRoute();
  const ready = useStore(s => s.status !== null);
  const loadError = useStore(s => s.loadError);
  const onboarding = useStore(s => s.settings?.onboardingStep ?? null);
  const inSetup = !!onboarding && onboarding !== "done";

  // Unfinished setup owns every route. Finished setup sends /setup back home.
  const setupStep = inSetup ? allowedSetupStep(route.name === "setup" ? route.step : null, onboarding) : null;
  useEffect(() => {
    if (!ready || !onboarding) return;
    if (inSetup) {
      if (route.name !== "setup" || route.step !== setupStep) navigate(`/setup/${setupStep}`, { replace: true });
    } else if (route.name === "setup") navigate("/", { replace: true });
  }, [ready, onboarding, inSetup, route, setupStep]);

  if (ready && inSetup) return <SetupPage step={setupStep!} />;

  let page;
  if (!ready) page = loadError ? <LoadFailed message={loadError} /> : <Loading />;
  else
    switch (route.name) {
      case "overview":
        page = <OverviewPage />;
        break;
      case "plan":
        page = <PlanPage id={route.id} guide={route.guide} />;
        break;
      case "search":
        page = <SearchPage initialQuery={route.q} />;
        break;
      case "course":
        page = <CoursePage key={`${route.term}/${route.subject}/${route.number}`} term={route.term} subject={route.subject} number={route.number} />;
        break;
      case "activity":
        page = <ActivityPage />;
        break;
      case "settings":
        page = <SettingsPage />;
        break;
      case "setup":
        page = <Loading />;
        break;
      default:
        page = <NotFound />;
    }

  return (
    <Shell fill={ready && (route.name === "overview" || route.name === "plan")} wide={route.name === "plan"}>
      {page}
    </Shell>
  );
}
