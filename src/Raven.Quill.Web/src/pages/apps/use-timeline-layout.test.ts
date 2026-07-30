import { expect, it } from "vitest";
import {
    computeTimelineLayout,
    FALLBACK_PX_PER_MS,
    NORMAL_GAP_PX,
    MAX_BLOCK_PX,
    TARGET_VISIBLE_BATCHES,
    TRACK_PAD_PX,
} from "./use-timeline-layout";

const b = (started: string, durMs: number) => ({
    key: started,
    started,
    ended: new Date(Date.parse(started) + durMs).toISOString(),
    durationInMs: durMs,
    processed: 100,
    read: 100,
    errors: 0,
    phases: [],
    allocatedBytes: null,
    stopReason: null,
});

const NOW = Date.parse("2026-07-28T09:00:00Z");
const evenBatches = (count: number, durMs = 1000) =>
    Array.from({ length: count }, (_, i) =>
        b(new Date(Date.parse("2026-07-28T08:00:00Z") + i * 2000).toISOString(), durMs),
    );

// A viewport narrow enough that these short batches stay under MAX_BLOCK_PX with the derived
// scale, so width ratios can be asserted directly.
const VIEWPORT = 300;

it("scales block width in proportion to duration", () => {
    const { blocks } = computeTimelineLayout(
        [b("2026-07-28T08:00:00Z", 1000), b("2026-07-28T08:00:03Z", 2000)],
        NOW,
        false,
        VIEWPORT,
    );
    expect(blocks[0].widthPx).toBeLessThan(MAX_BLOCK_PX);
    expect(blocks[1].widthPx).toBeLessThan(MAX_BLOCK_PX);
    expect(blocks[1].widthPx / blocks[0].widthPx).toBeCloseTo(2, 1);
});

it("derives the scale so ~12 even batches fill the measured width", () => {
    // Twelve equal batches: they plus their uniform gaps should span roughly the usable width
    // (viewport minus the left pad and trailing room).
    const { blocks } = computeTimelineLayout(evenBatches(12), NOW, false, 800);
    const last = blocks[blocks.length - 1];
    const spanned = last.leftPx + last.widthPx - TRACK_PAD_PX;
    // Usable width = 800 - 2 * TRACK_PAD_PX(16) = 768; the 12 batches + gaps span ~that.
    expect(spanned).toBeGreaterThan(700);
    expect(spanned).toBeLessThan(800);
});

it("keeps the count near 12 at very different widths for even batches", () => {
    for (const viewportWidth of [640, 1024, 1920]) {
        const { blocks } = computeTimelineLayout(evenBatches(40), NOW, false, viewportWidth);
        const visible = blocks.filter((block) => block.leftPx < viewportWidth).length;
        expect(visible).toBeGreaterThanOrEqual(TARGET_VISIBLE_BATCHES);
        expect(visible).toBeLessThanOrEqual(TARGET_VISIBLE_BATCHES + 2);
    }
});

it("lays batches contiguously and ignores idle time between them", () => {
    const { blocks } = computeTimelineLayout(
        [b("2026-07-28T08:00:00Z", 1000), b("2026-07-28T08:05:00Z", 1000)],
        NOW,
        false,
        VIEWPORT,
    );
    expect(blocks[1].leftPx).toBeCloseTo(blocks[0].leftPx + blocks[0].widthPx + NORMAL_GAP_PX, 1);
});

it("caps a very long batch at MAX_BLOCK_PX so the track cannot grow without bound", () => {
    const { blocks } = computeTimelineLayout([b("2026-07-28T08:00:00Z", 600_000)], NOW, false, 1000);
    expect(blocks[0].widthPx).toBe(MAX_BLOCK_PX);
});

it("insets the first block from the left edge", () => {
    const { blocks } = computeTimelineLayout([b("2026-07-28T08:00:00Z", 1000)], NOW, false, VIEWPORT);
    expect(blocks[0].leftPx).toBe(TRACK_PAD_PX);
});

it("falls back to the fixed scale before the width is measured", () => {
    const { blocks } = computeTimelineLayout([b("2026-07-28T08:00:00Z", 1000)], NOW, false, 0);
    expect(blocks[0].widthPx).toBeCloseTo(1000 * FALLBACK_PX_PER_MS, 1);
});

it("represents idle time as a capped gap with its edge timestamps only when showIdle is on", () => {
    const batches = [b("2026-07-28T08:00:00Z", 1000), b("2026-07-28T08:05:00Z", 1000)];

    // ~299s idle far exceeds the cap, so the single gap clamps to the same cap as batch blocks
    // (MAX_BLOCK_PX) and still reports the true idle duration and its edge timestamps.
    const withIdle = computeTimelineLayout(batches, NOW, true, 400);
    expect(withIdle.gaps).toHaveLength(1);
    expect(withIdle.gaps[0].widthPx).toBe(MAX_BLOCK_PX);
    expect(withIdle.gaps[0].idleMs).toBeGreaterThan(200_000);
    expect(withIdle.gaps[0].startMs).toBe(Date.parse("2026-07-28T08:00:01Z"));
    expect(withIdle.gaps[0].nextStartMs).toBe(Date.parse("2026-07-28T08:05:00Z"));

    // The same input produces no gaps when idle time is not shown.
    const contiguous = computeTimelineLayout(batches, NOW, false, 400);
    expect(contiguous.gaps).toHaveLength(0);
});
