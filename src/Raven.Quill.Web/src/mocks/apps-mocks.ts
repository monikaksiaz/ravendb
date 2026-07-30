import { delay, http, HttpResponse, ws, type RequestHandler } from "msw";
import type {
    AiConnectionString,
    AppResponse,
    CdcError,
    ProvisionAgentResponse,
    SuggestAgentResponse,
} from "@/api/generated/server-api";
import type { AgentStreamEvent } from "@/api/custom-services/agent-stream";
import type { CdcLiveRawFrame } from "@/pages/apps/use-cdc-live-performance";
import { apiHttp } from "./api-http";
import { samplePropagatedConnectionStrings } from "./ai-connection-strings-mocks";

// WS-only relay route, so it has no generated client or `apiHttp` path to lean on.
// The pattern must start with "*": msw resolves other patterns through `new URL()`,
// and Chrome percent-encodes the "*" host (ws://%2A/...), so they never match.
const cdcProgressFeed = ws.link("*/api/apps/:slug/cdc/progress");

export const appsMocks = {
    list: (apps: AppResponse[] = sampleApps) => apiHttp.get("/api/apps", ({ response }) => response(200).json(apps)),
    // msw-storybook-addon's typings only know RequestHandler, but its runtime forwards
    // every handler to worker.use, which accepts WebSocket handlers since msw 2.6.
    cdcProgress: (frame: CdcLiveRawFrame = sampleCdcProgressFrame()) =>
        cdcProgressFeed.addEventListener("connection", ({ client }) => {
            client.send(JSON.stringify(frame));
        }) as unknown as RequestHandler,
    cdcErrors: (errors: CdcError[] = sampleCdcErrors) =>
        apiHttp.get("/api/apps/{slug}/cdc/errors", ({ response }) => response(200).json(errors)),
    detail: (apps: AppResponse[] = sampleApps) =>
        apiHttp.get("/api/apps/{slug}", ({ params, response }) => {
            const app = apps.find((candidate) => candidate.slug === params.slug);
            return app ? response(200).json(app) : response(404).json({ error: `Unknown app: ${params.slug}` });
        }),
    provisionAgent: (result: ProvisionAgentResponse = { agentId: "agents/sales" }) =>
        apiHttp.post("/api/apps/{slug}/setup/agent", ({ response }) => response(200).json(result)),
    // setup/try streams newline-delimited JSON events (not described by the OpenAPI
    // contract), so this mock uses plain msw instead of `apiHttp` — mirroring chatMocks.
    setupTry: (events: AgentStreamEvent[] = sampleAgentTestEvents, chunkDelayMs = 150) =>
        http.post("/api/apps/:slug/setup/try", () => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    for (const event of events) {
                        await delay(chunkDelayMs);
                        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                    }

                    controller.close();
                },
            });

            return new HttpResponse(stream, { headers: { "Content-Type": "application/x-ndjson" } });
        }),
    suggestAgent: (suggestion: SuggestAgentResponse = sampleAgentSuggestion) =>
        apiHttp.post("/api/apps/{slug}/suggest/agent", ({ response }) => response(200).json(suggestion)),
    aiConnectionStringsList: (connectionStrings: AiConnectionString[] = samplePropagatedConnectionStrings) =>
        apiHttp.get("/api/apps/{slug}/connection-strings", ({ response }) => response(200).json(connectionStrings)),
};

export const sampleApps: AppResponse[] = [
    {
        id: "apps/1",
        slug: "demo",
        name: "Demo Shop",
        database: "demo-shop",
        cdcTaskName: "cdc/demo-shop",
        createdAt: "2026-05-01T10:00:00Z",
    },
    {
        id: "apps/2",
        slug: "support",
        name: "Support Desk",
        database: "support-desk",
        cdcTaskName: "cdc/support-desk",
        createdAt: "2026-05-12T08:30:00Z",
    },
];

export const sampleCdcErrors: CdcError[] = [
    {
        taskName: "cdc/demo-shop",
        createdAt: "2026-07-21T08:12:45Z",
        step: "Script processing",
        error: "TypeError: Cannot read properties of undefined (reading 'Price') at transform(orders) line 12",
        documentId: "orders/1042-A",
        affectedDocumentsCount: null,
    },
    {
        taskName: "cdc/demo-shop",
        createdAt: "2026-07-21T08:12:47Z",
        step: "Script processing",
        error: "Invalid date value '0000-00-00' in column ShippedAt; the value cannot be converted to a document property",
        documentId: "orders/1055-A",
        affectedDocumentsCount: null,
    },
    {
        taskName: "cdc/demo-shop",
        createdAt: "2026-07-21T08:14:02Z",
        step: "Read",
        error: "Connection to the source database was lost while reading the change stream; the batch will be retried",
        documentId: null,
        affectedDocumentsCount: 128,
    },
];

// Recent, now-relative batches so the live shaper reads them as an active feed.
export function sampleCdcProgressFrame(): CdcLiveRawFrame {
    return {
        Results: [
            {
                TaskName: "cdc/demo-shop",
                Stats: [
                    {
                        Performance: Array.from({ length: 51 }, (_, index) => {
                            const startedMs = Date.now() - 5_000 - index * 90_000;
                            const durationInMs = 900 + Math.round(Math.abs(Math.sin(index)) * 800);
                            const read = 480 + index * 7;

                            const scriptErrors = index === 2 ? 3 : 0;
                            const inProgress = index === 0;

                            const readDurationInMs = Math.round(durationInMs * 0.22);
                            const scriptDurationInMs = Math.round(durationInMs * 0.58);
                            const writeDurationInMs = durationInMs - readDurationInMs - scriptDurationInMs;

                            return {
                                Id: index,
                                Started: new Date(startedMs).toISOString(),
                                Completed: inProgress ? null : new Date(startedMs + durationInMs).toISOString(),
                                DurationInMs: durationInMs,
                                NumberOfReadMessages: read,
                                NumberOfProcessedMessages: read - scriptErrors,
                                ScriptProcessingErrorCount: scriptErrors,
                                ReadErrorCount: 0,
                                CurrentlyAllocated: { SizeInBytes: 2_000_000 + index * 40_000 },
                                BatchPullStopReason: inProgress ? "In progress" : "Batch size reached",
                                Details: {
                                    Name: "Batch",
                                    DurationInMs: durationInMs,
                                    Operations: [
                                        { Name: "Read", DurationInMs: readDurationInMs },
                                        { Name: "Script", DurationInMs: scriptDurationInMs },
                                        { Name: "Write", DurationInMs: writeDurationInMs },
                                    ],
                                },
                            };
                        }),
                    },
                ],
            },
        ],
    };
}

// Builds a now-relative progress frame (index 0 = newest) letting each batch declare its
// script/read error counts, whether it is still in progress, and a stop reason.
type BatchSpec = { scriptErrors?: number; readErrors?: number; inProgress?: boolean; stopReason?: string };

function buildCdcFrame(count: number, perBatch: (index: number) => BatchSpec): CdcLiveRawFrame {
    return {
        Results: [
            {
                TaskName: "cdc/demo-shop",
                Stats: [
                    {
                        Performance: Array.from({ length: count }, (_, index) => {
                            const spec = perBatch(index);
                            const scriptErrors = spec.scriptErrors ?? 0;
                            const readErrors = spec.readErrors ?? 0;
                            const inProgress = spec.inProgress ?? false;
                            const startedMs = Date.now() - 5_000 - index * 90_000;
                            const durationInMs = 900 + Math.round(Math.abs(Math.sin(index)) * 800);
                            const read = 480 + index * 7;
                            const readDurationInMs = Math.round(durationInMs * 0.22);
                            const scriptDurationInMs = Math.round(durationInMs * 0.58);
                            const writeDurationInMs = durationInMs - readDurationInMs - scriptDurationInMs;

                            return {
                                Id: index,
                                Started: new Date(startedMs).toISOString(),
                                Completed: inProgress ? null : new Date(startedMs + durationInMs).toISOString(),
                                DurationInMs: durationInMs,
                                NumberOfReadMessages: read,
                                NumberOfProcessedMessages: read - scriptErrors - readErrors,
                                ScriptProcessingErrorCount: scriptErrors,
                                ReadErrorCount: readErrors,
                                CurrentlyAllocated: { SizeInBytes: 2_000_000 + index * 40_000 },
                                BatchPullStopReason: spec.stopReason ?? (inProgress ? "In progress" : "Batch size reached"),
                                Details: {
                                    Name: "Batch",
                                    DurationInMs: durationInMs,
                                    Operations: [
                                        { Name: "Read", DurationInMs: readDurationInMs },
                                        { Name: "Script", DurationInMs: scriptDurationInMs },
                                        { Name: "Write", DurationInMs: writeDurationInMs },
                                    ],
                                },
                            };
                        }),
                    },
                ],
            },
        ],
    };
}

// Recoverable per-batch errors while the sink keeps running: two batches fail to transform
// some documents (script errors), one hits a transient read error that is retried, and the
// newest batch is still in progress — so the feed stays active.
export function sampleCdcErrorBatchesFrame(): CdcLiveRawFrame {
    return buildCdcFrame(14, (index) => ({
        scriptErrors: index === 3 || index === 9 ? 4 : 0,
        readErrors: index === 6 ? 2 : 0,
        inProgress: index === 0,
        stopReason: index === 6 ? "Read error — retrying" : undefined,
    }));
}

// A fatal error stopped the task: the newest batch faulted (the transform script failed to
// compile) and nothing is in progress after it, so the feed ends on a failed batch and
// produces no more.
export function sampleCdcStoppedFrame(): CdcLiveRawFrame {
    return buildCdcFrame(9, (index) => ({
        scriptErrors: index === 0 ? 6 : 0,
        inProgress: false,
        stopReason: index === 0 ? "Faulted: transformation script failed to compile" : undefined,
    }));
}

// The stored error that explains a stopped task: a fatal, task-level failure rather than a
// single bad document.
export const sampleCdcStoppedErrors: CdcError[] = [
    {
        taskName: "cdc/demo-shop",
        createdAt: "2026-07-21T08:20:11Z",
        step: "Script processing",
        error:
            "SyntaxError: Unexpected token '}' in transform(orders) at line 3 — the transformation script failed to " +
            "compile. The CDC task has stopped; fix the script and re-enable the sink.",
        documentId: null,
        affectedDocumentsCount: null,
    },
    {
        taskName: "cdc/demo-shop",
        createdAt: "2026-07-21T08:20:11Z",
        step: "Read",
        error: "The change stream was closed because the task stopped after the fatal script error above.",
        documentId: null,
        affectedDocumentsCount: 512,
    },
];

export const sampleAgentSuggestion: SuggestAgentResponse = {
    configurations: [
        {
            identifier: "sales-assistant",
            name: "Sales assistant",
            connectionStringName: "openai-chat",
            systemPrompt: "You help customers of the Demo Shop find products and check their orders.",
            sampleObject: JSON.stringify(
                {
                    reply: "A helpful answer to the customer's question.",
                    relatedProducts: "Up to three product names worth suggesting.",
                },
                null,
                4,
            ),
            queries: [
                {
                    name: "search-products",
                    description: "Search products by name.",
                    query: "from Products where search(Name, $searchTerm)",
                },
            ],
            parameters: [{ name: "customerId", description: "Id of the signed-in customer." }],
        },
        {
            identifier: "order-tracker",
            name: "Order tracker",
            connectionStringName: "openai-chat",
            systemPrompt: "You answer questions about the status, contents, and shipping of a customer's orders.",
            sampleObject: JSON.stringify(
                {
                    reply: "A summary of the order status.",
                    estimatedDelivery: "Expected delivery date, if known.",
                },
                null,
                4,
            ),
            queries: [
                {
                    name: "recent-orders",
                    description: "List the customer's most recent orders.",
                    query: "from Orders where CustomerId == $customerId order by OrderedAt desc limit 5",
                },
                {
                    name: "order-details",
                    description: "Load a single order with its lines.",
                    query: "from Orders where id() == $orderId",
                },
            ],
            parameters: [{ name: "customerId", description: "Id of the signed-in customer." }],
        },
        {
            identifier: "inventory-analyst",
            name: "Inventory analyst",
            connectionStringName: "openai-chat",
            systemPrompt: "You help the shop staff spot low stock and summarize how products are selling.",
            sampleObject: JSON.stringify(
                {
                    reply: "An analysis of the requested products or stock levels.",
                    lowStockProducts: "Product names that need restocking soon.",
                },
                null,
                4,
            ),
            queries: [
                {
                    name: "low-stock",
                    description: "Find products running low on stock.",
                    query: "from Products where UnitsInStock < $threshold order by UnitsInStock",
                },
            ],
            parameters: [],
        },
    ],
    rationale: ["The database contains products and orders, so a shopping assistant fits well."],
    status: "Success",
};

export const sampleAgentTestEvents: AgentStreamEvent[] = [
    { type: "chunk", text: "Sure! " },
    { type: "chunk", text: "Based on the demo data, " },
    { type: "chunk", text: "I can help you find products and check orders." },
    {
        type: "done",
        answer: { reply: "Sure! Based on the demo data, I can help you find products and check orders." },
        // The full structured model output the wizard renders as JSON (server's `fullAnswer`).
        fullAnswer: {
            reply: "Sure! Based on the demo data, I can help you find products and check orders.",
            relatedProducts: ["Wireless Mouse", "USB-C Hub", "Laptop Stand"],
        },
        // The query tools the agent ran this turn (server's `toolCalls`): the RQL, the parameters
        // the model filled in, and the rows the query returned.
        toolCalls: [
            {
                id: "call_1",
                name: "search-products",
                description: "Search products by name.",
                query: "from Products where search(Name, $searchTerm)",
                arguments: JSON.stringify({ searchTerm: "mouse" }),
                result: JSON.stringify([
                    { Name: "Wireless Mouse", Price: 24.99 },
                    { Name: "USB-C Hub", Price: 39.0 },
                    { Name: "Laptop Stand", Price: 29.5 },
                ]),
            },
        ],
        conversationId: "chats/test",
    },
];
