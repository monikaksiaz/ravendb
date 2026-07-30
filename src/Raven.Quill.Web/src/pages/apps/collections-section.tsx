import { useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { api } from "@/api/api";
import type { DataCollectionDto } from "@/api/generated/server-api";
import { ApiState } from "@/components/data/api-state";
import { Badge } from "@/components/shadcn/ui/badge";
import { formatCompact } from "@/lib/format";

const fullNumberFormatter = new Intl.NumberFormat("en-US");

function CollectionRow({ collection }: { collection: DataCollectionDto }) {
    return (
        <li className="flex items-center justify-between gap-3 px-4 py-1.5 text-sm">
            <div className="flex min-w-0 items-center gap-2.5">
                <Database className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{collection.name}</span>
            </div>
            <span
                className="shrink-0 text-muted-foreground tabular-nums"
                title={`${fullNumberFormatter.format(collection.documentsCount)} documents`}
            >
                {formatCompact(collection.documentsCount)}
            </span>
        </li>
    );
}

export function CollectionsSection({ slug }: { slug: string }) {
    const collectionsQuery = useQuery(api.queries.stats.collections(slug));
    const collections = collectionsQuery.data ?? [];

    return (
        <section className="flex flex-col overflow-hidden rounded-xl border bg-card py-4">
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm">Collections</h2>
                    {collectionsQuery.data && (
                        <Badge variant="secondary" className="font-mono">
                            {collectionsQuery.data.length}
                        </Badge>
                    )}
                </div>
                <span className="text-xs font-medium text-muted-foreground">Documents</span>
            </div>
            <ApiState
                isLoading={collectionsQuery.isPending}
                isError={collectionsQuery.isError}
                errorTitle="Could not load collections"
                onRetry={() => void collectionsQuery.refetch()}
                loadingLabel="Loading collections..."
            >
                {collections.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">No collections yet.</p>
                ) : (
                    <ul className="flex flex-1 flex-col">
                        {collections.map((collection) => (
                            <CollectionRow key={collection.name} collection={collection} />
                        ))}
                    </ul>
                )}
            </ApiState>
        </section>
    );
}
