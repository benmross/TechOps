import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from "react";
import { CreditCard, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import {
    financeApi,
    cardStatus,
    parseCents,
    type FinanceContext,
    type FinanceRequest,
    type FinanceDetail,
    type FinanceBudget,
    type FinanceTeamBudget,
} from "@/commons/finance-api";
import { IssuingCardDetails } from "@/components/fabric/IssuingCardDetails";

const money = (cents: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(cents / 100);
const fieldClass =
    "border-input bg-background h-10 w-full rounded-md border px-3 text-sm";
const message = (error: unknown) =>
    error instanceof Error
        ? error.message
        : "Finance is unavailable. Try again.";

export function FinanceCards() {
    const [context, setContext] = useState<FinanceContext | null>(null);
    const [requests, setRequests] = useState<FinanceRequest[]>([]);
    const [budget, setBudget] = useState<FinanceBudget | null>(null);
    const [teamBudgets, setTeamBudgets] = useState<FinanceTeamBudget[]>([]);
    const [detail, setDetail] = useState<FinanceDetail | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [actionError, setActionError] = useState("");
    const [notice, setNotice] = useState("");
    const [creating, setCreating] = useState(false);
    const [showCard, setShowCard] = useState(false);
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("All requests");
    const [hasMore, setHasMore] = useState(false);
    const createAttempt = useRef<{ payload: string; id: string } | null>(null);
    const actionInFlight = useRef(false);

    const refresh = useCallback(async (signal?: AbortSignal) => {
        const current = await financeApi<FinanceContext>(
            "context",
            "GET",
            undefined,
            signal,
        );
        const [rows, allocation, envelopes] = await Promise.all([
            financeApi<FinanceRequest[]>("requests", "GET", undefined, signal),
            current.reviewer
                ? financeApi<FinanceBudget>("budget", "GET", undefined, signal)
                : Promise.resolve(null),
            current.reviewer
                ? financeApi<FinanceTeamBudget[]>(
                      "team-budgets",
                      "GET",
                      undefined,
                      signal,
                  )
                : Promise.resolve([]),
        ]);
        if (signal?.aborted) return;
        setContext(current);
        setRequests(rows);
        setHasMore(rows.length === 50);
        setBudget(allocation);
        setTeamBudgets(envelopes);
        setError("");
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal)
            .catch((e) => {
                if (!controller.signal.aborted) setError(message(e));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [refresh]);
    const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
        const next = await financeApi<FinanceDetail>(
            `requests/${id}`,
            "GET",
            undefined,
            signal,
        );
        if (!signal?.aborted && selectedRef.current === id) setDetail(next);
    }, []);
    useEffect(() => {
        setDetail(null);
        setShowCard(false);
        setActionError("");
        setNotice("");
        if (!selected) return;
        const controller = new AbortController();
        const update = () =>
            void loadDetail(selected, controller.signal).catch((e) => {
                if (!controller.signal.aborted) setActionError(message(e));
            });
        update();
        const interval = setInterval(update, 15000);
        return () => {
            controller.abort();
            clearInterval(interval);
        };
    }, [selected, loadDetail]);

    async function run(action: () => Promise<void>) {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        setBusy(true);
        setActionError("");
        setNotice("");
        try {
            await action();
        } catch (e) {
            setActionError(message(e));
        } finally {
            actionInFlight.current = false;
            setBusy(false);
        }
    }
    async function mutate(path: string, method: string, body: unknown = {}) {
        await financeApi(path, method, body);
        setShowCard(false);
        setNotice(
            "Saved. Card changes take effect after Stripe reconciliation.",
        );
        await refresh();
        if (selected) await loadDetail(selected);
    }
    function create(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void run(async () => {
            const team = context?.teams.find(
                (t) => t.subteamPk === values.get("subteam"),
            );
            if (!team) throw new Error("Select one of your current subteams.");
            const payload = {
                rootTeamPk: team.rootTeamPk,
                subteamPk: team.subteamPk,
                purpose: String(values.get("purpose") || "").trim(),
                vendor: String(values.get("vendor") || "").trim(),
                requestedCents: parseCents(String(values.get("amount"))),
                interval: String(values.get("interval")),
                neededUntil: new Date(
                    `${values.get("until")}T23:59:59.999Z`,
                ).toISOString(),
            };
            const serialized = JSON.stringify(payload);
            if (createAttempt.current?.payload !== serialized)
                createAttempt.current = {
                    payload: serialized,
                    id: crypto.randomUUID(),
                };
            await financeApi("requests", "POST", {
                ...payload,
                clientRequestId: createAttempt.current.id,
            });
            createAttempt.current = null;
            setCreating(false);
            setTab("All requests");
            setQuery("");
            await refresh();
        });
    }
    function review(
        event: FormEvent<HTMLFormElement>,
        decision: "approve" | "decline",
    ) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        if (!detail) return;
        void run(() =>
            mutate(`requests/${detail.request.id}/${decision}`, "POST", {
                note: String(values.get("note") || "").trim(),
                ...(decision === "approve"
                    ? {
                          approvedCents: parseCents(
                              String(values.get("approvedAmount")),
                          ),
                      }
                    : {}),
            }),
        );
    }
    async function more() {
        const last = requests.at(-1);
        if (!last) return;
        const next = await financeApi<FinanceRequest[]>(
            `requests?before=${encodeURIComponent(last.id)}`,
        );
        setRequests((rows) => [
            ...rows,
            ...next.filter((r) => !rows.some((old) => old.id === r.id)),
        ]);
        setHasMore(next.length === 50);
    }
    const label = (r: FinanceRequest) => {
        const team = context?.teams.find((t) => t.subteamPk === r.subteamPk);
        return team
            ? `${team.team} / ${team.subteam}`
            : `${teamBudgets.find((t) => t.rootTeamPk === r.rootTeamPk)?.name || r.rootTeamPk} / ${r.subteamPk}`;
    };
    const pending = requests.filter((r) => r.status === "pending");
    const visible = requests.filter(
        (r) =>
            (tab !== "Pending" || r.status === "pending") &&
            (tab !== "Cards" || r.status === "issued") &&
            `${r.purpose} ${r.vendor} ${label(r)}`
                .toLowerCase()
                .includes(query.toLowerCase()),
    );
    const request = detail?.request;
    const canReview =
        context?.reviewer &&
        request?.status === "pending" &&
        request.requesterPk !== context.userPk;
    const canControl =
        context?.reviewer &&
        request?.status === "issued" &&
        request.cardStatus !== "canceled" &&
        request.desiredCardStatus !== "canceled" &&
        new Date(request.neededUntil) > new Date();
    const canReveal =
        request?.requesterPk === context?.userPk &&
        request?.status === "issued" &&
        request.cardId &&
        request.cardStatus !== "canceled" &&
        request.desiredCardStatus !== "canceled" &&
        new Date(request.neededUntil) > new Date();

    return (
        <div className="mx-auto w-full max-w-7xl space-y-6 pb-8">
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-4 text-sm">
                Stripe Issuing sandbox. Cards and spending are in test mode.
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-semibold">Virtual cards</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Request a budget for your subteam and track finance
                        decisions and card spending.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="outline"
                        disabled={busy || loading}
                        onClick={() => void run(refresh)}
                    >
                        <RefreshCw className="mr-2 size-4" />
                        Refresh
                    </Button>
                    <Button
                        disabled={!context?.teams.length || busy || !!error}
                        onClick={() => {
                            setActionError("");
                            setCreating(true);
                        }}
                    >
                        <Plus className="mr-2 size-4" />
                        Request a card
                    </Button>
                </div>
            </div>
            {loading && <p role="status">Loading virtual cards…</p>}
            {error && <p role="alert">{error}</p>}
            {!selected && !creating && actionError && (
                <p role="alert">{actionError}</p>
            )}
            {budget && (
                <div className="grid gap-4 sm:grid-cols-3">
                    {[
                        ["Allocation ceiling", budget.totalCents],
                        ["Reserved allocations", budget.reservedCents],
                        [
                            "Available to approve",
                            budget.totalCents - budget.reservedCents,
                        ],
                    ].map(([title, amount]) => (
                        <Card key={title} className="shadow-none">
                            <CardContent className="p-5">
                                <p className="text-sm text-muted-foreground">
                                    {title}
                                </p>
                                <p className="mt-3 text-2xl font-semibold">
                                    {money(Number(amount))}
                                </p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
            {budget && (
                <p className="text-xs text-muted-foreground">
                    The allocation ceiling is separate from the funded Stripe
                    balance. Monthly requests reserve every covered UTC month;
                    canceled allocations remain reserved.
                </p>
            )}
            {context?.reviewer && (
                <section
                    className="space-y-4 rounded-xl border p-5"
                    aria-label="Team allocations"
                >
                    <h2 className="text-lg font-medium">
                        Team allocation ceilings
                    </h2>
                    {teamBudgets.map((team) => (
                        <div
                            key={team.rootTeamPk}
                            className="flex flex-wrap justify-between gap-3 text-sm"
                        >
                            <span>{team.name}</span>
                            <span>
                                {money(team.reservedCents)} committed of{" "}
                                {money(team.totalCents)}
                            </span>
                        </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                        Set a team's ceiling from one of its requests. All of
                        its subteams and cards share that ceiling.
                    </p>
                    <form
                        className="flex flex-wrap items-end gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            void run(() =>
                                mutate("budget", "PUT", {
                                    totalCents: parseCents(
                                        String(values.get("clubCeiling")),
                                    ),
                                }),
                            );
                        }}
                    >
                        <div className="space-y-2">
                            <Label htmlFor="clubCeiling">
                                Club allocation ceiling (USD)
                            </Label>
                            <Input
                                id="clubCeiling"
                                name="clubCeiling"
                                inputMode="decimal"
                                required
                                defaultValue={
                                    budget
                                        ? (budget.totalCents / 100).toFixed(2)
                                        : ""
                                }
                            />
                        </div>
                        <Button disabled={busy} variant="outline">
                            Set club ceiling
                        </Button>
                    </form>
                </section>
            )}
            {!loading && !error && (
                <section
                    className="overflow-hidden rounded-xl border"
                    aria-label="Card requests"
                >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
                        <div className="flex flex-wrap gap-1">
                            {["All requests", "Pending", "Cards"].map(
                                (name) => (
                                    <Button
                                        key={name}
                                        variant={
                                            tab === name ? "secondary" : "ghost"
                                        }
                                        aria-pressed={tab === name}
                                        onClick={() => setTab(name)}
                                    >
                                        {name}
                                        {name === "Pending"
                                            ? ` (${pending.length})`
                                            : ""}
                                    </Button>
                                ),
                            )}
                        </div>
                        <Input
                            aria-label="Search requests"
                            placeholder="Search requests"
                            className="sm:w-64"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </div>
                    {visible.map((r) => (
                        <button
                            key={r.id}
                            onClick={() => setSelected(r.id)}
                            className="flex w-full flex-wrap items-center justify-between gap-4 border-b p-5 text-left hover:bg-muted/40"
                        >
                            <div>
                                <p className="font-medium">{r.purpose}</p>
                                <p className="text-sm text-muted-foreground">
                                    {label(r)} · {r.vendor}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {r.requesterPk === context?.userPk
                                        ? "Your request"
                                        : `Member ${r.requesterPk}`}
                                    {r.last4 && ` · •••• ${r.last4}`}
                                </p>
                            </div>
                            <div className="space-y-2 text-right">
                                <p>
                                    {money(r.approvedCents ?? r.requestedCents)}
                                    {r.interval === "monthly" ? " / month" : ""}
                                </p>
                                <Badge variant="secondary">
                                    {cardStatus(r)}
                                </Badge>
                                {r.needsAttention && (
                                    <p className="text-sm text-destructive">
                                        Finance attention required
                                    </p>
                                )}
                            </div>
                        </button>
                    ))}
                    {!visible.length && (
                        <p className="p-8 text-center text-muted-foreground">
                            No requests in this view.
                        </p>
                    )}
                    {hasMore && (
                        <Button
                            className="m-4"
                            disabled={busy}
                            variant="outline"
                            onClick={() => void run(more)}
                        >
                            Load older requests
                        </Button>
                    )}
                </section>
            )}
            <Dialog
                open={creating}
                onOpenChange={(open) => {
                    if (!busy) setCreating(open);
                }}
            >
                <DialogContent className="max-h-[90dvh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Request a virtual card</DialogTitle>
                        <DialogDescription>
                            Finance reviews your request before issuing a test
                            card.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={create} className="space-y-4">
                        <Label htmlFor="subteam">Subteam</Label>
                        <select
                            id="subteam"
                            name="subteam"
                            className={fieldClass}
                            required
                        >
                            {context?.teams.map((t) => (
                                <option key={t.subteamPk} value={t.subteamPk}>
                                    {t.team} / {t.subteam}
                                </option>
                            ))}
                        </select>
                        <Label htmlFor="purpose">Purpose</Label>
                        <Textarea
                            id="purpose"
                            name="purpose"
                            required
                            maxLength={1000}
                        />
                        <Label htmlFor="vendor">Vendor</Label>
                        <Input
                            id="vendor"
                            name="vendor"
                            required
                            maxLength={200}
                        />
                        <Label htmlFor="amount">Requested amount (USD)</Label>
                        <Input
                            id="amount"
                            name="amount"
                            inputMode="decimal"
                            required
                        />
                        <Label htmlFor="interval">Spending interval</Label>
                        <select
                            id="interval"
                            name="interval"
                            className={fieldClass}
                        >
                            <option value="all_time">One-time</option>
                            <option value="monthly">Monthly</option>
                        </select>
                        <Label htmlFor="until">Needed through (UTC)</Label>
                        <Input
                            id="until"
                            name="until"
                            type="date"
                            min={new Date().toISOString().slice(0, 10)}
                            max={new Date(Date.now() + 365 * 86400000)
                                .toISOString()
                                .slice(0, 10)}
                            required
                        />
                        {actionError && <p role="alert">{actionError}</p>}
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving…" : "Send to finance"}
                        </Button>
                    </form>
                </DialogContent>
            </Dialog>
            <Sheet
                open={!!selected}
                onOpenChange={(open) => {
                    if (!open && !busy) setSelected(null);
                }}
            >
                <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-xl">
                    <SheetHeader>
                        <SheetTitle>
                            {request?.purpose || "Card request"}
                        </SheetTitle>
                        <SheetDescription>
                            {request
                                ? `${label(request)} · ${request.vendor}`
                                : "Loading request details…"}
                        </SheetDescription>
                    </SheetHeader>
                    {actionError && (
                        <p className="mt-4" role="alert">
                            {actionError}
                        </p>
                    )}
                    {notice && (
                        <p className="mt-4" role="status">
                            {notice}
                        </p>
                    )}
                    {request && detail && (
                        <div className="mt-6 space-y-6">
                            <Badge variant="secondary">
                                {cardStatus(request)}
                            </Badge>
                            <dl className="grid grid-cols-2 gap-3 text-sm">
                                <dt>Requested</dt>
                                <dd>{money(request.requestedCents)}</dd>
                                <dt>Approved</dt>
                                <dd>
                                    {request.approvedCents === null
                                        ? "Awaiting decision"
                                        : money(request.approvedCents)}
                                </dd>
                                <dt>Reserved</dt>
                                <dd>{money(request.reservedCents ?? 0)}</dd>
                                <dt>Settled spending</dt>
                                <dd>{money(detail.settledCents)}</dd>
                                <dt>Pending holds</dt>
                                <dd>{money(detail.heldCents)}</dd>
                                <dt>Needed through</dt>
                                <dd>
                                    {new Date(
                                        request.neededUntil,
                                    ).toLocaleDateString()}
                                </dd>
                            </dl>
                            {request.reviewNote && (
                                <p className="text-sm">
                                    Finance: {request.reviewNote}
                                </p>
                            )}
                            {request.needsAttention && (
                                <p
                                    role="status"
                                    className="text-sm text-destructive"
                                >
                                    Finance needs to investigate this card in
                                    Stripe.
                                </p>
                            )}
                            {context?.reviewer && (
                                <section className="space-y-4 rounded-lg border p-4">
                                    <h2 className="font-medium">
                                        Finance setup
                                    </h2>
                                    <form
                                        className="space-y-3"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            const values = new FormData(
                                                event.currentTarget,
                                            );
                                            void run(() =>
                                                mutate(
                                                    `team-budgets/${request.rootTeamPk}`,
                                                    "PUT",
                                                    {
                                                        totalCents:
                                                            Number(
                                                                values.get(
                                                                    "teamCeiling",
                                                                ),
                                                            ) === 0
                                                                ? 0
                                                                : parseCents(
                                                                      String(
                                                                          values.get(
                                                                              "teamCeiling",
                                                                          ),
                                                                      ),
                                                                  ),
                                                    },
                                                ),
                                            );
                                        }}
                                    >
                                        <Label htmlFor="teamCeiling">
                                            This team's allocation ceiling (USD)
                                        </Label>
                                        <Input
                                            key={request.rootTeamPk}
                                            id="teamCeiling"
                                            name="teamCeiling"
                                            inputMode="decimal"
                                            required
                                            defaultValue={(
                                                (teamBudgets.find(
                                                    (t) =>
                                                        t.rootTeamPk ===
                                                        request.rootTeamPk,
                                                )?.totalCents ?? 0) / 100
                                            ).toFixed(2)}
                                        />
                                        <Button
                                            disabled={busy}
                                            variant="outline"
                                        >
                                            Set team ceiling
                                        </Button>
                                    </form>
                                    <form
                                        className="space-y-3"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            const values = new FormData(
                                                event.currentTarget,
                                            );
                                            void run(() =>
                                                mutate(
                                                    `cardholders/${request.requesterPk}`,
                                                    "PUT",
                                                    {
                                                        stripeCardholderId:
                                                            String(
                                                                values.get(
                                                                    "cardholderId",
                                                                ),
                                                            ),
                                                    },
                                                ),
                                            );
                                        }}
                                    >
                                        <Label htmlFor="cardholderId">
                                            Custodian's onboarded Stripe
                                            cardholder ID
                                        </Label>
                                        <Input
                                            id="cardholderId"
                                            name="cardholderId"
                                            pattern="ich_[a-zA-Z0-9]+"
                                            placeholder="ich_…"
                                            required
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Complete cardholder onboarding in
                                            Stripe first. This links the
                                            cardholder to this requester and
                                            cannot be reassigned here.
                                        </p>
                                        <Button
                                            disabled={busy}
                                            variant="outline"
                                        >
                                            Link cardholder
                                        </Button>
                                    </form>
                                </section>
                            )}
                            {canReview && (
                                <form
                                    key={request.id}
                                    className="space-y-3"
                                    onSubmit={(e) => review(e, "approve")}
                                >
                                    <Label htmlFor="approvedAmount">
                                        Approve amount (USD)
                                    </Label>
                                    <Input
                                        id="approvedAmount"
                                        name="approvedAmount"
                                        defaultValue={(
                                            request.requestedCents / 100
                                        ).toFixed(2)}
                                        inputMode="decimal"
                                    />
                                    <Label htmlFor="note">Decision note</Label>
                                    <Textarea
                                        id="note"
                                        name="note"
                                        required
                                        maxLength={1000}
                                    />
                                    <div className="flex flex-wrap gap-2">
                                        <Button disabled={busy} type="submit">
                                            Approve and queue issuance
                                        </Button>
                                        <Button
                                            disabled={busy}
                                            variant="outline"
                                            type="button"
                                            onClick={(e) => {
                                                const form =
                                                    e.currentTarget.form;
                                                if (form?.reportValidity())
                                                    review(
                                                        {
                                                            preventDefault() {},
                                                            currentTarget: form,
                                                        } as FormEvent<HTMLFormElement>,
                                                        "decline",
                                                    );
                                            }}
                                        >
                                            Decline
                                        </Button>
                                    </div>
                                </form>
                            )}
                            {canControl && (
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        disabled={busy}
                                        variant="outline"
                                        onClick={() =>
                                            void run(() =>
                                                mutate(
                                                    `requests/${request.id}/card-status`,
                                                    "PUT",
                                                    {
                                                        status:
                                                            request.desiredCardStatus ===
                                                            "active"
                                                                ? "inactive"
                                                                : "active",
                                                    },
                                                ),
                                            )
                                        }
                                    >
                                        {request.desiredCardStatus === "active"
                                            ? "Freeze card"
                                            : "Resume card"}
                                    </Button>
                                    <Button
                                        disabled={busy}
                                        variant="destructive"
                                        onClick={() => {
                                            if (
                                                window.confirm(
                                                    "Cancel this test card permanently? Its allocation stays reserved.",
                                                )
                                            )
                                                void run(() =>
                                                    mutate(
                                                        `requests/${request.id}/card-status`,
                                                        "PUT",
                                                        { status: "canceled" },
                                                    ),
                                                );
                                        }}
                                    >
                                        Cancel card
                                    </Button>
                                </div>
                            )}
                            {context?.reviewer && (
                                <Button
                                    disabled={busy}
                                    variant="outline"
                                    onClick={() =>
                                        void run(() =>
                                            mutate(
                                                `requests/${request.id}/reconcile`,
                                                "POST",
                                            ),
                                        )
                                    }
                                >
                                    <RefreshCw className="mr-2 size-4" />
                                    Reconcile with Stripe
                                </Button>
                            )}
                            {canReveal && context?.publishableKey && (
                                <>
                                    <Button
                                        variant="outline"
                                        onClick={() => setShowCard(!showCard)}
                                    >
                                        <CreditCard className="mr-2 size-4" />
                                        {showCard
                                            ? "Hide card details"
                                            : "Show card details"}
                                    </Button>
                                    {showCard && (
                                        <IssuingCardDetails
                                            requestId={request.id}
                                            cardId={request.cardId!}
                                            publishableKey={
                                                context.publishableKey
                                            }
                                        />
                                    )}
                                </>
                            )}
                            <section className="space-y-3">
                                <h2 className="font-medium">Spending</h2>
                                {detail.entries.length ? (
                                    detail.entries.map((entry) => (
                                        <div
                                            key={entry.id}
                                            className="flex justify-between gap-3 text-sm"
                                        >
                                            <span>
                                                {entry.merchant || entry.kind} ·{" "}
                                                {entry.status}
                                            </span>
                                            <span>
                                                {money(
                                                    entry.kind === "transaction"
                                                        ? -entry.amount
                                                        : entry.amount,
                                                )}
                                            </span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-sm text-muted-foreground">
                                        No spending recorded.
                                    </p>
                                )}
                            </section>
                            <section className="space-y-3">
                                <h2 className="font-medium">Activity</h2>
                                {detail.audit.map((entry, i) => (
                                    <p
                                        key={i}
                                        className="text-sm text-muted-foreground"
                                    >
                                        {entry.action.replaceAll("_", " ")} ·{" "}
                                        {new Date(entry.at).toLocaleString(
                                            "en-US",
                                            { hour12: true },
                                        )}
                                        {entry.detail && ` · ${entry.detail}`}
                                    </p>
                                ))}
                            </section>
                        </div>
                    )}
                </SheetContent>
            </Sheet>
        </div>
    );
}
