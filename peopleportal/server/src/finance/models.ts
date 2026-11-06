import { Schema, model } from "mongoose";

export type FinanceStatus =
    "pending" | "approved" | "issued" | "declined" | "expired";
export interface RequestRecord {
    requesterPk: number;
    rootTeamPk: string;
    subteamPk: string;
    purpose: string;
    vendor: string;
    requestedCents: number;
    approvedCents?: number;
    interval: "all_time" | "monthly";
    neededUntil: Date;
    status: FinanceStatus;
    reviewerPk?: number;
    reviewNote?: string;
    reservedCents?: number;
    approvedAt?: Date;
    stripeCardholderId?: string;
    stripeCardId?: string;
    last4?: string;
    cardStatus?: "active" | "inactive" | "canceled";
    desiredCardStatus: "active" | "inactive" | "canceled";
    leaseUntil?: Date;
    leaseToken?: string;
    issuanceStartedAt?: Date;
    retryAfter?: Date;
    lastError?: string;
    clientRequestId: string;
    createdAt: Date;
    updatedAt: Date;
}

const requestSchema = new Schema<RequestRecord>(
    {
        requesterPk: { type: Number, required: true, index: true },
        rootTeamPk: { type: String, required: true },
        subteamPk: { type: String, required: true },
        purpose: { type: String, required: true, maxlength: 1000 },
        vendor: { type: String, required: true, maxlength: 200 },
        requestedCents: { type: Number, required: true },
        approvedCents: Number,
        interval: {
            type: String,
            enum: ["all_time", "monthly"],
            required: true,
        },
        neededUntil: { type: Date, required: true },
        status: {
            type: String,
            enum: ["pending", "approved", "issued", "declined", "expired"],
            default: "pending",
            index: true,
        },
        reviewerPk: Number,
        reviewNote: String,
        reservedCents: Number,
        approvedAt: Date,
        stripeCardholderId: String,
        stripeCardId: { type: String },
        last4: String,
        cardStatus: { type: String, enum: ["active", "inactive", "canceled"] },
        desiredCardStatus: {
            type: String,
            enum: ["active", "inactive", "canceled"],
            default: "active",
        },
        leaseUntil: Date,
        leaseToken: String,
        issuanceStartedAt: Date,
        retryAfter: Date,
        lastError: String,
        clientRequestId: { type: String, required: true },
    },
    { timestamps: true },
);
requestSchema.index({ requesterPk: 1, clientRequestId: 1 }, { unique: true });
requestSchema.index({ stripeCardId: 1 }, { unique: true, sparse: true });
export const FinanceRequest = model<RequestRecord>(
    "FinanceRequest",
    requestSchema,
);

// This is a conservative allocation ceiling, not Stripe's cash balance.
// Allocations remain committed after expiry/cancellation to allow late captures.
export const FinanceBudget = model(
    "FinanceBudget",
    new Schema(
        {
            _id: { type: String, default: "usd-test" },
            totalCents: { type: Number, required: true, default: 0 },
            reservedCents: { type: Number, required: true, default: 0 },
        },
        { timestamps: true },
    ),
);

export const FinanceCardholder = model(
    "FinanceCardholder",
    new Schema(
        {
            userPk: { type: Number, required: true, unique: true },
            stripeCardholderId: { type: String, required: true, unique: true },
            assignedBy: { type: Number, required: true },
        },
        { timestamps: true },
    ),
);

export const FinanceAudit = model(
    "FinanceAudit",
    new Schema(
        {
            requestId: { type: String, index: true },
            actorPk: Number,
            action: { type: String, required: true },
            detail: String,
        },
        { timestamps: true },
    ),
);

// Store only normalized ledger fields, never whole Stripe payloads, PAN or CVC.
export const FinanceEntry = model(
    "FinanceEntry",
    new Schema(
        {
            stripeId: { type: String, required: true, unique: true },
            kind: {
                type: String,
                required: true,
                enum: ["authorization", "transaction"],
            },
            cardId: { type: String, required: true, index: true },
            amount: { type: Number, required: true },
            currency: { type: String, required: true },
            status: String,
            merchant: String,
            stripeCreated: Number,
        },
        { timestamps: true },
    ),
);

export const FinanceWebhookEvent = model(
    "FinanceWebhookEvent",
    new Schema({
        _id: { type: String, required: true },
        type: { type: String, required: true },
        processedAt: { type: Date, required: true },
    }),
);

export async function initializeFinanceModels() {
    await Promise.all([
        FinanceRequest.init(),
        FinanceBudget.init(),
        FinanceCardholder.init(),
        FinanceAudit.init(),
        FinanceEntry.init(),
        FinanceWebhookEvent.init(),
    ]);
    await FinanceBudget.updateOne(
        { _id: "usd-test" },
        { $setOnInsert: { totalCents: 0, reservedCents: 0 } },
        { upsert: true },
    );
}
