import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/shadcn/ui/button";
import { Label } from "@/components/shadcn/ui/label";
import { Switch } from "@/components/shadcn/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/shadcn/ui/tooltip";
import { cn, formatDateTime } from "@/lib/utils";
import { BatchStats } from "@/pages/apps/cdc-batch-stats";
import { CdcBatchDetail } from "@/pages/apps/cdc-batch-detail";
import type { CdcLiveBatch } from "@/pages/apps/use-cdc-live-performance";
import {
    computeTimelineLayout,
    NORMAL_GAP_PX,
    TARGET_VISIBLE_BATCHES,
    TRACK_PAD_PX,
} from "@/pages/apps/use-timeline-layout";

// A pointer must travel this far before a press on the track becomes a pan; below it, the
// press stays a click so blocks can still be selected.
const DRAG_THRESHOLD_PX = 4;
const THUMB_MIN_PX = 28;
// One in every this-many visible batches carries a muted time label, giving ~4 evenly spaced
// time-context marks across a page of TARGET_VISIBLE_BATCHES.
const TIME_LABEL_STRIDE = TARGET_VISIBLE_BATCHES / 4;
// Minimum horizontal spacing between axis time labels; closer ones are dropped (lowest
// priority first) so labels never overlap.
const MIN_LABEL_GAP_PX = 56;

type AxisLabel = { key: string; x: number; text: string; tone: "muted" | "error"; priority: number };
// After scrolling stops, settle so a batch is flush against the left edge.
const SNAP_SETTLE_MS = 140;
// Left inset a snapped batch keeps — the gap width, so the previous batch scrolls fully off
// (a wider inset would let a sliver of it peek in).
const SNAP_INSET_PX = NORMAL_GAP_PX;
// Live keeps the now marker at least this far in from the right edge, so it (and its label,
// which flows to the left of it) stay fully visible.
const NOW_MARKER_MARGIN_PX = 16;
// Axis ticks within this distance to the left of the now marker are dropped so they don't
// collide with the now / stopped label (which flows left from the marker).
const NOW_LABEL_CLEARANCE_PX = 110;

const STRIPE_STYLE: CSSProperties = {
    backgroundImage:
        "repeating-linear-gradient(45deg, var(--color-muted-foreground) 0, var(--color-muted-foreground) 3px, transparent 3px, transparent 7px)",
};

function formatSeconds(durationInMs: number): string {
    return `${(durationInMs / 1000).toFixed(1)}s`;
}

// HH:MM:SS in the viewer's locale, used for the time-context, errored-batch, and idle labels.
function formatClock(value: string | number): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour12: false });
}

function statusText(batch: CdcLiveBatch): string {
    if (batch.errors > 0) {
        return `failed, ${batch.stopReason ?? "read error"}`;
    }
    return batch.ended === null ? "in progress" : "processed";
}

function statusClass(batch: CdcLiveBatch): string {
    if (batch.errors > 0) {
        return "bg-destructive";
    }
    return batch.ended === null ? "bg-muted" : "bg-brand-500/80 hover:bg-brand-500";
}

function thumbGeometry(container: HTMLDivElement, rail: HTMLDivElement): { width: number; left: number } {
    const { clientWidth, scrollWidth, scrollLeft } = container;
    const railWidth = rail.clientWidth;
    const maxScroll = scrollWidth - clientWidth;
    const width = scrollWidth > 0 ? Math.max(THUMB_MIN_PX, (clientWidth / scrollWidth) * railWidth) : railWidth;
    const span = railWidth - width;
    const left = maxScroll > 0 ? (scrollLeft / maxScroll) * span : 0;
    return { width, left };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// Idle length shown next to the "Duration" label: minutes once it crosses a minute, seconds
// below that.
function formatIdle(idleMs: number): string {
    return idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)}m` : `${Math.round(idleMs / 1000)}s`;
}

export function CdcBatchTimeline({
    batches,
    nowMs,
    showCaption = true,
    showIdleControl = true,
    allowSelect = true,
    stopped = false,
}: {
    batches: CdcLiveBatch[];
    nowMs: number;
    showCaption?: boolean;
    showIdleControl?: boolean;
    // When false (the compact modal), batches show their hover tooltip only — no click-to-pin
    // detail panel and no selection dimming.
    allowSelect?: boolean;
    // When the sink has faulted: the "Live" control is replaced by a static "Stopped" marker
    // (the feed isn't live), while the view still auto-scrolls to the last, failed batch.
    stopped?: boolean;
}): ReactNode {
    const scrollRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const railRef = useRef<HTMLDivElement>(null);
    const panRef = useRef<{ startX: number; startScroll: number; hasMoved: boolean; pointerId: number } | null>(null);
    const thumbDragRef = useRef<{ startLeft: number; startX: number; span: number; maxScroll: number } | null>(null);
    const suppressClickRef = useRef(false);
    const leftVisibleRafRef = useRef(0);
    const snapTimerRef = useRef<number | null>(null);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [isLive, setIsLive] = useState(true);
    const [showIdle, setShowIdle] = useState(false);
    const [isPanning, setIsPanning] = useState(false);
    const [thumb, setThumb] = useState({ width: 0, left: 0 });
    const [viewportWidth, setViewportWidth] = useState(0);
    const [leftVisibleIndex, setLeftVisibleIndex] = useState(0);

    const layout = computeTimelineLayout(batches, nowMs, showIdle, viewportWidth);
    const { blocks, gaps, totalWidthPx, nowLeftPx } = layout;

    // Auto-follow now: while Live is on, keep the now edge in view as batches arrive, and snap
    // the left edge to a batch boundary so it never opens on a half-cut batch.
    useEffect(() => {
        if (!isLive) {
            return;
        }
        const container = scrollRef.current;
        if (!container || blocks.length === 0) {
            return;
        }
        const maxScroll = Math.max(0, totalWidthPx - container.clientWidth);
        // Snap the left edge to the leftmost batch boundary that still keeps the now marker on
        // screen (near the right). The wide trailing room guarantees such a boundary exists at
        // any viewport width, so the left always lands exactly on a batch — never clamped
        // mid-batch — and "now" stays in view.
        const minTarget = nowLeftPx - container.clientWidth + NOW_MARKER_MARGIN_PX;
        let target = maxScroll;
        for (const block of blocks) {
            const pos = block.leftPx - SNAP_INSET_PX;
            if (pos >= minTarget) {
                target = Math.min(pos, maxScroll);
                break;
            }
        }
        container.scrollLeft = target;
    }, [isLive, nowMs, totalWidthPx, nowLeftPx, blocks]);

    // Keep the custom position bar and the measured track width in sync with the track's size
    // and content width. Runs in the layout phase so the very first paint already uses the
    // real width (never the pre-measure fallback scale). Depending on totalWidthPx re-attaches
    // this once the empty-state early return gives way to the real track, and again whenever
    // the track's width changes.
    useLayoutEffect(() => {
        const container = scrollRef.current;
        const inner = innerRef.current;
        const rail = railRef.current;
        if (!container || !inner || !rail) {
            return;
        }
        const sync = () => {
            setThumb(thumbGeometry(container, rail));
            setViewportWidth(container.clientWidth);
        };
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(container);
        observer.observe(inner);
        return () => observer.disconnect();
    }, [totalWidthPx]);

    // Cancel pending rAF/snap timers on unmount.
    useEffect(
        () => () => {
            if (leftVisibleRafRef.current) {
                cancelAnimationFrame(leftVisibleRafRef.current);
            }
            if (snapTimerRef.current !== null) {
                clearTimeout(snapTimerRef.current);
            }
        },
        [],
    );

    if (batches.length === 0) {
        return <p className="text-sm text-muted-foreground">Waiting for the first batch.</p>;
    }

    const hasSelection = selectedKey !== null;
    const selectedBlock = hasSelection ? blocks.find((block) => block.key === selectedKey) : undefined;
    const playheadLeft = selectedBlock ? selectedBlock.leftPx + selectedBlock.widthPx / 2 : nowLeftPx;
    const axisLabels = buildAxisLabels();

    // Time ticks on the axis: an errored batch's time, a muted context time every few batches,
    // the end of each idle span, and `now`. Higher-priority labels are placed first and any
    // lower-priority label that would overlap one is dropped, so ticks never collide.
    function buildAxisLabels(): AxisLabel[] {
        const candidates: AxisLabel[] = [];
        blocks.forEach((block, index) => {
            if (block.batch.errors > 0) {
                candidates.push({ key: `error-${block.key}`, x: block.leftPx, text: formatClock(block.batch.started), tone: "error", priority: 2 });
            } else if (index >= leftVisibleIndex && (index - leftVisibleIndex) % TIME_LABEL_STRIDE === 0) {
                candidates.push({ key: `time-${block.key}`, x: block.leftPx, text: formatClock(block.batch.started), tone: "muted", priority: 0 });
            }
        });
        if (showIdle) {
            for (const gap of gaps) {
                candidates.push({ key: `idle-end-${gap.leftPx}`, x: gap.leftPx + gap.widthPx, text: formatClock(gap.nextStartMs), tone: "muted", priority: 1 });
            }
        }
        const placed: AxisLabel[] = [];
        for (const label of [...candidates].sort((a, b) => b.priority - a.priority)) {
            if (placed.every((other) => Math.abs(other.x - label.x) >= MIN_LABEL_GAP_PX)) {
                placed.push(label);
            }
        }
        // Keep clear of the now / stopped label, which is rendered separately and flows to the
        // left of the marker at nowLeftPx — drop any tick that would collide with it.
        return placed.filter((label) => nowLeftPx - label.x >= NOW_LABEL_CLEARANCE_PX);
    }

    function syncThumb() {
        const container = scrollRef.current;
        const rail = railRef.current;
        if (container && rail) {
            setThumb(thumbGeometry(container, rail));
        }
    }

    // The first batch whose right edge is still past the padded left edge — the one the left
    // time label reports and the anchor the time-context marks step out from.
    function leftmostVisibleIndex(): number {
        const container = scrollRef.current;
        if (!container) {
            return 0;
        }
        const edge = container.scrollLeft + TRACK_PAD_PX;
        const index = blocks.findIndex((block) => block.leftPx + block.widthPx > edge);
        return index === -1 ? blocks.length - 1 : index;
    }

    // Settle so the nearest batch sits flush against the padded left edge. A no-op once we are
    // already within a pixel, so the smooth scroll it triggers doesn't loop.
    function snapToNearest() {
        const container = scrollRef.current;
        if (!container || isLive) {
            return;
        }
        const maxScroll = container.scrollWidth - container.clientWidth;
        const index = leftmostVisibleIndex();
        const desired = clamp(blocks[index].leftPx - SNAP_INSET_PX, 0, maxScroll);
        if (Math.abs(desired - container.scrollLeft) > 1) {
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            container.scrollTo({ left: desired, behavior: reduceMotion ? "auto" : "smooth" });
        }
    }

    function handleScroll() {
        syncThumb();
        if (!leftVisibleRafRef.current) {
            leftVisibleRafRef.current = requestAnimationFrame(() => {
                leftVisibleRafRef.current = 0;
                setLeftVisibleIndex(leftmostVisibleIndex());
            });
        }
        if (!isLive) {
            if (snapTimerRef.current !== null) {
                clearTimeout(snapTimerRef.current);
            }
            snapTimerRef.current = window.setTimeout(snapToNearest, SNAP_SETTLE_MS);
        }
    }

    function selectBatch(key: string) {
        if (!allowSelect || suppressClickRef.current) {
            return;
        }
        setSelectedKey(key);
        setIsLive(false);
    }

    function goLive() {
        setSelectedKey(null);
        setIsLive(true);
    }

    // Page the timeline by a full window of batches; like drag and wheel, this is manual
    // navigation so it stops the auto-follow from snapping back to now.
    function scrollByPage(direction: 1 | -1) {
        const container = scrollRef.current;
        if (!container) {
            return;
        }
        const target = clamp(leftVisibleIndex + direction * TARGET_VISIBLE_BATCHES, 0, blocks.length - 1);
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        container.scrollTo({
            left: Math.max(0, blocks[target].leftPx - SNAP_INSET_PX),
            behavior: reduceMotion ? "auto" : "smooth",
        });
        setIsLive(false);
    }

    function handleTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        // Touch and pen keep native scrolling; only mouse presses become a drag-to-pan.
        if (event.pointerType !== "mouse") {
            return;
        }
        panRef.current = {
            startX: event.clientX,
            startScroll: scrollRef.current?.scrollLeft ?? 0,
            hasMoved: false,
            pointerId: event.pointerId,
        };
        suppressClickRef.current = false;
    }

    function handleTrackPointerMove(event: React.PointerEvent<HTMLDivElement>) {
        const pan = panRef.current;
        const container = scrollRef.current;
        if (!pan || !container) {
            return;
        }
        const dx = event.clientX - pan.startX;
        if (!pan.hasMoved && Math.abs(dx) > DRAG_THRESHOLD_PX) {
            // Capture only now, after the move threshold, so a plain click still reaches the
            // block button underneath.
            pan.hasMoved = true;
            suppressClickRef.current = true;
            container.setPointerCapture(pan.pointerId);
            setIsPanning(true);
            setIsLive(false);
        }
        if (pan.hasMoved) {
            container.scrollLeft = pan.startScroll - dx;
        }
    }

    function endTrackPan() {
        const pan = panRef.current;
        if (!pan) {
            return;
        }
        if (pan.hasMoved) {
            scrollRef.current?.releasePointerCapture(pan.pointerId);
            setIsPanning(false);
            // Keep the click after a drag suppressed, then clear on the next tick so the very
            // next real click selects normally.
            setTimeout(() => {
                suppressClickRef.current = false;
            }, 0);
        } else {
            suppressClickRef.current = false;
        }
        panRef.current = null;
    }

    function handleThumbPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        event.stopPropagation();
        const container = scrollRef.current;
        const rail = railRef.current;
        if (!container || !rail) {
            return;
        }
        thumbDragRef.current = {
            startLeft: thumb.left,
            startX: event.clientX,
            span: rail.clientWidth - thumb.width,
            maxScroll: container.scrollWidth - container.clientWidth,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsLive(false);
    }

    function handleThumbPointerMove(event: React.PointerEvent<HTMLDivElement>) {
        const drag = thumbDragRef.current;
        const container = scrollRef.current;
        if (!drag || !container) {
            return;
        }
        const nextLeft = clamp(drag.startLeft + (event.clientX - drag.startX), 0, drag.span);
        container.scrollLeft = drag.span > 0 ? (nextLeft / drag.span) * drag.maxScroll : 0;
    }

    function endThumbDrag(event: React.PointerEvent<HTMLDivElement>) {
        if (!thumbDragRef.current) {
            return;
        }
        event.currentTarget.releasePointerCapture(event.pointerId);
        thumbDragRef.current = null;
    }

    function handleRailPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        // Presses on the thumb are handled by the thumb's own handler.
        if (event.target !== event.currentTarget) {
            return;
        }
        const container = scrollRef.current;
        const rail = railRef.current;
        if (!container || !rail) {
            return;
        }
        const span = rail.clientWidth - thumb.width;
        const maxScroll = container.scrollWidth - container.clientWidth;
        const nextLeft = clamp(event.clientX - rail.getBoundingClientRect().left - thumb.width / 2, 0, span);
        container.scrollLeft = span > 0 ? (nextLeft / span) * maxScroll : 0;
        setIsLive(false);
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                {showCaption ? (
                    <span className="text-xs text-muted-foreground">
                        Durations to scale, {showIdle ? "idle shown" : "idle hidden"}. ~12 per view — drag or use the
                        arrows.
                    </span>
                ) : (
                    <span />
                )}
                <div className="flex items-center gap-3">
                    {showIdleControl && (
                        <div className="flex items-center gap-2">
                            <Switch id="cdc-show-idle" checked={showIdle} onCheckedChange={setShowIdle} />
                            <Label htmlFor="cdc-show-idle" className="text-xs text-muted-foreground">
                                Idle
                            </Label>
                        </div>
                    )}
                    <div className="flex items-center gap-1.5">
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label="Previous 12 batches"
                            onClick={() => scrollByPage(-1)}
                        >
                            <ChevronLeft aria-hidden="true" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label="Next 12 batches"
                            onClick={() => scrollByPage(1)}
                        >
                            <ChevronRight aria-hidden="true" />
                        </Button>
                        {!stopped && (
                            <Button
                                variant="outline"
                                size="sm"
                                aria-pressed={isLive}
                                onClick={goLive}
                                className={cn("gap-1.5", isLive ? "text-foreground" : "text-muted-foreground")}
                            >
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "size-1.5 rounded-full",
                                        isLive ? "bg-destructive motion-safe:animate-pulse" : "bg-muted-foreground",
                                    )}
                                />
                                Live
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <div
                ref={scrollRef}
                className={cn(
                    "no-scrollbar overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-surface2 dark:bg-surface1",
                    isPanning ? "cursor-grabbing select-none" : "cursor-grab",
                )}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={endTrackPan}
                onPointerCancel={endTrackPan}
                onScroll={handleScroll}
                onWheel={() => setIsLive(false)}
                onTouchStart={() => setIsLive(false)}
            >
                <div ref={innerRef} className="relative h-[98px]" style={{ width: totalWidthPx }}>
                    <div className="absolute inset-x-0 top-0 h-6 border-b border-border">
                        {axisLabels.map((label) => (
                            <span
                                key={label.key}
                                className={cn(
                                    "absolute top-[5px] h-[19px] font-mono text-[10px] whitespace-nowrap",
                                    label.tone === "error" && "border-l border-destructive pl-1 text-destructive",
                                    label.tone === "muted" && "border-l border-input pl-1 text-muted-foreground",
                                )}
                                style={{ left: label.x }}
                            >
                                {label.text}
                            </span>
                        ))}
                        {/* The now / stopped label flows to the LEFT of the marker dot (clearing
                            it) so it stays fully visible even when the marker sits at the right edge. */}
                        <span
                            className={cn(
                                "absolute top-[5px] h-[19px] -translate-x-full font-mono text-[10px] whitespace-nowrap",
                                stopped ? "font-semibold text-destructive" : "text-info",
                            )}
                            style={{ left: nowLeftPx - 14 }}
                        >
                            {stopped ? "stopped" : "now"}
                        </span>
                    </div>

                    {gaps.length > 0 && (
                        <div className="pointer-events-none absolute inset-x-0 top-[40px] h-[46px]">
                            {gaps.map((gap) => (
                                <div
                                    key={gap.leftPx}
                                    className="absolute top-0 h-[46px] rounded bg-muted-foreground/10"
                                    style={{ left: gap.leftPx, width: gap.widthPx }}
                                >
                                    {/* The idle's own start time and how long it lasted sit inside
                                        the grey space; only render when it's wide enough to read. */}
                                    {gap.idleMs >= 1000 && gap.widthPx >= 88 && (
                                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 overflow-hidden px-1 text-[10px] leading-tight whitespace-nowrap text-muted-foreground">
                                            <span>
                                                Started{" "}
                                                <span className="font-mono text-foreground">
                                                    {formatClock(gap.startMs)}
                                                </span>
                                            </span>
                                            <span>
                                                Duration{" "}
                                                <span className="font-mono text-foreground">
                                                    {formatIdle(gap.idleMs)}
                                                </span>
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="absolute inset-x-0 top-[40px] h-[46px]">
                        <TooltipProvider delayDuration={300}>
                            {blocks.map((block) => {
                                const isSelected = block.key === selectedKey;
                                const isInProgress = block.batch.ended === null && block.batch.errors === 0;
                                return (
                                    <Tooltip key={block.key}>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label={`Batch at ${formatDateTime(block.batch.started)}, ${formatSeconds(
                                                    block.batch.durationInMs,
                                                )}, ${statusText(block.batch)}`}
                                                onClick={() => selectBatch(block.key)}
                                                className={cn(
                                                    "absolute top-0 h-[46px] min-w-2 rounded outline-2 outline-offset-2 outline-transparent transition-opacity duration-200 focus-visible:outline-foreground motion-reduce:transition-none",
                                                    statusClass(block.batch),
                                                    hasSelection && !isSelected && "opacity-20",
                                                    isSelected && "opacity-100 outline-foreground",
                                                )}
                                                style={{
                                                    left: block.leftPx,
                                                    width: block.widthPx,
                                                    ...(isInProgress ? STRIPE_STYLE : null),
                                                }}
                                            />
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="top"
                                            className="max-w-none border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-md [&_svg]:bg-popover [&_svg]:fill-popover"
                                        >
                                            <BatchStats batch={block.batch} />
                                        </TooltipContent>
                                    </Tooltip>
                                );
                            })}
                        </TooltipProvider>
                    </div>

                    <div
                        className="pointer-events-none absolute top-0 bottom-0 z-10 transition-[left] duration-200 ease-out motion-reduce:transition-none"
                        style={{ left: playheadLeft }}
                    >
                        <div
                            className={cn(
                                "absolute top-1 left-0 size-3.5 -translate-x-1/2 rounded-full ring-3 ring-background",
                                stopped ? "bg-destructive" : "bg-info",
                            )}
                        />
                        <div
                            className={cn(
                                "absolute top-3 bottom-0 left-0 w-0.5 -translate-x-1/2",
                                stopped ? "bg-destructive" : "bg-info",
                            )}
                        />
                    </div>
                </div>
            </div>

            <div
                ref={railRef}
                className="relative h-1.5 touch-none rounded-full bg-muted"
                onPointerDown={handleRailPointerDown}
            >
                <div
                    className="absolute top-0 h-1.5 rounded-full bg-foreground/20 hover:bg-foreground/30"
                    style={{ width: thumb.width, left: thumb.left }}
                    onPointerDown={handleThumbPointerDown}
                    onPointerMove={handleThumbPointerMove}
                    onPointerUp={endThumbDrag}
                    onPointerCancel={endThumbDrag}
                />
            </div>

            {selectedBlock && (
                <div className="mt-1">
                    <CdcBatchDetail batch={selectedBlock.batch} onClose={goLive} />
                </div>
            )}
        </div>
    );
}
