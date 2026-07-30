import type { CdcLiveBatch } from "@/pages/apps/use-cdc-live-performance";

// Pure layout math for the CDC batch timeline. NOT a React hook despite the `use-` file
// name (kept for file-naming consistency); the timeline component consumes this to render.

// Bar width encodes duration, and the px-per-ms scale is derived from the data + measured
// width so a run of ~this-many typical batches fills the view (instead of a fixed zoom). The
// count drifts a little around this when the visible batches are unusually long or short.
export const TARGET_VISIBLE_BATCHES = 12;
export const NORMAL_GAP_PX = 11;
// Left inset so the first bar and its start timestamp are not flush against the track edge.
export const TRACK_PAD_PX = 16;
// Trailing scroll room past the `now` marker. Wider than the largest possible batch pitch
// (MAX_BLOCK_PX + gap) so Live can always find a batch boundary to snap the left edge to at
// any viewport width — without clamping the scroll mid-batch. It only adds scroll room; it
// does not change the batch scale or how much empty track shows past `now`.
export const TRAILING_PX = 290;
// A single bar can't get narrower than this (so a near-instant batch stays visible) or wider
// than this (so one very long/long-running batch doesn't make scrolling feel endless — the
// exact duration is still in the batch detail on hover).
export const MIN_BLOCK_PX = 8;
export const MAX_BLOCK_PX = 240;
// Scale used until the track width has been measured (first render), matching the previous
// fixed zoom of 42px per second.
export const FALLBACK_PX_PER_MS = 42 / 1000;
// Floor on the typical batch duration used to derive the scale, so a burst of near-instant
// batches can't blow the px-per-ms scale up.
const MIN_TYPICAL_DUR_MS = 200;

export type TimelineBlock = {
    key: string;
    leftPx: number;
    widthPx: number;
    batch: CdcLiveBatch;
};

export type TimelineGap = {
    leftPx: number;
    widthPx: number;
    idleMs: number;
    // Epoch ms of the idle span's edges: when the previous batch ended and the next one started.
    startMs: number;
    nextStartMs: number;
};

export type TimelineLayout = {
    blocks: TimelineBlock[];
    gaps: TimelineGap[];
    totalWidthPx: number;
    nowLeftPx: number;
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// The duration a batch occupies the sink: its recorded duration, or (while still running) the
// time elapsed since it started.
function effectiveDurationMs(batch: CdcLiveBatch, nowMs: number): number {
    return batch.ended === null ? Math.max(0, nowMs - Date.parse(batch.started)) : batch.durationInMs;
}

// The moment a batch stops occupying the sink: its completion time, or (while still running)
// its start plus the duration observed so far.
function endMsOf(batch: CdcLiveBatch): number {
    return batch.ended === null ? Date.parse(batch.started) + batch.durationInMs : Date.parse(batch.ended);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Derive the px-per-ms scale so that a run of ~TARGET_VISIBLE_BATCHES *typical* batches fills
// the measured width. The typical duration is the median, so a few very long batches don't
// squeeze everything narrow. Falls back to the fixed scale before the width is known.
function derivePxPerMs(batches: CdcLiveBatch[], nowMs: number, viewportWidth: number): number {
    const targetBatches = Math.min(TARGET_VISIBLE_BATCHES, batches.length);
    if (viewportWidth <= 0 || targetBatches === 0) {
        return FALLBACK_PX_PER_MS;
    }
    const typicalDurMs = Math.max(
        MIN_TYPICAL_DUR_MS,
        median(batches.map((batch) => effectiveDurationMs(batch, nowMs))),
    );
    // Fit the batches across the visible width (left/right inset only) — the trailing scroll
    // room past `now` is separate and must not shrink the batch scale (or more than ~12 would
    // fit the view).
    const usable = Math.max(0, viewportWidth - 2 * TRACK_PAD_PX);
    const batchesWidth = usable - (targetBatches - 1) * NORMAL_GAP_PX;
    if (batchesWidth <= 0) {
        return FALLBACK_PX_PER_MS;
    }
    return batchesWidth / (targetBatches * typicalDurMs);
}

// Bar width always encodes duration, on a scale derived to fit ~TARGET_VISIBLE_BATCHES typical
// batches across `viewportWidth`. When `showIdle` is off batches sit contiguously with a
// uniform gap and idle time is not represented; when it is on the gap between batches grows
// with the idle span (capped) and is reported in `gaps`.
export function computeTimelineLayout(
    batches: CdcLiveBatch[],
    nowMs: number,
    showIdle: boolean,
    viewportWidth: number,
): TimelineLayout {
    if (batches.length === 0) {
        return { blocks: [], gaps: [], totalWidthPx: 0, nowLeftPx: 0 };
    }

    const pxPerMs = derivePxPerMs(batches, nowMs, viewportWidth);
    const blocks: TimelineBlock[] = [];
    const gaps: TimelineGap[] = [];
    let x = TRACK_PAD_PX;

    batches.forEach((batch, index) => {
        const widthPx = clamp(effectiveDurationMs(batch, nowMs) * pxPerMs, MIN_BLOCK_PX, MAX_BLOCK_PX);
        blocks.push({ key: batch.key, leftPx: x, widthPx, batch });
        x += widthPx;

        if (index < batches.length - 1) {
            if (showIdle) {
                const startMs = endMsOf(batch);
                const nextStartMs = Date.parse(batches[index + 1].started);
                const idleMs = Math.max(0, nextStartMs - startMs);
                // Idle width encodes its duration on the same scale (and cap) as batch blocks,
                // so a long quiet stretch reads as a wide gap just like a long batch reads wide.
                const gapPx = clamp(Math.round(idleMs * pxPerMs), NORMAL_GAP_PX, MAX_BLOCK_PX);
                gaps.push({ leftPx: x, widthPx: gapPx, idleMs, startMs, nextStartMs });
                x += gapPx;
            } else {
                x += NORMAL_GAP_PX;
            }
        }
    });

    const lastBlock = blocks[blocks.length - 1];
    const nowLeftPx = lastBlock.leftPx + lastBlock.widthPx + 6;
    const totalWidthPx = nowLeftPx + TRAILING_PX;

    return { blocks, gaps, totalWidthPx, nowLeftPx };
}
