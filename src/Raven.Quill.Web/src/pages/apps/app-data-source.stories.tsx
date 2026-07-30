import type { Meta, StoryObj } from "@storybook/react-vite";
import { ws, type RequestHandler } from "msw";
import { expect, userEvent, within } from "storybook/test";
import {
    appsMocks,
    sampleCdcErrorBatchesFrame,
    sampleCdcErrors,
    sampleCdcStoppedErrors,
    sampleCdcStoppedFrame,
} from "@/mocks/apps-mocks";
import { AppDataSource } from "./app-data-source";

// Mirrors the WS-only relay route from `apps-mocks.ts`. A dedicated link is built here
// because the Connecting/FeedLost stories below need to control the socket lifecycle
// itself (never sending a frame, or closing right away) instead of sending a frame.
const cdcProgressFeed = ws.link("*/api/apps/:slug/cdc/progress");

const meta = {
    title: "Apps/Data Source",
    component: AppDataSource,
    parameters: {
        page: { title: "Data source" },
        // The detail mock only resolves known slugs, so start on a sample app.
        router: { initialPath: "/apps/demo", path: "/apps/:slug" },
    },
} satisfies Meta<typeof AppDataSource>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// No batches yet and no stored errors: the timeline shows its waiting message and the
// health header reads idle.
export const Empty: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [
                    appsMocks.detail(),
                    appsMocks.cdcProgress({ Results: [{ TaskName: "cdc/demo-shop", Stats: [{ Performance: [] }] }] }),
                    appsMocks.cdcErrors([]),
                ],
            },
        },
    },
};

// The default progress frame includes a batch with script errors, and the default stored
// errors include documents affected by schema/connection issues.
export const WithErrors: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [appsMocks.detail(), appsMocks.cdcProgress(), appsMocks.cdcErrors()],
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        // The errors card surfaces the count and a "View errors" button; the messages live in
        // the sheet it opens, so click through and assert a stored error renders in the drawer.
        const viewErrors = await canvas.findByRole("button", { name: "View errors" });
        await userEvent.click(viewErrors);
        // The sheet renders in a portal outside canvasElement, so query the whole document.
        const screen = within(document.body);
        const [storedErrorMessage] = await screen.findAllByText(/ShippedAt|Price|change stream/i);
        await expect(storedErrorMessage).toBeVisible();
    },
};

// Case 1 — recoverable error batches: some documents fail to transform (Script processing)
// and one batch hits a transient Read error that is retried, but the sink keeps syncing (the
// newest batch is still in progress). The Errors card breaks the total down by step and the
// batch timeline shows the failed batches in red among the healthy ones.
export const ErrorBatches: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [
                    appsMocks.detail(),
                    appsMocks.cdcProgress(sampleCdcErrorBatchesFrame()),
                    appsMocks.cdcErrors(sampleCdcErrors),
                ],
            },
        },
    },
};

// Case 2 — the task stopped: a fatal error (the transform script failed to compile) faulted
// the sink, so the newest batch failed and nothing is in progress after it. The feed ends on
// a red batch with a "Faulted…" stop reason and the errors list explains the task stopped.
export const SyncStopped: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [
                    appsMocks.detail(),
                    appsMocks.cdcProgress(sampleCdcStoppedFrame()),
                    appsMocks.cdcErrors(sampleCdcStoppedErrors),
                ],
            },
        },
    },
};

// The socket connects but the feed never sends a frame (not even a heartbeat), so the live
// section never leaves the connecting state.
export const Connecting: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [
                    appsMocks.detail(),
                    cdcProgressFeed.addEventListener("connection", () => {
                        // Intentionally no `client.send(...)`.
                    }) as unknown as RequestHandler,
                    appsMocks.cdcErrors([]),
                ],
            },
        },
    },
};

// The socket closes right after connecting, so `useCdcLivePerformance` lands in its error
// state and the live section shows the retry affordance.
export const FeedLost: Story = {
    parameters: {
        msw: {
            handlers: {
                apps: [
                    appsMocks.detail(),
                    cdcProgressFeed.addEventListener("connection", ({ client }) => {
                        client.close();
                    }) as unknown as RequestHandler,
                    appsMocks.cdcErrors([]),
                ],
            },
        },
    },
};
