import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, CalendarClock, Database } from "lucide-react";
import { api } from "@/api/api";
import type { AppResponse, CdcError } from "@/api/generated/server-api";
import { ApiState } from "@/components/data/api-state";
import { PagePanel } from "@/components/data/page-panel";
import { Button } from "@/components/shadcn/ui/button";
import { Card, CardContent } from "@/components/shadcn/ui/card";
import { SectionCard } from "@/pages/apps/section-card";
import { CollectionsSection } from "@/pages/apps/collections-section";
import { CdcBatchTimeline } from "@/pages/apps/cdc-batch-timeline";
import { CdcErrorsSheet } from "@/pages/apps/cdc-errors-sheet";
import { DashboardStatCards, type DashboardStatCard } from "@/pages/dashboard/dashboard-stat-cards";
import { useCdcLivePerformance, type CdcLivePerformance } from "@/pages/apps/use-cdc-live-performance";
import { formatDate } from "@/lib/format";

export function AppDataSource() {
    const { slug = "" } = useParams();
    const live = useCdcLivePerformance(slug);
    const errorsQuery = useQuery(api.queries.apps.cdcErrors(slug));
    const appQuery = useQuery(api.queries.apps.detail(slug));
    const storedErrors = errorsQuery.data ?? [];
    const nowMs = useNow();

    return (
        <PagePanel>
            <div className="space-y-8">
                <SectionCard title="Connection">
                    <div className="space-y-4">
                        <ApiState
                            isLoading={appQuery.isPending}
                            onRetry={appQuery.refetch}
                            isError={appQuery.isError}
                            errorTitle="Could not load data source"
                        >
                            {appQuery.data && <ConnectionCard app={appQuery.data} />}
                        </ApiState>
                        <CollectionsSection slug={slug} />
                    </div>
                </SectionCard>
                <SectionCard title="Live CDC performance">
                    <ApiState
                        isLoading={live.connection === "connecting"}
                        isError={live.connection === "error"}
                        errorTitle="Could not connect to the live data sync"
                        onRetry={live.retry}
                        loadingLabel="Connecting to the live data sync..."
                    >
                        {live.performance && (
                            <CdcPerformanceContent
                                performance={live.performance}
                                slug={slug}
                                errors={storedErrors}
                                nowMs={nowMs}
                            />
                        )}
                    </ApiState>
                </SectionCard>
            </div>
        </PagePanel>
    );
}

function CdcPerformanceContent({
    performance,
    slug,
    errors,
    nowMs,
}: {
    performance: CdcLivePerformance;
    slug: string;
    errors: CdcError[];
    nowMs: number;
}) {
    // The Errors card counts the stored error list — the same set "View errors" opens — so the
    // number and the sheet always agree, broken down by error step (transformation, load, …).
    const errorsByStep = countByStep(errors);

    // Writes-per-batch trend for the card's sparkline (same derivation as CdcSyncMini's
    // throughput), timestamped by each batch's completion so the tooltip reads a time.
    const writeSeries = performance.recentBatches.map((batch) => batch.processed);
    const writeSeriesDates = performance.recentBatches.map((batch) => batch.ended ?? batch.started);

    const cards: DashboardStatCard[] = [
        {
            label: "Recent writes",
            value: performance.recentWrites,
            isLoading: false,
            series: writeSeries,
            seriesDates: writeSeriesDates,
        },
        {
            label: "Errors",
            value: errors.length,
            isLoading: false,
            headerAction:
                errors.length > 0 ? (
                    <CdcErrorsSheet
                        slug={slug}
                        trigger={
                            <Button variant="destructive-outline" size="sm" className="h-7">
                                View errors
                            </Button>
                        }
                    />
                ) : undefined,
            action:
                errors.length > 0 ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {errorsByStep.map(({ step, count: stepCount }) => (
                            <span key={step}>
                                <span className="font-medium text-foreground tabular-nums">{stepCount}</span> {step}
                            </span>
                        ))}
                    </div>
                ) : undefined,
        },
    ];

    return (
        <div className="space-y-4">
            <DashboardStatCards cards={cards} />
            <CdcBatchTimeline batches={performance.recentBatches} nowMs={nowMs} />
        </div>
    );
}

// Tally stored errors by their step (e.g. Transformation, Load, Extraction, Configuration),
// most frequent first, so the card can show what the total is made of.
function countByStep(errors: CdcError[]): { step: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const error of errors) {
        const step = error.step || "Unknown";
        counts.set(step, (counts.get(step) ?? 0) + 1);
    }
    return [...counts.entries()].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count);
}

// The in-progress batch's width is measured against "now", so the timeline needs a clock that
// advances between the live feed's heartbeats. Reading the clock in an interval keeps render pure.
function useNow(intervalMs = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}

function ConnectionCard({ app }: { app: AppResponse }) {
    return (
        <Card>
            <CardContent className="grid gap-6 sm:grid-cols-3">
                <ConnectionDetail icon={AppWindow} label="Application" value={app.name} />
                <ConnectionDetail
                    icon={Database}
                    label="Source database"
                    value={<span className="font-mono">{app.database}</span>}
                />
                <ConnectionDetail icon={CalendarClock} label="Connected since" value={formatDate(app.createdAt)} />
            </CardContent>
        </Card>
    );
}

function ConnectionDetail({
    icon: Icon,
    label,
    value,
}: {
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    label: string;
    value: ReactNode;
}) {
    return (
        <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-4 text-muted-foreground" aria-hidden={true} />
            </div>
            <div className="min-w-0 space-y-0.5">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="truncate text-sm font-medium">{value}</div>
            </div>
        </div>
    );
}
