import mongoose, { ClientSession, Types } from "mongoose";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cents, fail, financeConfig } from "./config";
import { FinanceActor, requireReviewer, requireTeamMember } from "./access";
import {
    FinanceRequest,
    FinanceBudget,
    FinanceAudit,
    FinanceCardholder,
    FinanceEntry,
    FinanceWebhookEvent,
    RequestRecord,
} from "./models";
import {
    requireTestObject,
    requireUsableCardholder,
    stripeClient,
} from "./stripe";

export interface CreateFinanceRequest {
    rootTeamPk: string;
    subteamPk: string;
    purpose: string;
    vendor: string;
    requestedCents: number;
    interval: "all_time" | "monthly";
    /** ISO timestamp, inclusive monthly allocations use UTC calendar months. */
    neededUntil: string;
    /** UUID supplied by the client; retries must use the same payload. */
    clientRequestId: string;
}

export interface FinanceRequestView {
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
    reviewerPk: number | null;
    reviewNote: string | null;
    last4: string | null;
    cardId: string | null;
    cardStatus: string | null;
    desiredCardStatus: string;
    needsAttention: boolean;
    createdAt: string;
}

function view(
    request: RequestRecord & { _id: Types.ObjectId },
): FinanceRequestView {
    return {
        id: String(request._id),
        requesterPk: request.requesterPk,
        rootTeamPk: request.rootTeamPk,
        subteamPk: request.subteamPk,
        purpose: request.purpose,
        vendor: request.vendor,
        requestedCents: request.requestedCents,
        approvedCents: request.approvedCents ?? null,
        reservedCents: request.reservedCents ?? null,
        interval: request.interval,
        neededUntil: request.neededUntil.toISOString(),
        status: request.status,
        reviewerPk: request.reviewerPk ?? null,
        reviewNote: request.reviewNote ?? null,
        last4: request.last4 ?? null,
        cardStatus: request.cardStatus ?? null,
        cardId: request.stripeCardId ?? null,
        desiredCardStatus: request.desiredCardStatus,
        needsAttention: Boolean(request.lastError),
        createdAt: request.createdAt.toISOString(),
    };
}

export async function transaction<T>(
    work: (session: ClientSession) => Promise<T>,
): Promise<T> {
    const session = await mongoose.startSession();
    try {
        return (await session.withTransaction(() => work(session)))!;
    } finally {
        await session.endSession();
    }
}

export async function audit(
    action: string,
    requestId?: string,
    actorPk?: number,
    detail?: string,
    session?: ClientSession,
) {
    await FinanceAudit.create(
        [{ action, requestId, actorPk, detail }],
        session ? { session } : {},
    );
}

function objectId(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id)) fail(404, "Request not found");
    return new Types.ObjectId(id);
}

async function accessible(actor: FinanceActor, id: string) {
    const record = await FinanceRequest.findOne({
        _id: objectId(id),
        ...(actor.reviewer ? {} : { requesterPk: actor.pk }),
    });
    if (!record) fail(404, "Request not found");
    return record!;
}

function reviewNote(value: string) {
    const note = value.trim();
    if (!note || note.length > 1000)
        fail(422, "Provide a review note of 1 to 1000 characters");
    return note;
}

export function reservation(
    amount: number,
    interval: string,
    now: Date,
    end: Date,
) {
    cents(amount);
    if (
        !Number.isFinite(end.getTime()) ||
        end <= now ||
        end.getTime() - now.getTime() > 366 * 86400000
    )
        fail(422, "End date must be in the next 366 days");
    if (interval !== "all_time" && interval !== "monthly")
        fail(422, "Unsupported spending interval");
    const months =
        interval === "monthly"
            ? (end.getUTCFullYear() - now.getUTCFullYear()) * 12 +
              end.getUTCMonth() -
              now.getUTCMonth() +
              1
            : 1;
    return cents(amount * months);
}

export class FinanceService {
    async create(actor: FinanceActor, input: CreateFinanceRequest) {
        const purpose = input.purpose.trim(),
            vendor = input.vendor.trim();
        if (
            !purpose ||
            purpose.length > 1000 ||
            !vendor ||
            vendor.length > 200 ||
            !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
                input.clientRequestId,
            )
        )
            fail(422, "Provide a purpose, vendor and UUID client request ID");
        const end = new Date(input.neededUntil);
        reservation(input.requestedCents, input.interval, new Date(), end);
        await requireTeamMember(actor.pk, input.rootTeamPk, input.subteamPk);
        const payload = {
            requesterPk: actor.pk,
            rootTeamPk: input.rootTeamPk,
            subteamPk: input.subteamPk,
            purpose,
            vendor,
            requestedCents: input.requestedCents,
            interval: input.interval,
            neededUntil: end,
            clientRequestId: input.clientRequestId,
        };
        try {
            return await transaction(async (session) => {
                const [record] = await FinanceRequest.create([payload], {
                    session,
                });
                await audit(
                    "requested",
                    String(record!._id),
                    actor.pk,
                    undefined,
                    session,
                );
                return view(record!);
            });
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            const existing = await FinanceRequest.findOne({
                requesterPk: actor.pk,
                clientRequestId: input.clientRequestId,
            });
            if (
                !existing ||
                existing.rootTeamPk !== payload.rootTeamPk ||
                existing.subteamPk !== payload.subteamPk ||
                existing.purpose !== purpose ||
                existing.vendor !== vendor ||
                existing.interval !== input.interval ||
                existing.requestedCents !== input.requestedCents ||
                existing.neededUntil.getTime() !== end.getTime()
            )
                fail(
                    409,
                    "Client request ID already used for a different request",
                );
            return view(existing!);
        }
    }

    async list(
        actor: FinanceActor,
        before?: string,
    ): Promise<FinanceRequestView[]> {
        const records = await FinanceRequest.find({
            ...(actor.reviewer ? {} : { requesterPk: actor.pk }),
            ...(before ? { _id: { $lt: objectId(before) } } : {}),
        })
            .sort({ _id: -1 })
            .limit(50);
        return records.map(view);
    }

    async detail(actor: FinanceActor, id: string) {
        const record = await accessible(actor, id);
        const entries = record.stripeCardId
            ? await FinanceEntry.find({ cardId: record.stripeCardId })
                  .sort({ stripeCreated: -1 })
                  .limit(100)
                  .lean()
            : [];
        const totals = record.stripeCardId
            ? await FinanceEntry.aggregate([
                  { $match: { cardId: record.stripeCardId } },
                  { $group: { _id: "$kind", amount: { $sum: "$amount" } } },
              ])
            : [];
        const history = await FinanceAudit.find({ requestId: id })
            .sort({ _id: -1 })
            .limit(100)
            .lean();
        return {
            request: view(record),
            heldCents: Number(
                totals.find((r) => r._id === "authorization")?.amount ?? 0,
            ),
            settledCents: -Number(
                totals.find((r) => r._id === "transaction")?.amount ?? 0,
            ),
            entries: entries.map((entry) => ({
                id: entry.stripeId,
                kind: entry.kind,
                amount: entry.amount,
                currency: entry.currency,
                status: entry.status ?? "",
                merchant: entry.merchant ?? "",
            })),
            audit: history.map((entry) => ({
                action: entry.action,
                actorPk: entry.actorPk ?? null,
                detail: entry.detail ?? "",
                at: entry.createdAt.toISOString(),
            })),
        };
    }

    async setBudget(actor: FinanceActor, totalCents: number) {
        requireReviewer(actor);
        cents(totalCents);
        return transaction(async (session) => {
            const budget = await FinanceBudget.findOneAndUpdate(
                { _id: "usd-test", reservedCents: { $lte: totalCents } },
                { $set: { totalCents } },
                { new: true, session },
            );
            if (!budget)
                fail(
                    409,
                    "Budget cannot be smaller than committed allocations",
                );
            await audit(
                "budget_changed",
                undefined,
                actor.pk,
                String(totalCents),
                session,
            );
            return {
                totalCents: budget!.totalCents,
                reservedCents: budget!.reservedCents,
            };
        });
    }

    async budget(actor: FinanceActor) {
        requireReviewer(actor);
        const budget = await FinanceBudget.findById("usd-test");
        return {
            totalCents: budget?.totalCents ?? 0,
            reservedCents: budget?.reservedCents ?? 0,
        };
    }

    async assignCardholder(
        actor: FinanceActor,
        userPk: number,
        stripeCardholderId: string,
        stripe = stripeClient(),
    ) {
        requireReviewer(actor);
        if (
            !Number.isSafeInteger(userPk) ||
            userPk <= 0 ||
            !/^ich_[a-zA-Z0-9]+$/.test(stripeCardholderId)
        )
            fail(422, "Invalid user or Stripe cardholder ID");
        requireUsableCardholder(
            await stripe.issuing.cardholders.retrieve(stripeCardholderId),
        );
        // Immutable mapping: reassignment needs an explicit migration, so queued
        // approvals cannot silently issue to a different person after review.
        return transaction(async (session) => {
            const existing = await FinanceCardholder.findOne({
                userPk,
            }).session(session);
            if (existing && existing.stripeCardholderId !== stripeCardholderId)
                fail(409, "User already has a different cardholder mapping");
            await FinanceCardholder.updateOne(
                { userPk, stripeCardholderId },
                { $setOnInsert: { assignedBy: actor.pk } },
                { upsert: true, session },
            );
            await audit(
                "cardholder_assigned",
                undefined,
                actor.pk,
                String(userPk),
                session,
            );
            return { userPk, stripeCardholderId };
        });
    }

    async approve(
        actor: FinanceActor,
        id: string,
        amount: number,
        note: string,
        stripe = stripeClient(),
    ) {
        requireReviewer(actor);
        cents(amount);
        note = reviewNote(note);
        const initial = await accessible(actor, id);
        if (initial.requesterPk === actor.pk)
            fail(403, "You cannot approve your own request");
        if (initial.status !== "pending")
            fail(409, "Request is no longer pending");
        if (amount > initial.requestedCents)
            fail(422, "Approval cannot exceed requested amount");
        await requireTeamMember(
            initial.requesterPk,
            initial.rootTeamPk,
            initial.subteamPk,
        );
        const mapping = await FinanceCardholder.findOne({
            userPk: initial.requesterPk,
        });
        if (!mapping)
            fail(409, "Finance must map an onboarded Stripe cardholder first");
        requireUsableCardholder(
            await stripe.issuing.cardholders.retrieve(
                mapping!.stripeCardholderId,
            ),
        );
        return transaction(async (session) => {
            const now = new Date();
            const reservedCents = reservation(
                amount,
                initial.interval,
                now,
                initial.neededUntil,
            );
            const budget = await FinanceBudget.findOneAndUpdate(
                {
                    _id: "usd-test",
                    $expr: {
                        $lte: [
                            { $add: ["$reservedCents", reservedCents] },
                            "$totalCents",
                        ],
                    },
                },
                { $inc: { reservedCents } },
                { session },
            );
            if (!budget) fail(409, "Insufficient unallocated budget");
            const record = await FinanceRequest.findOneAndUpdate(
                { _id: initial._id, status: "pending" },
                {
                    $set: {
                        status: "approved",
                        approvedCents: amount,
                        reservedCents,
                        reviewerPk: actor.pk,
                        reviewNote: note,
                        approvedAt: now,
                        stripeCardholderId: mapping!.stripeCardholderId,
                        retryAfter: now,
                    },
                },
                { new: true, session },
            );
            if (!record) fail(409, "Request is no longer pending");
            await audit("approved", id, actor.pk, note, session);
            return view(record!);
        });
    }

    async decline(actor: FinanceActor, id: string, note: string) {
        requireReviewer(actor);
        note = reviewNote(note);
        return transaction(async (session) => {
            const record = await FinanceRequest.findOneAndUpdate(
                { _id: objectId(id), status: "pending" },
                {
                    $set: {
                        status: "declined",
                        reviewerPk: actor.pk,
                        reviewNote: note,
                    },
                },
                { new: true, session },
            );
            if (!record) fail(409, "Request is no longer pending");
            await audit("declined", id, actor.pk, note, session);
            return view(record!);
        });
    }

    async setCardStatus(
        actor: FinanceActor,
        id: string,
        status: "active" | "inactive" | "canceled",
    ) {
        requireReviewer(actor);
        if (!["active", "inactive", "canceled"].includes(status))
            fail(422, "Invalid card status");
        return transaction(async (session) => {
            const record = await FinanceRequest.findOneAndUpdate(
                {
                    _id: objectId(id),
                    status: "issued",
                    cardStatus: { $ne: "canceled" },
                    desiredCardStatus: { $ne: "canceled" },
                    neededUntil: { $gt: new Date() },
                    $or: [
                        { leaseUntil: { $exists: false } },
                        { leaseUntil: { $lte: new Date() } },
                    ],
                },
                { $set: { desiredCardStatus: status, retryAfter: new Date() } },
                { new: true, session },
            );
            if (!record)
                fail(
                    409,
                    "Card is expired, canceled, unavailable or being reconciled; retry shortly",
                );
            await audit("card_status_requested", id, actor.pk, status, session);
            return view(record!);
        });
    }

    async ephemeralKey(
        actor: FinanceActor,
        id: string,
        nonce: string,
        stripe = stripeClient(),
    ) {
        const record = await accessible(actor, id);
        // Reviewers can audit requests, but cannot reveal somebody else's PAN.
        if (record.requesterPk !== actor.pk)
            fail(403, "Only the card custodian may display card details");
        if (
            !record.stripeCardId ||
            record.status !== "issued" ||
            record.neededUntil <= new Date() ||
            record.cardStatus === "canceled" ||
            record.desiredCardStatus === "canceled"
        )
            fail(409, "Card details are unavailable");
        if (!/^[a-zA-Z0-9_]{10,512}$/.test(nonce))
            fail(422, "Invalid Stripe.js nonce");
        await requireTeamMember(actor.pk, record.rootTeamPk, record.subteamPk);
        const key = await stripe.ephemeralKeys.create(
            { issuing_card: record.stripeCardId, nonce },
            { apiVersion: "2026-10-28.endive" },
        );
        requireTestObject(key);
        await audit("card_details_accessed", id, actor.pk);
        return {
            cardId: record.stripeCardId,
            ephemeralKeySecret: key.secret!,
            expires: key.expires,
        };
    }
}

function stripeId(value: string | { id: string }): string {
    return typeof value === "string" ? value : value.id;
}

export async function syncAuthorization(
    object: Stripe.Issuing.Authorization,
    session?: ClientSession,
) {
    requireTestObject(object);
    // amount is the outstanding hold, not settled spend. Closed/reversed and
    // declined authorizations must stop reserving funds, including partial capture.
    await FinanceEntry.updateOne(
        { stripeId: object.id },
        {
            $set: {
                kind: "authorization",
                cardId: stripeId(object.card),
                amount:
                    object.approved && object.status === "pending"
                        ? object.amount
                        : 0,
                currency: object.currency,
                status: object.status,
                merchant: object.merchant_data.name,
                stripeCreated: object.created,
            },
        },
        { upsert: true, ...(session ? { session } : {}) },
    );
}

export async function syncTransaction(
    object: Stripe.Issuing.Transaction,
    session?: ClientSession,
) {
    requireTestObject(object);
    // Stripe's amounts are balance deltas: captures negative, refunds positive.
    await FinanceEntry.updateOne(
        { stripeId: object.id },
        {
            $set: {
                kind: "transaction",
                cardId: stripeId(object.card),
                amount: object.amount,
                currency: object.currency,
                status: object.type,
                merchant: object.merchant_data.name,
                stripeCreated: object.created,
            },
        },
        { upsert: true, ...(session ? { session } : {}) },
    );
}

export async function processFinanceWebhook(
    event: Stripe.Event,
    stripe = stripeClient(),
) {
    requireTestObject(event);
    if (await FinanceWebhookEvent.exists({ _id: event.id })) return;
    // Fetch current state instead of trusting delivery order. Periodic polling
    // also repairs any concurrent stale snapshot or a missed webhook.
    const object = event.data.object as { id: string };
    const auth = /^issuing_authorization\.(created|updated)$/.test(event.type)
        ? await stripe.issuing.authorizations.retrieve(object.id)
        : undefined;
    const tx = /^issuing_transaction\.(created|updated)$/.test(event.type)
        ? await stripe.issuing.transactions.retrieve(object.id)
        : undefined;
    const card = /^issuing_card\.(created|updated)$/.test(event.type)
        ? await stripe.issuing.cards.retrieve(object.id)
        : undefined;
    if (card) requireTestObject(card);
    const cardId = auth
        ? stripeId(auth.card)
        : tx
          ? stripeId(tx.card)
          : card?.id;
    try {
        await transaction(async (session) => {
            if (await FinanceWebhookEvent.findById(event.id).session(session))
                return;
            const request = cardId
                ? await FinanceRequest.findOne({
                      stripeCardId: cardId,
                  }).session(session)
                : null;
            if (request) {
                if (auth) await syncAuthorization(auth, session);
                if (tx) await syncTransaction(tx, session);
                // Update observed state only; out-of-order webhooks must never
                // alter the desired state or reactivate an expired card.
                if (card)
                    await FinanceRequest.updateOne(
                        { _id: request._id },
                        {
                            $set: {
                                cardStatus: card.status,
                                ...(card.status === "canceled"
                                    ? { desiredCardStatus: "canceled" }
                                    : {}),
                            },
                        },
                        { session },
                    );
                await audit(
                    "stripe_event",
                    String(request._id),
                    undefined,
                    event.type,
                    session,
                );
            }
            await FinanceWebhookEvent.create(
                [{ _id: event.id, type: event.type, processedAt: new Date() }],
                { session },
            );
        });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        if (!(await FinanceWebhookEvent.exists({ _id: event.id }))) throw error;
    }
}

// Externally visible operations run outside MongoDB transactions. A lease and a
// persisted issuance key survive crashes. Never reuse create keys after Stripe's
// 24-hour retention window without recovering the existing card first.
export async function reconcileFinanceRequest(
    id: string,
    stripe = stripeClient(),
    memberCheck = requireTeamMember,
) {
    financeConfig();
    const now = new Date(),
        leaseToken = randomUUID();
    const record = await FinanceRequest.findOneAndUpdate(
        {
            _id: objectId(id),
            $and: [
                {
                    $or: [
                        { status: { $in: ["approved", "issued"] } },
                        { status: "expired", stripeCardId: { $exists: true } },
                    ],
                },
            ],
            $or: [
                { leaseUntil: { $exists: false } },
                { leaseUntil: { $lte: now } },
            ],
        },
        { $set: { leaseUntil: new Date(now.getTime() + 300_000), leaseToken } },
        { new: true },
    );
    if (!record) return;
    const renewLease = async () => {
        const renewed = await FinanceRequest.updateOne(
            { _id: record._id, leaseToken, leaseUntil: { $gt: new Date() } },
            { $set: { leaseUntil: new Date(Date.now() + 300_000) } },
        );
        if (renewed.matchedCount !== 1)
            fail(409, "Finance worker lease expired");
    };
    try {
        let eligible = record.neededUntil > now;
        if (eligible) {
            try {
                await memberCheck(
                    record.requesterPk,
                    record.rootTeamPk,
                    record.subteamPk,
                );
            } catch (error) {
                // Directory outages must never be treated as proof of membership.
                // Freeze an existing card; don't issue a new one.
                if (
                    (error as { status?: number }).status !== 403 &&
                    !record.stripeCardId
                )
                    throw error;
                eligible = false;
            }
        }
        if (!record.stripeCardId && !eligible) {
            await FinanceRequest.updateOne(
                { _id: record._id, leaseToken },
                { $set: { status: "expired", desiredCardStatus: "canceled" } },
            );
            await audit("expired_before_issuance", id);
            return;
        }
        if (!record.stripeCardId) {
            requireUsableCardholder(
                await stripe.issuing.cardholders.retrieve(
                    record.stripeCardholderId!,
                ),
            );
            await renewLease();
            let card: Stripe.Issuing.Card | undefined;
            if (
                record.issuanceStartedAt &&
                now.getTime() - record.issuanceStartedAt.getTime() >
                    23 * 3600000
            ) {
                for await (const existing of stripe.issuing.cards.list({
                    cardholder: record.stripeCardholderId!,
                    limit: 100,
                })) {
                    if (existing.metadata.finance_request_id === id) {
                        card = existing;
                        break;
                    }
                }
                if (!card)
                    fail(
                        409,
                        "Issuance outcome uncertain; manual Stripe reconciliation required",
                    );
            } else {
                await FinanceRequest.updateOne(
                    { _id: record._id, leaseToken },
                    {
                        $set: {
                            issuanceStartedAt: record.issuanceStartedAt ?? now,
                        },
                    },
                );
                card = await stripe.issuing.cards.create(
                    {
                        cardholder: record.stripeCardholderId!,
                        currency: "usd",
                        type: "virtual",
                        status: "inactive",
                        spending_controls: {
                            spending_limits: [
                                {
                                    amount: record.approvedCents!,
                                    interval: record.interval,
                                },
                            ],
                        },
                        metadata: { finance_request_id: id },
                    },
                    { idempotencyKey: `finance-card-${id}` },
                );
            }
            if (!card) throw new Error("Unable to recover issuance result");
            requireTestObject(card);
            await renewLease();
            record.stripeCardId = card.id;
            await transaction(async (session) => {
                await FinanceRequest.updateOne(
                    { _id: record._id, leaseToken },
                    {
                        $set: {
                            stripeCardId: card!.id,
                            last4: card!.last4,
                            cardStatus: card!.status,
                            status: "issued",
                        },
                    },
                    { session },
                );
                await audit("card_issued", id, undefined, undefined, session);
            });
        }
        let desired = record.desiredCardStatus;
        if (record.neededUntil <= new Date()) desired = "canceled";
        else if (!eligible && desired !== "canceled") desired = "inactive";
        let card = await stripe.issuing.cards.retrieve(record.stripeCardId!);
        requireTestObject(card);
        if (card.status === "canceled") desired = "canceled";
        if (card.status !== desired) {
            await renewLease();
            card = await stripe.issuing.cards.update(card.id, {
                status: desired,
            });
            requireTestObject(card);
            await audit("card_status_synced", id, undefined, desired);
        }
        await FinanceRequest.updateOne(
            { _id: record._id, leaseToken },
            {
                $set: {
                    cardStatus: card.status,
                    desiredCardStatus: desired,
                    ...(record.neededUntil <= new Date()
                        ? { status: "expired" }
                        : {}),
                },
            },
        );
        // Full pagination, not only the newest page: a missed webhook may be old.
        // Polling retains reservations and never automatically releases refunds.
        for await (const auth of stripe.issuing.authorizations.list({
            card: card.id,
            limit: 100,
        }))
            await syncAuthorization(auth);
        for await (const tx of stripe.issuing.transactions.list({
            card: card.id,
            limit: 100,
        }))
            await syncTransaction(tx);
        await FinanceRequest.updateOne(
            { _id: record._id, leaseToken },
            { $unset: { lastError: 1 } },
        );
    } catch {
        // Do not put SDK errors in logs/responses: they can contain request bodies
        // and account details. An uncertain outcome always retains its allocation.
        await FinanceRequest.updateOne(
            { _id: record._id, leaseToken },
            {
                $set: {
                    lastError:
                        "Reconciliation failed; finance must inspect Stripe test mode",
                },
            },
        );
        await audit("reconciliation_failed", id);
    } finally {
        await FinanceRequest.updateOne(
            { _id: record._id, leaseToken },
            {
                $unset: { leaseUntil: 1, leaseToken: 1 },
                $set: { retryAfter: new Date(Date.now() + 300_000) },
            },
        );
    }
}

export async function runFinanceMaintenance() {
    if (process.env.PEOPLEPORTAL_FINANCE_ENABLED !== "true") return;
    financeConfig();
    const records = await FinanceRequest.find({
        $and: [
            {
                $or: [
                    { status: { $in: ["approved", "issued"] } },
                    { status: "expired", stripeCardId: { $exists: true } },
                ],
            },
        ],
        $or: [
            { retryAfter: { $exists: false } },
            { retryAfter: { $lte: new Date() } },
        ],
    })
        .sort({ retryAfter: 1 })
        .limit(50)
        .select("_id");
    for (const record of records)
        await reconcileFinanceRequest(String(record._id));
}
