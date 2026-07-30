import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { api } from "@/api/api";
import type { CdcError } from "@/api/generated/server-api";
import { ApiState } from "@/components/data/api-state";
import { Button } from "@/components/shadcn/ui/button";
import { CdcBatchTimeline } from "@/pages/apps/cdc-batch-timeline";
import { CdcErrorsSheet } from "@/pages/apps/cdc-errors-sheet";
import { SectionCard } from "@/pages/apps/section-card";
import { DashboardStatCards, type DashboardStatCard } from "@/pages/dashboard/dashboard-stat-cards";
import { useCdcLivePerformance, type CdcLivePerformance } from "@/pages/apps/use-cdc-live-performance";

// The live CDC section: a "Recent writes" stat card with a writes sparkline, an "Errors" card
// broken down by error step (with a "View errors" drawer), and the batch timeline. Shared by
// the app Data Source page and the app-created wizard modal so both read the same way.
export function CdcPerformanceSection({
    slug,
    title = "Live CDC performance",
    loadingLabel = "Connecting to live CDC performance...",
    errorTitle = "Could not connect to the live CDC feed",
    compact = false,
}: {
    slug: string;
    title?: string;
    loadingLabel?: string;
    errorTitle?: string;
    // A tighter variant for the app-created modal: no writes sparkline, and the timeline's
    // caption and idle toggle are hidden.
    compact?: boolean;
}) {
    const live = useCdcLivePerformance(slug);
    const errorsQuery = useQuery(api.queries.apps.cdcErrors(slug));
    const nowMs = useNow();

    return (
        <SectionCard title={title}>
            <ApiState
                isLoading={live.connection === "connecting"}
                isError={live.connection === "error"}
                errorTitle={errorTitle}
                onRetry={live.retry}
                loadingLabel={loadingLabel}
            >
                {live.performance && (
                    <CdcPerformanceContent
                        performance={live.performance}
                        slug={slug}
                        errors={errorsQuery.data ?? []}
                        nowMs={nowMs}
                        compact={compact}
                    />
                )}
            </ApiState>
        </SectionCard>
    );
}

function CdcPerformanceContent({
    performance,
    slug,
    errors,
    nowMs,
    compact,
}: {
    performance: CdcLivePerformance;
    slug: string;
    errors: CdcError[];
    nowMs: number;
    compact: boolean;
}) {
    // The Errors card counts the stored error list — the same set "View errors" opens — so the
    // number and the sheet always agree, broken down by error step (transformation, load, …).
    const errorsByStep = countByStep(errors);

    // The task has stopped when the newest batch ended on a fatal ("Faulted…") stop reason and
    // nothing is in progress after it — distinct from recoverable per-batch errors, so it gets
    // an explicit banner.
    const stoppedReason = fatalStopReason(performance);

    // Writes-per-batch trend for the card's sparkline, timestamped by each batch's completion
    // so the tooltip reads a time.
    const writeSeries = performance.recentBatches.map((batch) => batch.processed);
    const writeSeriesDates = performance.recentBatches.map((batch) => batch.ended ?? batch.started);

    const cards: DashboardStatCard[] = [
        {
            label: "Recent writes",
            value: performance.recentWrites,
            isLoading: false,
            // The modal drops the sparkline to keep the card compact.
            ...(compact ? {} : { series: writeSeries, seriesDates: writeSeriesDates }),
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
            {stoppedReason && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="space-y-0.5">
                        <p className="font-medium">Sync stopped</p>
                        <p className="text-destructive/90">{stoppedReason}. Fix the issue and re-enable the task.</p>
                    </div>
                </div>
            )}
            <DashboardStatCards cards={cards} />
            <CdcBatchTimeline
                batches={performance.recentBatches}
                nowMs={nowMs}
                showCaption={!compact}
                showIdleControl={!compact}
                allowSelect={!compact}
                stopped={stoppedReason !== null}
            />
        </div>
    );
}

// If the sink has faulted — the most recent batch ended on a "Faulted…" stop reason and no
// batch is in progress — return that reason; otherwise null (a recoverable per-batch error or
// a healthy feed).
function fatalStopReason(performance: CdcLivePerformance): string | null {
    if (performance.recentBatches.some((batch) => batch.ended === null)) {
        return null;
    }
    const newest = performance.recentBatches.at(-1);
    return newest?.stopReason && /fault/i.test(newest.stopReason) ? newest.stopReason : null;
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
