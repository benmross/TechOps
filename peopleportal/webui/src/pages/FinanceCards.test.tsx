import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceCards } from "./FinanceCards";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/commons/finance-api", async (original) => ({
    ...(await original<typeof import("@/commons/finance-api")>()),
    financeApi: api,
}));
vi.mock("@/components/fabric/IssuingCardDetails", () => ({
    IssuingCardDetails: () => <div>Stripe-hosted card details</div>,
}));
let reviewer: boolean;
let userPk: number;
let request: Record<string, unknown>;
let failCreate: boolean;
let createBodies: Record<string, unknown>[];
const row = {
    id: "a".repeat(24),
    requesterPk: 101,
    rootTeamPk: "root",
    subteamPk: "sub",
    purpose: "Project hosting",
    vendor: "Hosting service",
    requestedCents: 10000,
    approvedCents: null,
    reservedCents: null,
    interval: "all_time",
    neededUntil: new Date(Date.now() + 86400000 * 10).toISOString(),
    status: "pending",
    reviewNote: null,
    last4: null,
    cardId: null,
    cardStatus: null,
    desiredCardStatus: "active",
    needsAttention: false,
};
beforeEach(() => {
    reviewer = false;
    userPk = 101;
    request = { ...row };
    failCreate = false;
    createBodies = [];
    api.mockReset();
    api.mockImplementation(
        async (
            path: string,
            method = "GET",
            body?: Record<string, unknown>,
        ) => {
            if (path === "context")
                return {
                    userPk,
                    reviewer,
                    publishableKey: "pk_test_fixture",
                    teams: [
                        {
                            rootTeamPk: "root",
                            subteamPk: "sub",
                            team: "Test team",
                            subteam: "Engineering",
                        },
                    ],
                };
            if (path === "budget")
                return { totalCents: 100000, reservedCents: 0 };
            if (path === "team-budgets")
                return [
                    {
                        rootTeamPk: "root",
                        name: "Test team",
                        totalCents: 50000,
                        reservedCents: 0,
                    },
                ];
            if (path === "requests" && method === "GET") return [request];
            if (path === "requests" && method === "POST") {
                createBodies.push(body!);
                if (failCreate) throw new Error("Network interrupted");
                return request;
            }
            if (path === `requests/${row.id}`)
                return {
                    request,
                    heldCents: 1200,
                    settledCents: 3400,
                    entries: [],
                    audit: [],
                };
            if (path.endsWith("/approve")) {
                request = {
                    ...request,
                    status: "approved",
                    approvedCents: body?.approvedCents,
                };
                return request;
            }
            if (path.endsWith("/decline")) return request;
            if (path.endsWith("/card-status")) {
                request = { ...request, desiredCardStatus: body?.status };
                return request;
            }
            throw new Error(`Unexpected API route: ${path}`);
        },
    );
});
afterEach(() => vi.restoreAllMocks());

describe("connected finance screen", () => {
    it("loads real records and fails closed when finance is unavailable", async () => {
        api.mockRejectedValue(new Error("Finance is disabled"));
        render(<FinanceCards />);
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Finance is disabled",
        );
        expect(
            screen.getByRole("button", { name: "Request a card" }),
        ).toBeDisabled();
        expect(
            screen.queryByText("Model evaluation credits"),
        ).not.toBeInTheDocument();
    });
    it("uses server role without a preview switch or member review controls", async () => {
        render(<FinanceCards />);
        await userEvent.click(
            await screen.findByRole("button", {
                name: /^View request: Project hosting/,
            }),
        );
        await screen.findByText("Settled spending");
        expect(
            screen.queryByRole("button", { name: /Approve and queue/ }),
        ).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Preview role")).not.toBeInTheDocument();
        expect(screen.getByText("$34.00")).toBeInTheDocument();
    });
    it("keeps a creation idempotency key after a failed request and sends directory team IDs", async () => {
        render(<FinanceCards />);
        await screen.findByRole("button", {
            name: /^View request: Project hosting/,
        });
        await userEvent.click(
            screen.getByRole("button", { name: "Request a card" }),
        );
        await userEvent.type(screen.getByLabelText("Purpose"), "New hosting");
        await userEvent.type(screen.getByLabelText("Vendor"), "Cloud service");
        await userEvent.type(
            screen.getByLabelText("Requested amount (USD)"),
            "50.25",
        );
        fireEvent.change(screen.getByLabelText("Needed through (UTC)"), {
            target: {
                value: new Date(Date.now() + 86400000 * 5)
                    .toISOString()
                    .slice(0, 10),
            },
        });
        failCreate = true;
        await userEvent.click(
            screen.getByRole("button", { name: "Send to finance" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Network interrupted",
        );
        failCreate = false;
        await userEvent.click(
            screen.getByRole("button", { name: "Send to finance" }),
        );
        await waitFor(() => expect(createBodies).toHaveLength(2));
        expect(createBodies[0]).toEqual(createBodies[1]);
        expect(createBodies[0]).toMatchObject({
            rootTeamPk: "root",
            subteamPk: "sub",
            requestedCents: 5025,
            interval: "all_time",
        });
        expect(createBodies[0].clientRequestId).toMatch(/^[a-f\d-]{36}$/);
    });
    it("queues partial approval without fabricating an active card", async () => {
        reviewer = true;
        userPk = 202;
        render(<FinanceCards />);
        await userEvent.click(
            await screen.findByRole("button", {
                name: /^View request: Project hosting/,
            }),
        );
        const amount = await screen.findByLabelText("Approve amount (USD)");
        await userEvent.clear(amount);
        await userEvent.type(amount, "60");
        await userEvent.type(
            screen.getByLabelText("Decision note"),
            "Approved partial budget",
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Approve and queue issuance" }),
        );
        await waitFor(() =>
            expect(api).toHaveBeenCalledWith(
                `requests/${row.id}/approve`,
                "POST",
                { approvedCents: 6000, note: "Approved partial budget" },
            ),
        );
        await waitFor(() =>
            expect(
                screen.getAllByText("Awaiting issuance").length,
            ).toBeGreaterThan(0),
        );
        expect(
            screen.queryByRole("button", { name: "Show card details" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/0000/)).not.toBeInTheDocument();
    });
    it("does not let a reviewer approve their own pending request", async () => {
        reviewer = true;
        render(<FinanceCards />);
        await userEvent.click(
            await screen.findByRole("button", {
                name: /^View request: Project hosting/,
            }),
        );
        await screen.findByText("Settled spending");
        expect(
            screen.queryByRole("button", { name: /Approve and queue/ }),
        ).not.toBeInTheDocument();
    });
    it("queues freeze on the API and keeps observed and desired status distinct", async () => {
        reviewer = true;
        userPk = 202;
        request = {
            ...row,
            status: "issued",
            cardId: "ic_fixture",
            cardStatus: "active",
            last4: "1234",
            approvedCents: 10000,
        };
        render(<FinanceCards />);
        await userEvent.click(
            await screen.findByRole("button", {
                name: /^View request: Project hosting/,
            }),
        );
        await userEvent.click(
            await screen.findByRole("button", { name: "Freeze card" }),
        );
        await waitFor(() =>
            expect(api).toHaveBeenCalledWith(
                `requests/${row.id}/card-status`,
                "PUT",
                { status: "inactive" },
            ),
        );
        await waitFor(() =>
            expect(
                screen.getAllByText("active → inactive (queued)").length,
            ).toBeGreaterThan(0),
        );
        expect(
            screen.queryByRole("button", { name: "Show card details" }),
        ).not.toBeInTheDocument();
    });
});
