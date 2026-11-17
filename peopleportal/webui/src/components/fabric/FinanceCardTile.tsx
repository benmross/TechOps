import { CreditCard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cardStatus, type FinanceRequest } from "@/commons/finance-api";

const money = (cents: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(cents / 100);

export function FinanceCardTile({
    request,
    team,
    own,
    onOpen,
}: {
    request: FinanceRequest;
    team: string;
    own: boolean;
    onOpen(): void;
}) {
    const allocated = request.reservedCents ?? request.approvedCents;
    const known =
        typeof request.settledCents === "number" &&
        typeof request.heldCents === "number" &&
        allocated !== null;
    const spent = request.settledCents ?? 0;
    const held = request.heldCents ?? 0;
    const remaining = known ? allocated! - spent - held : null;
    const settledWidth =
        known && allocated! > 0
            ? Math.min(100, Math.max(0, (spent / allocated!) * 100))
            : 0;
    const heldWidth =
        known && allocated! > 0
            ? Math.min(
                  100 - settledWidth,
                  Math.max(0, (held / allocated!) * 100),
              )
            : 0;
    const frozen = request.cardStatus === "inactive";
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`View card: ${request.purpose}`}
            className="min-w-0 rounded-xl border bg-card p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex min-w-0 items-start gap-2 text-sm font-medium">
                    <CreditCard className="mt-0.5 size-4 shrink-0 text-violet-500" />
                    <span className="break-words">{team}</span>
                </span>
                <Badge
                    variant="secondary"
                    className={
                        frozen
                            ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                            : request.cardStatus === "active"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : ""
                    }
                >
                    {cardStatus(request)}
                </Badge>
            </div>
            <p className="mt-5 break-words text-base font-medium">
                {request.purpose}
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
                {own ? "Your card" : `Custodian ${request.requesterPk}`} ·{" "}
                {request.last4
                    ? `•••• ${request.last4}`
                    : "Card details pending"}
            </p>
            <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                <div>
                    <p className="text-xs text-muted-foreground">
                        {remaining !== null && remaining < 0
                            ? "Over allocated commitment"
                            : "Unspent reserved allocation"}
                    </p>
                    <p
                        className={
                            "mt-1 text-2xl font-semibold tabular-nums" +
                            (remaining !== null && remaining < 0
                                ? " text-destructive"
                                : "")
                        }
                    >
                        {remaining === null
                            ? "Unavailable"
                            : money(Math.abs(remaining))}
                    </p>
                </div>
                <span className="text-xs text-muted-foreground">
                    {request.approvedCents === null
                        ? "Limit pending"
                        : money(request.approvedCents)}
                    {request.interval === "monthly"
                        ? " / month"
                        : " total limit"}
                </span>
            </div>
            {known ? (
                <>
                    <div
                        className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted"
                        aria-hidden="true"
                    >
                        <div
                            className="bg-violet-500"
                            style={{ width: `${settledWidth}%` }}
                        />
                        <div
                            className="bg-amber-400"
                            style={{ width: `${heldWidth}%` }}
                        />
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                        <span>{money(spent)} settled</span>
                        <span>{money(held)} pending</span>
                    </div>
                </>
            ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                    Spending totals unavailable. Refresh to retry.
                </p>
            )}
            {request.interval === "monthly" && allocated !== null && (
                <p className="mt-3 text-xs text-muted-foreground">
                    {money(allocated)} reserved across all covered UTC months.
                    Spending shown across the card's lifetime.
                </p>
            )}
            {request.needsAttention && (
                <p className="mt-3 text-sm text-destructive">
                    Finance attention required
                </p>
            )}
        </button>
    );
}
