import { RefreshCw } from "lucide-react";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { linkClick, hrefWithMock, useRoute } from "@/lib/router";
import { reload, useStore } from "@/lib/store";
import { ActivityPage } from "@/pages/activity";
import { CoursePage } from "@/pages/course";
import { OverviewPage } from "@/pages/overview";
import { SearchPage } from "@/pages/search";
import { SettingsPage } from "@/pages/settings";

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

export function App() {
  const route = useRoute();
  const ready = useStore(s => s.status !== null);
  const loadError = useStore(s => s.loadError);

  let page;
  if (!ready) page = loadError ? <LoadFailed message={loadError} /> : <Loading />;
  else
    switch (route.name) {
      case "overview":
        page = <OverviewPage />;
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
      default:
        page = <NotFound />;
    }

  return <Shell fill={ready && route.name === "overview"}>{page}</Shell>;
}
