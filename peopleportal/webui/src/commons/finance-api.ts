import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";

export interface FinanceRequest {
    id: string;
    requesterPk: number;
    rootTeamPk: string;
    subteamPk: string;
    purpose: string;
    vendor: string;
    requestedCents: number;
    approvedCents: number | null;
    reservedCents: number | null;
    interval: "all_time" | "monthly";
    neededUntil: string;
    status: string;
    reviewNote: string | null;
    last4: string | null;
    cardId: string | null;
    cardStatus: string | null;
    desiredCardStatus: string;
    needsAttention: boolean;
}
export interface FinanceContext {
    userPk: number;
    reviewer: boolean;
    publishableKey: string | null;
    teams: {
        rootTeamPk: string;
        subteamPk: string;
        team: string;
        subteam: string;
    }[];
}
export interface FinanceDetail {
    request: FinanceRequest;
    heldCents: number;
    settledCents: number;
    entries: {
        id: string;
        kind: string;
        amount: number;
        currency: string;
        status: string;
        merchant: string;
    }[];
    audit: {
        action: string;
        actorPk: number | null;
        detail: string;
        at: string;
    }[];
}
export interface FinanceBudget {
    totalCents: number;
    reservedCents: number;
}

export async function financeApi<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(
        `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/finance/${path}`,
        {
            method,
            credentials: "include",
            cache: "no-store",
            signal,
            ...(body === undefined
                ? {}
                : {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                  }),
        },
    );
    if (!response.ok) {
        let message = `Finance request failed (${response.status})`;
        try {
            message = (await response.json()).message || message;
        } catch {
            /* The proxy may return HTML. */
        }
        if (response.status === 401) message = "Sign in to use virtual cards.";
        if (response.status === 503)
            message =
                "Finance is not configured. Ask a finance administrator to enable the Stripe sandbox.";
        throw new Error(message);
    }
    return response.json();
}

export function cardStatus(request: FinanceRequest) {
    if (request.status === "approved") return "Awaiting issuance";
    if (request.status !== "issued") return request.status;
    if (request.cardStatus !== request.desiredCardStatus)
        return `${request.cardStatus || "unknown"} → ${request.desiredCardStatus} (queued)`;
    return request.cardStatus === "inactive"
        ? "Frozen"
        : request.cardStatus || "unknown";
}

export function parseCents(value: string): number {
    if (!/^\d+(\.\d{1,2})?$/.test(value))
        throw new Error(
            "Enter a dollar amount with at most two decimal places.",
        );
    const cents = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0)
        throw new Error("Enter an amount greater than $0.");
    return cents;
}

export interface FinanceTeamBudget {
    rootTeamPk: string;
    name: string;
    totalCents: number;
    reservedCents: number;
}
