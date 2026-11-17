import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FinanceCardTile } from "./FinanceCardTile";
import type { FinanceRequest } from "@/commons/finance-api";

const request: FinanceRequest = {
    id: "request",
    requesterPk: 101,
    rootTeamPk: "root",
    subteamPk: "sub",
    purpose: "Hosting",
    vendor: "Cloud",
    requestedCents: 20000,
    approvedCents: 20000,
    reservedCents: 20000,
    interval: "all_time",
    neededUntil: "2027-01-01T00:00:00Z",
    status: "issued",
    reviewNote: null,
    last4: "4242",
    cardId: "ic_fixture",
    cardStatus: "active",
    desiredCardStatus: "active",
    needsAttention: false,
    settledCents: 7600,
    heldCents: 1200,
};
describe("API card visualization", () => {
    it("shows reconciled totals and opens the same request details", async () => {
        const open = vi.fn();
        render(
            <FinanceCardTile
                request={request}
                team="Project / Engineering"
                own
                onOpen={open}
            />,
        );
        expect(screen.getByText("$112.00")).toBeInTheDocument();
        expect(screen.getByText("$76.00 settled")).toBeInTheDocument();
        expect(screen.getByText("$12.00 pending")).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: "View card: Hosting" }),
        );
        expect(open).toHaveBeenCalledOnce();
    });
    it("distinguishes lifetime reservations from a monthly spending limit", () => {
        render(
            <FinanceCardTile
                request={{
                    ...request,
                    interval: "monthly",
                    reservedCents: 60000,
                }}
                team="Team"
                own
                onOpen={() => {}}
            />,
        );
        expect(screen.getByText("$512.00")).toBeInTheDocument();
        expect(screen.getByText("$200.00 / month")).toBeInTheDocument();
        expect(
            screen.getByText(/\$600.00 reserved across all covered UTC months/),
        ).toBeInTheDocument();
    });
    it("does not fabricate zero spending when API totals are unavailable", () => {
        render(
            <FinanceCardTile
                request={{
                    ...request,
                    heldCents: undefined,
                    settledCents: undefined,
                }}
                team="Team"
                own
                onOpen={() => {}}
            />,
        );
        expect(screen.getByText("Unavailable")).toBeInTheDocument();
        expect(screen.queryByText("$0.00 settled")).not.toBeInTheDocument();
    });
    it("shows overspending rather than clamping it to an unused balance", () => {
        render(
            <FinanceCardTile
                request={{ ...request, settledCents: 25000, heldCents: 0 }}
                team="Team"
                own
                onOpen={() => {}}
            />,
        );
        expect(
            screen.getByText("Over allocated commitment"),
        ).toBeInTheDocument();
        expect(screen.getByText("$50.00")).toBeInTheDocument();
    });
});
