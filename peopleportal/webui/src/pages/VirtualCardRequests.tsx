import { useState } from "react";
import {
    ArrowDownLeft,
    ArrowUpRight,
    Check,
    ChevronRight,
    CreditCard,
    Plus,
    Search,
    ShieldCheck,
    Snowflake,
    Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSidebar } from "@/components/app-sidebar";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { toast } from "sonner";

type Status = "Pending" | "Active" | "Frozen" | "Declined";
type Request = {
    id: string;
    team: string;
    subteam: string;
    purpose: string;
    vendor: string;
    custodian: string;
    amount: number;
    spent: number;
    held: number;
    status: Status;
    cadence: "One-time" | "Monthly";
    until: string;
    last4?: string;
    note?: string;
    history: string[];
};
const money = (cents: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(cents / 100);
const teams: Record<string, string[]> = {
    MITRE: ["Engineering", "Leadership"],
    "Web Dev": ["Frontend", "Backend"],
    Infrastructure: ["Engineering"],
};
const initial: Request[] = [
    {
        id: "demo-mitre",
        team: "MITRE",
        subteam: "Engineering",
        purpose: "Model evaluation credits",
        vendor: "API provider",
        custodian: "Morgan Shah",
        amount: 20000,
        spent: 7600,
        held: 1200,
        status: "Active",
        cadence: "One-time",
        until: "2026-11-15",
        last4: "4242",
        history: [
            "Requested by Morgan Shah",
            "Approved by finance for $200.00",
            "Demo card activated",
        ],
    },
    {
        id: "demo-web",
        team: "Web Dev",
        subteam: "Frontend",
        purpose: "Design and testing tools",
        vendor: "Design software",
        custodian: "Taylor Hughes",
        amount: 35000,
        spent: 14600,
        held: 600,
        status: "Active",
        cadence: "Monthly",
        until: "2026-12-15",
        last4: "1881",
        history: [
            "Requested by Taylor Hughes",
            "Approved by finance for $350.00 per month",
            "Demo card activated",
        ],
    },
    {
        id: "demo-cloud",
        team: "Infrastructure",
        subteam: "Engineering",
        purpose: "Monitoring trial",
        vendor: "Monitoring provider",
        custodian: "You",
        amount: 5000,
        spent: 0,
        held: 0,
        status: "Pending",
        cadence: "One-time",
        until: "2026-11-12",
        history: ["Requested by you", "Awaiting finance review"],
    },
    {
        id: "demo-inference",
        team: "MITRE",
        subteam: "Engineering",
        purpose: "Inference experiment",
        vendor: "GPU provider",
        custodian: "Morgan Shah",
        amount: 12500,
        spent: 0,
        held: 0,
        status: "Pending",
        cadence: "One-time",
        until: "2026-11-20",
        history: ["Requested by Morgan Shah", "Awaiting finance review"],
    },
];
const fieldClass =
    "border-input bg-background h-10 w-full rounded-md border px-3 text-sm";
const statusStyle: Record<Status, string> = {
    Pending: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    Active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    Frozen: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    Declined: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

export function VirtualCardRequests() {
    const [requests, setRequests] = useState<Request[]>(initial);
    const [persona, setPersona] = useState<"member" | "finance">("member");
    const [tab, setTab] = useState<"All requests" | "Pending" | "Cards">(
        "All requests",
    );
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [team, setTeam] = useState("MITRE");
    const [error, setError] = useState("");
    const [reviewError, setReviewError] = useState("");
    const [reviewAmount, setReviewAmount] = useState("");
    const [reviewNote, setReviewNote] = useState("");
    const active = requests.filter(
        (r) => r.status === "Active" || r.status === "Frozen",
    );
    const pending = requests.filter((r) => r.status === "Pending");
    const allocated = active.reduce((sum, r) => sum + r.amount, 0);
    const settled = active.reduce((sum, r) => sum + r.spent, 0);
    const holds = active.reduce((sum, r) => sum + r.held, 0);
    const unallocated = 200000 - allocated;
    const visible = requests.filter(
        (r) =>
            (tab !== "Pending" || r.status === "Pending") &&
            (tab !== "Cards" ||
                r.status === "Active" ||
                r.status === "Frozen") &&
            `${r.team} ${r.subteam} ${r.purpose} ${r.custodian}`
                .toLowerCase()
                .includes(query.toLowerCase()),
    );
    const detail = requests.find((r) => r.id === selected);
    const canReview =
        persona === "finance" &&
        detail?.status === "Pending" &&
        detail.custodian !== "You";
    function openDetail(r: Request) {
        setSelected(r.id);
        setReviewAmount((r.amount / 100).toFixed(2));
        setReviewNote("");
        setReviewError("");
    }
    function update(id: string, changes: Partial<Request>, event: string) {
        setRequests((all) =>
            all.map((r) =>
                r.id === id
                    ? { ...r, ...changes, history: [...r.history, event] }
                    : r,
            ),
        );
    }
    function approve() {
        if (!detail || !canReview) return;
        const amount = Math.round(Number(reviewAmount) * 100);
        if (
            !/^\d+(\.\d{1,2})?$/.test(reviewAmount) ||
            amount <= 0 ||
            amount > detail.amount ||
            amount > unallocated
        ) {
            setReviewError(
                "Enter an amount above $0, no higher than the request or available budget.",
            );
            return;
        }
        update(
            detail.id,
            {
                status: "Active",
                amount,
                last4: "0000",
                note: reviewNote.trim(),
            },
            `Finance approved ${money(amount)}. ${reviewNote.trim()}`,
        );
        toast.success("Demo approval saved. A simulated card is ready.");
    }
    function create(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const raw = String(values.get("amount"));
        const amount = Math.round(Number(raw) * 100);
        const purpose = String(values.get("purpose") || "").trim();
        const vendor = String(values.get("vendor") || "").trim();
        const until = String(values.get("until"));
        if (
            !/^\d+(\.\d{1,2})?$/.test(raw) ||
            amount <= 0 ||
            amount > 200000 ||
            !purpose ||
            !vendor ||
            until <= new Date().toLocaleDateString("en-CA")
        ) {
            setError(
                "Add a purpose, vendor, future end date and amount between $0.01 and $2,000.",
            );
            return;
        }
        const request: Request = {
            id: crypto.randomUUID(),
            team,
            subteam: String(values.get("subteam")),
            purpose,
            vendor,
            custodian: "You",
            amount,
            spent: 0,
            held: 0,
            status: "Pending",
            cadence:
                values.get("cadence") === "Monthly" ? "Monthly" : "One-time",
            until,
            history: ["Requested by you", "Awaiting finance review"],
        };
        setRequests((all) => [request, ...all]);
        setCreating(false);
        setTab("Pending");
        setQuery("");
        toast.success("Demo request added to the review queue.");
    }
    return (
        <div className="mx-auto w-full max-w-7xl space-y-7 pb-8">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-500/5 px-4 py-3 text-sm">
                <p>
                    <span className="font-medium">Interactive preview</span>
                    <span className="text-muted-foreground">
                        {" "}
                        · Sample data. Changes reset on reload. No real cards or
                        money.
                    </span>
                </p>
                <label className="flex items-center gap-2 text-xs">
                    Preview as
                    <select
                        aria-label="Preview role"
                        className={fieldClass + " !h-8 !w-auto"}
                        value={persona}
                        onChange={(e) =>
                            setPersona(e.target.value as typeof persona)
                        }
                    >
                        <option value="member">Team lead</option>
                        <option value="finance">Finance reviewer</option>
                    </select>
                </label>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                        Finance / Team spending
                    </p>
                    <h1 className="text-3xl font-semibold tracking-tight">
                        Virtual cards
                    </h1>
                    <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                        Request a purchase budget for your subteam. Keep
                        approvals, cards and receipts in one place.
                    </p>
                </div>
                <Button
                    onClick={() => {
                        setCreating(true);
                        setError("");
                    }}
                >
                    <Plus className="mr-2 size-4" />
                    Request a card
                </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                    {
                        label: "Club budget",
                        amount: 200000,
                        caption: "Demo funding pool",
                        icon: Wallet,
                    },
                    {
                        label: "Available to approve",
                        amount: unallocated,
                        caption: "After reserving approved budgets",
                        icon: ArrowUpRight,
                    },
                    {
                        label: "Approved allocations",
                        amount: allocated,
                        caption: `${active.length} cards · ${money(allocated - settled - holds)} unspent, excluding holds`,
                        icon: CreditCard,
                    },
                    {
                        label: "Awaiting approval",
                        amount: pending.reduce((s, r) => s + r.amount, 0),
                        caption: `${pending.length} requests · funds not reserved yet`,
                        icon: ShieldCheck,
                    },
                ].map((item) => (
                    <Card key={item.label} className="shadow-none">
                        <CardContent className="p-5">
                            <div className="flex items-center justify-between text-sm text-muted-foreground">
                                {item.label}
                                <item.icon className="size-4" />
                            </div>
                            <p className="mt-4 text-2xl font-semibold tabular-nums">
                                {money(item.amount)}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                                {item.caption}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>
            <section aria-labelledby="cards-heading" className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 id="cards-heading" className="text-lg font-semibold">
                        Approved cards
                    </h2>
                    <span className="text-xs text-muted-foreground">
                        USD · Shared club funding
                    </span>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {active.map((r) => {
                        const remaining = r.amount - r.spent - r.held;
                        return (
                            <button
                                key={r.id}
                                onClick={() => openDetail(r)}
                                className="rounded-xl border bg-card p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                            >
                                <div className="flex items-center justify-between">
                                    <span className="flex items-center gap-2 text-sm font-medium">
                                        <CreditCard className="size-4 text-violet-500" />
                                        {r.team}
                                        <span className="font-normal text-muted-foreground">
                                            / {r.subteam}
                                        </span>
                                    </span>
                                    <Badge
                                        className={statusStyle[r.status]}
                                        variant="secondary"
                                    >
                                        {r.status}
                                    </Badge>
                                </div>
                                <p className="mt-5 text-base font-medium">
                                    {r.purpose}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {r.custodian} · Demo •••• {r.last4}
                                </p>
                                <div className="mt-5 flex items-end justify-between">
                                    <div>
                                        <p className="text-xs text-muted-foreground">
                                            Remaining allocation
                                        </p>
                                        <p className="mt-1 text-2xl font-semibold tabular-nums">
                                            {money(remaining)}
                                        </p>
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        of {money(r.amount)}
                                        {r.cadence === "Monthly"
                                            ? " / month"
                                            : " total"}
                                    </span>
                                </div>
                                <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
                                    <div
                                        className="bg-violet-500"
                                        style={{
                                            width: `${(r.spent / r.amount) * 100}%`,
                                        }}
                                    />
                                    <div
                                        className="bg-amber-400"
                                        style={{
                                            width: `${(r.held / r.amount) * 100}%`,
                                        }}
                                    />
                                </div>
                                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                                    <span>{money(r.spent)} settled</span>
                                    <span>{money(r.held)} pending</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </section>
            <section
                aria-labelledby="requests-heading"
                className="overflow-hidden rounded-xl border"
            >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                    <h2 id="requests-heading" className="text-lg font-semibold">
                        Requests
                    </h2>
                    <div className="relative">
                        <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
                        <Input
                            aria-label="Search requests"
                            placeholder="Search team, purpose or person"
                            className="w-full pl-9 sm:w-72"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </div>
                </div>
                <div
                    className="flex gap-1 overflow-x-auto border-b px-4 py-2"
                    aria-label="Request filters"
                >
                    {(["All requests", "Pending", "Cards"] as const).map(
                        (t) => (
                            <Button
                                key={t}
                                variant={tab === t ? "secondary" : "ghost"}
                                size="sm"
                                aria-pressed={tab === t}
                                onClick={() => setTab(t)}
                            >
                                {t}
                                {t === "Pending" && (
                                    <Badge variant="outline" className="ml-2">
                                        {pending.length}
                                    </Badge>
                                )}
                            </Button>
                        ),
                    )}
                </div>
                <div className="hidden grid-cols-[2fr_1.2fr_1fr_1fr_24px] gap-4 border-b bg-muted/30 px-5 py-3 text-xs text-muted-foreground md:grid">
                    <span>Purpose / Custodian</span>
                    <span>Team / Subteam</span>
                    <span>Requested budget</span>
                    <span>Status</span>
                    <span />
                </div>
                {visible.map((r) => (
                    <button
                        key={r.id}
                        onClick={() => openDetail(r)}
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-4 border-b px-5 py-4 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring md:grid-cols-[2fr_1.2fr_1fr_1fr_24px]"
                    >
                        <span>
                            <span className="block text-sm font-medium">
                                {r.purpose}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                                {r.custodian}
                            </span>
                        </span>
                        <span className="hidden text-sm md:block">
                            {r.team}
                            <span className="mt-1 block text-xs text-muted-foreground">
                                {r.subteam}
                            </span>
                        </span>
                        <span className="text-right text-sm font-medium tabular-nums md:text-left">
                            {money(r.amount)}
                            <span className="mt-1 block text-xs font-normal text-muted-foreground">
                                {r.cadence === "Monthly"
                                    ? "per month"
                                    : "one-time"}
                            </span>
                        </span>
                        <span>
                            <Badge
                                variant="secondary"
                                className={statusStyle[r.status]}
                            >
                                {r.status}
                            </Badge>
                            <span className="ml-2 text-xs text-muted-foreground md:hidden">
                                {r.team} / {r.subteam}
                            </span>
                        </span>
                        <ChevronRight className="size-4 justify-self-end text-muted-foreground" />
                    </button>
                ))}
                {visible.length === 0 && (
                    <p className="p-10 text-center text-sm text-muted-foreground">
                        No requests match this view.
                    </p>
                )}
            </section>
            <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                Cards draw from the club’s shared Issuing balance. Allocations
                reserve budget for each team. Pending authorizations reduce what
                remains; spending limits can have timing exceptions. Monthly
                renewals would need funding checks before each period.
            </p>
            <Dialog open={creating} onOpenChange={setCreating}>
                <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Request a virtual card</DialogTitle>
                        <DialogDescription>
                            Tell finance what your subteam needs. Your request
                            reserves funds after approval.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={create} className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label htmlFor="card-team">Team</Label>
                                <select
                                    id="card-team"
                                    name="team"
                                    className={fieldClass}
                                    value={team}
                                    onChange={(e) => setTeam(e.target.value)}
                                >
                                    {Object.keys(teams).map((t) => (
                                        <option key={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="card-subteam">Subteam</Label>
                                <select
                                    key={team}
                                    id="card-subteam"
                                    name="subteam"
                                    className={fieldClass}
                                >
                                    {teams[team].map((t) => (
                                        <option key={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="card-purpose">
                                What is this for?
                            </Label>
                            <Textarea
                                required
                                maxLength={250}
                                id="card-purpose"
                                name="purpose"
                                placeholder="e.g. Credits to evaluate the team’s model"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="card-vendor">Vendor</Label>
                            <Input
                                required
                                maxLength={100}
                                id="card-vendor"
                                name="vendor"
                                placeholder="Where will you use the card?"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label htmlFor="card-amount">
                                    Requested amount (USD)
                                </Label>
                                <Input
                                    required
                                    id="card-amount"
                                    name="amount"
                                    type="number"
                                    inputMode="decimal"
                                    min="0.01"
                                    max="2000"
                                    step="0.01"
                                    placeholder="100.00"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="card-cadence">
                                    Budget type
                                </Label>
                                <select
                                    id="card-cadence"
                                    name="cadence"
                                    className={fieldClass}
                                >
                                    <option>One-time</option>
                                    <option>Monthly</option>
                                </select>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="card-until">Needed until</Label>
                            <Input
                                required
                                id="card-until"
                                name="until"
                                type="date"
                                min={new Date(
                                    Date.now() + 86400000,
                                ).toLocaleDateString("en-CA")}
                            />
                        </div>
                        <div className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                            You are the card custodian for this preview. Monthly
                            budgets need recurring approval; ending a card does
                            not cancel a vendor subscription.
                        </div>
                        {error && (
                            <p
                                role="alert"
                                className="text-sm text-destructive"
                            >
                                {error}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setCreating(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit">Add demo request</Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
            <Sheet
                open={!!detail}
                onOpenChange={(open) => {
                    if (!open) setSelected(null);
                }}
            >
                <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
                    {detail && (
                        <>
                            <SheetHeader>
                                <SheetTitle>{detail.purpose}</SheetTitle>
                                <SheetDescription>
                                    {detail.team} / {detail.subteam} ·{" "}
                                    {detail.custodian}
                                </SheetDescription>
                            </SheetHeader>
                            <div className="space-y-6 p-5 pt-0">
                                <Badge
                                    variant="secondary"
                                    className={statusStyle[detail.status]}
                                >
                                    {detail.status}
                                </Badge>
                                <dl className="grid grid-cols-2 gap-4 text-sm">
                                    {[
                                        [
                                            "Requested budget",
                                            `${money(detail.amount)}${detail.cadence === "Monthly" ? " / month" : " total"}`,
                                        ],
                                        ["Vendor", detail.vendor],
                                        ["Needed until", detail.until],
                                        ["Custodian", detail.custodian],
                                    ].map(([label, value]) => (
                                        <div key={label}>
                                            <dt className="text-xs text-muted-foreground">
                                                {label}
                                            </dt>
                                            <dd className="mt-1 font-medium">
                                                {value}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                                {(detail.status === "Active" ||
                                    detail.status === "Frozen") && (
                                    <div className="space-y-4 rounded-xl border p-4">
                                        <div className="flex items-center justify-between">
                                            <CreditCard className="size-5 text-violet-500" />
                                            <span className="text-xs text-muted-foreground">
                                                DEMO CARD
                                            </span>
                                        </div>
                                        <p className="font-mono text-lg">
                                            •••• •••• •••• {detail.last4}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Card details will appear securely
                                            here for the authorized custodian.
                                            This preview contains no card number
                                            or CVC.
                                        </p>
                                        <div className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
                                            <span>
                                                Settled
                                                <strong className="mt-1 block">
                                                    {money(detail.spent)}
                                                </strong>
                                            </span>
                                            <span>
                                                Pending
                                                <strong className="mt-1 block">
                                                    {money(detail.held)}
                                                </strong>
                                            </span>
                                            <span>
                                                Remaining
                                                <strong className="mt-1 block">
                                                    {money(
                                                        detail.amount -
                                                            detail.spent -
                                                            detail.held,
                                                    )}
                                                </strong>
                                            </span>
                                        </div>
                                        {persona === "finance" && (
                                            <Button
                                                variant="outline"
                                                className="w-full"
                                                onClick={() =>
                                                    update(
                                                        detail.id,
                                                        {
                                                            status:
                                                                detail.status ===
                                                                "Frozen"
                                                                    ? "Active"
                                                                    : "Frozen",
                                                        },
                                                        detail.status ===
                                                            "Frozen"
                                                            ? "Finance resumed the demo card"
                                                            : "Finance froze the demo card",
                                                    )
                                                }
                                            >
                                                <Snowflake className="mr-2 size-4" />
                                                {detail.status === "Frozen"
                                                    ? "Resume demo card"
                                                    : "Freeze demo card"}
                                            </Button>
                                        )}
                                    </div>
                                )}
                                {detail.status === "Pending" && (
                                    <section className="space-y-3 rounded-xl border p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-medium">
                                            <ShieldCheck className="size-4" />
                                            Finance review
                                        </h3>
                                        {canReview ? (
                                            <>
                                                <Label htmlFor="review-amount">
                                                    Approve amount (USD)
                                                </Label>
                                                <Input
                                                    id="review-amount"
                                                    type="number"
                                                    min="0.01"
                                                    step="0.01"
                                                    max={detail.amount / 100}
                                                    value={reviewAmount}
                                                    onChange={(e) =>
                                                        setReviewAmount(
                                                            e.target.value,
                                                        )
                                                    }
                                                />
                                                <Label htmlFor="review-note">
                                                    Decision note
                                                </Label>
                                                <Textarea
                                                    id="review-note"
                                                    placeholder="Reason or conditions for this decision"
                                                    value={reviewNote}
                                                    onChange={(e) =>
                                                        setReviewNote(
                                                            e.target.value,
                                                        )
                                                    }
                                                />
                                                {reviewError && (
                                                    <p
                                                        role="alert"
                                                        className="text-sm text-destructive"
                                                    >
                                                        {reviewError}
                                                    </p>
                                                )}
                                                <div className="flex gap-2">
                                                    <Button
                                                        className="flex-1"
                                                        onClick={approve}
                                                    >
                                                        <Check className="mr-2 size-4" />
                                                        Approve demo
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => {
                                                            if (
                                                                !reviewNote.trim()
                                                            ) {
                                                                setReviewError(
                                                                    "Add a reason before declining.",
                                                                );
                                                                return;
                                                            }
                                                            update(
                                                                detail.id,
                                                                {
                                                                    status: "Declined",
                                                                    note: reviewNote.trim(),
                                                                },
                                                                `Finance declined: ${reviewNote.trim()}`,
                                                            );
                                                        }}
                                                    >
                                                        Decline
                                                    </Button>
                                                </div>
                                                <p className="text-xs text-muted-foreground">
                                                    Available to approve:{" "}
                                                    {money(unallocated)}.
                                                    Approval reserves the
                                                    allocation.
                                                </p>
                                            </>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">
                                                {persona === "finance"
                                                    ? "Your own request needs a different finance reviewer."
                                                    : "Waiting for an independent finance reviewer. Switch the preview role to explore approvals."}
                                            </p>
                                        )}
                                    </section>
                                )}
                                {detail.note && (
                                    <div>
                                        <h3 className="text-sm font-medium">
                                            Decision note
                                        </h3>
                                        <p className="mt-2 text-sm text-muted-foreground">
                                            {detail.note}
                                        </p>
                                    </div>
                                )}
                                <section>
                                    <h3 className="mb-3 text-sm font-medium">
                                        Activity
                                    </h3>
                                    <ol className="space-y-3">
                                        {detail.history.map((event, i) => (
                                            <li
                                                key={i}
                                                className="flex gap-3 text-sm text-muted-foreground"
                                            >
                                                <ArrowDownLeft className="mt-0.5 size-4 shrink-0" />
                                                {event}
                                            </li>
                                        ))}
                                    </ol>
                                </section>
                                <section className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                                    Receipts and vendor transactions will be
                                    attached to this request after the Stripe
                                    integration is connected.
                                </section>
                            </div>
                        </>
                    )}
                </SheetContent>
            </Sheet>
        </div>
    );
}

export function VirtualCardsPreview() {
    return (
        <SidebarProvider>
            <AppSidebar
                userInfo={{
                    pk: 0,
                    name: "Demo member",
                    email: "preview@example.invalid",
                    avatar: "",
                    isExecutive: false,
                }}
            />
            <SidebarInset>
                <header className="flex h-16 items-center gap-3 px-6">
                    <SidebarTrigger />
                    <span className="text-sm text-muted-foreground">
                        Finance / Virtual cards
                    </span>
                </header>
                <main className="flex-1 overflow-y-auto px-4 pb-6 md:px-6">
                    <VirtualCardRequests />
                </main>
            </SidebarInset>
        </SidebarProvider>
    );
}
