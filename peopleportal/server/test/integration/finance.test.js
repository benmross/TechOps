const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const express = require("express");
const request = require("supertest");
const Stripe = require("stripe");
const { ValidateError } = require("tsoa");
const models = require("../../dist/finance/models");
const access = require("../../dist/finance/access");
const stripeModule = require("../../dist/finance/stripe");
const directoryModule = require("../../dist/clients/AuthentikClient");
const { OpenIdClient } = require("../../dist/clients/OpenIdClient");
const {
    FinanceService,
    reservation,
    reconcileFinanceRequest,
    processFinanceWebhook,
} = require("../../dist/finance/service");
const { financeConfig } = require("../../dist/finance/config");
const { financeWebhook } = require("../../dist/finance/webhook");
const { RegisterRoutes } = require("../../dist/routes");
const { ResourceAccessError } = require("../../dist/utils/errors");

const {
    FinanceRequest,
    FinanceBudget,
    FinanceTeamBudget,
    FinanceCardholder,
    FinanceEntry,
    FinanceAudit,
    FinanceWebhookEvent,
} = models;
const owner = { pk: 101, reviewer: false },
    reviewer = { pk: 202, reviewer: true };
const service = new FinanceService();
const realStripe = new Stripe("sk_test_local_fixture");
let mongo, stripe, app, membershipAllowed, createCalls, activeUsers;
const iterable = (items) => ({
    async *[Symbol.asyncIterator]() {
        yield* items;
    },
});

function fakeStripe() {
    const cards = new Map();
    return {
        cards,
        authorizations: new Map(),
        transactions: new Map(),
        webhooks: realStripe.webhooks,
        ephemeralKeys: {
            create: async () => ({
                secret: "ek_test_fixture",
                livemode: false,
                expires: 9999999999,
            }),
        },
        issuing: {
            cardholders: {
                retrieve: async (id) => ({
                    id,
                    livemode: false,
                    status: "active",
                    requirements: { past_due: [] },
                }),
            },
            cards: {
                create: async (params, options) => {
                    createCalls++;
                    const id = `ic_${options.idempotencyKey.replaceAll("-", "")}`;
                    if (!cards.has(id))
                        cards.set(id, {
                            id,
                            status: params.status,
                            last4: "4242",
                            livemode: false,
                            metadata: params.metadata,
                            currency: params.currency,
                            cardholder: params.cardholder,
                            spending_controls: params.spending_controls,
                        });
                    return cards.get(id);
                },
                retrieve: async (id) => {
                    if (!cards.has(id)) throw new Error("Unknown card");
                    return { ...cards.get(id) };
                },
                update: async (id, params) => {
                    const card = { ...cards.get(id), ...params };
                    cards.set(id, card);
                    return card;
                },
                list: () => iterable([...cards.values()]),
            },
            authorizations: {
                retrieve: async (id) => stripe.authorizations.get(id),
                list: () => iterable([...stripe.authorizations.values()]),
            },
            transactions: {
                retrieve: async (id) => stripe.transactions.get(id),
                list: () => iterable([...stripe.transactions.values()]),
            },
        },
    };
}

const input = (changes = {}) => ({
    rootTeamPk: "root",
    subteamPk: "sub",
    purpose: "Server hosting",
    vendor: "Example Cloud",
    requestedCents: 10000,
    interval: "all_time",
    neededUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
    clientRequestId: randomUUID(),
    ...changes,
});

test.before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri("finance-test"));
    await models.initializeFinanceModels();
    // Replace directory transport, not finance authorization logic.
    directoryModule.AuthentikClient = class {
        async getUserInfo(pk) {
            return {
                pk,
                username: `user${pk}`,
                active: activeUsers.has(pk),
                attributes: {},
                groups: [],
            };
        }
        async getTeamMembershipsForUsername() {
            return {
                memberships: [
                    {
                        pk: "sub",
                        parent: "root",
                        name: "Engineering",
                        parentFriendlyName: "Test team",
                    },
                ],
            };
        }
        async getGroupInfo(pk) {
            return {
                pk,
                parentPk: pk === "sub" ? "root" : null,
                attributes: {},
                users: membershipAllowed
                    ? [{ pk: owner.pk }, { pk: reviewer.pk }]
                    : [],
            };
        }
    };
    OpenIdClient.verifyAccessToken = async (token) => ({
        pk: Number(token),
        username: `user${token}`,
        groups: [],
    });
    stripeModule.stripeClient = () => stripe;
    app = express();
    app.use(financeWebhook);
    app.use(express.json());
    app.use((req, res, next) => {
        const pk = Number(req.get("x-test-user"));
        req.session = pk
            ? { accessToken: String(pk), authorizedUser: { pk, groups: [] } }
            : {};
        next();
    });
    RegisterRoutes(app);
    app.use((error, req, res, next) =>
        res
            .status(
                error instanceof ValidateError ? 422 : (error.status ?? 500),
            )
            .json({ message: error.message }),
    );
});
test.after(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});
test.beforeEach(async () => {
    process.env.PEOPLEPORTAL_FINANCE_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_local_fixture";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_fixture";
    process.env.PEOPLEPORTAL_FINANCE_REVIEWER_PKS = String(reviewer.pk);
    process.env.PEOPLEPORTAL_FINANCE_ORIGIN = "https://portal.example.invalid";
    membershipAllowed = true;
    createCalls = 0;
    activeUsers = new Set([owner.pk, reviewer.pk]);
    stripe = fakeStripe();
    for (const model of [
        FinanceRequest,
        FinanceTeamBudget,
        FinanceCardholder,
        FinanceEntry,
        FinanceAudit,
        FinanceWebhookEvent,
    ])
        await model.deleteMany({});
    await FinanceBudget.updateOne(
        { _id: "usd-test" },
        {
            $set: {
                totalCents: 100000,
                reservedCents: 0,
                teamAllocatedCents: 100000,
                envelopeVersion: 1,
            },
        },
    );
    await FinanceTeamBudget.create({
        _id: "root",
        name: "Test team",
        totalCents: 100000,
        reservedCents: 0,
    });
    await FinanceCardholder.create({
        userPk: owner.pk,
        stripeCardholderId: "ich_fixture",
        assignedBy: reviewer.pk,
    });
});

async function approved(amount = 10000) {
    const row = await service.create(owner, input({ requestedCents: amount }));
    await service.approve(
        reviewer,
        row.id,
        amount,
        "Approved for hosting",
        stripe,
    );
    return row.id;
}
async function issued() {
    const id = await approved();
    await reconcileFinanceRequest(id, stripe);
    return await FinanceRequest.findById(id);
}
function event(type, id, eventId = `evt_${randomUUID()}`) {
    return {
        id: eventId,
        object: "event",
        type,
        livemode: false,
        data: { object: { id } },
    };
}

test("disabled finance and live credentials are rejected", () => {
    process.env.PEOPLEPORTAL_FINANCE_ENABLED = "false";
    assert.throws(financeConfig, /disabled/);
    process.env.PEOPLEPORTAL_FINANCE_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_live_fixture";
    assert.throws(financeConfig, /test key/);
});

test("requests persist, idempotent retries match exactly, and audit is retained", async () => {
    const payload = input();
    const first = await service.create(owner, payload);
    assert.equal((await service.create(owner, payload)).id, first.id);
    await assert.rejects(
        service.create(owner, { ...payload, requestedCents: 9000 }),
        { status: 409 },
    );
    assert.equal(await FinanceRequest.countDocuments(), 1);
    assert.equal(await FinanceAudit.countDocuments({ action: "requested" }), 1);
});

test("requests reject fractional amounts, past dates and unrelated subteams", async () => {
    await assert.rejects(
        service.create(owner, input({ requestedCents: 1.5 })),
        { status: 422 },
    );
    await assert.rejects(
        service.create(owner, input({ neededUntil: "2020-01-01" })),
        { status: 422 },
    );
    await assert.rejects(service.create(owner, input({ subteamPk: "other" })), {
        status: 403,
    });
    membershipAllowed = false;
    await assert.rejects(service.create(owner, input()), { status: 403 });
});

test("monthly requests reserve every UTC calendar month through the end date", () => {
    assert.equal(
        reservation(
            10000,
            "monthly",
            new Date("2026-11-30T23:00:00Z"),
            new Date("2027-01-01T01:00:00Z"),
        ),
        30000,
    );
    assert.equal(
        reservation(
            10000,
            "all_time",
            new Date("2026-11-30T23:00:00Z"),
            new Date("2027-01-01T01:00:00Z"),
        ),
        10000,
    );
});

test("finance permissions do not follow team membership and self-approval is blocked", async () => {
    const row = await service.create(owner, input());
    await assert.rejects(
        service.approve(owner, row.id, 10000, "okay", stripe),
        { status: 403 },
    );
    await assert.rejects(
        service.approve(
            { ...owner, reviewer: true },
            row.id,
            10000,
            "okay",
            stripe,
        ),
        { status: 403 },
    );
    await assert.rejects(service.setBudget(owner, 1000), { status: 403 });
});

test("concurrent approvals cannot overcommit a shared budget", async () => {
    await FinanceBudget.updateOne(
        { _id: "usd-test" },
        { $set: { totalCents: 15000 } },
    );
    const a = await service.create(owner, input()),
        b = await service.create(owner, input());
    const results = await Promise.allSettled([
        service.approve(reviewer, a.id, 10000, "a", stripe),
        service.approve(reviewer, b.id, 10000, "b", stripe),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
    assert.equal(await FinanceAudit.countDocuments({ action: "approved" }), 1);
});

test("concurrent approval of one request reserves exactly once", async () => {
    const row = await service.create(owner, input());
    const results = await Promise.allSettled([
        service.approve(reviewer, row.id, 10000, "a", stripe),
        service.approve(reviewer, row.id, 10000, "b", stripe),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
});

test("partial approval preserves the original request; decline and smaller budget are controlled", async () => {
    const row = await service.create(owner, input());
    const result = await service.approve(
        reviewer,
        row.id,
        8000,
        "Smaller allocation",
        stripe,
    );
    assert.equal(result.requestedCents, 10000);
    assert.equal(result.approvedCents, 8000);
    await assert.rejects(service.setBudget(reviewer, 7999), { status: 409 });
    await assert.rejects(service.decline(reviewer, row.id, "Late decline"), {
        status: 409,
    });
    const pending = await service.create(owner, input());
    await service.decline(reviewer, pending.id, "Not needed");
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        8000,
    );
});

test("membership and cardholder requirements are checked again before approval", async () => {
    const row = await service.create(owner, input());
    membershipAllowed = false;
    await assert.rejects(
        service.approve(reviewer, row.id, 10000, "a", stripe),
        { status: 403 },
    );
    membershipAllowed = true;
    stripe.issuing.cardholders.retrieve = async () => ({
        livemode: false,
        status: "inactive",
        requirements: { past_due: ["name"] },
    });
    await assert.rejects(
        service.approve(reviewer, row.id, 10000, "a", stripe),
        { status: 409 },
    );
    assert.equal((await FinanceBudget.findById("usd-test")).reservedCents, 0);
});

test("issuance creates an inactive limited card before activating it and never duplicates it", async () => {
    const id = await approved();
    await Promise.all([
        reconcileFinanceRequest(id, stripe),
        reconcileFinanceRequest(id, stripe),
    ]);
    await reconcileFinanceRequest(id, stripe);
    const record = await FinanceRequest.findById(id);
    assert.equal(record.status, "issued");
    assert.equal(record.cardStatus, "active");
    assert.equal(createCalls, 1);
    assert.deepEqual(stripe.cards.get(record.stripeCardId).spending_controls, {
        spending_limits: [{ amount: 10000, interval: "all_time" }],
    });
    assert.equal(
        (await FinanceAudit.find({ action: "card_issued" })).length,
        1,
    );
});

test("a lost create response retries with the same idempotency key", async () => {
    const id = await approved();
    const create = stripe.issuing.cards.create;
    let lost = false;
    stripe.issuing.cards.create = async (...args) => {
        const result = await create(...args);
        if (!lost) {
            lost = true;
            throw new Error("connection dropped after creation");
        }
        return result;
    };
    await reconcileFinanceRequest(id, stripe);
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
    await reconcileFinanceRequest(id, stripe);
    assert.equal(stripe.cards.size, 1);
    assert.equal((await FinanceRequest.findById(id)).status, "issued");
});

test("uncertain issuance older than 23 hours never blindly creates another card", async () => {
    const id = await approved();
    await FinanceRequest.updateOne(
        { _id: id },
        { issuanceStartedAt: new Date(Date.now() - 25 * 3600000) },
    );
    await reconcileFinanceRequest(id, stripe);
    assert.equal(createCalls, 0);
    assert.ok((await FinanceRequest.findById(id)).lastError);
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
});

test("old uncertain issuance recovers an existing card by metadata", async () => {
    const id = await approved();
    await FinanceRequest.updateOne(
        { _id: id },
        { issuanceStartedAt: new Date(Date.now() - 25 * 3600000) },
    );
    stripe.cards.set("ic_recovered", {
        id: "ic_recovered",
        last4: "1234",
        livemode: false,
        status: "inactive",
        metadata: { finance_request_id: id },
    });
    await reconcileFinanceRequest(id, stripe);
    assert.equal(createCalls, 0);
    assert.equal(
        (await FinanceRequest.findById(id)).stripeCardId,
        "ic_recovered",
    );
});

test("a worker that loses its lease cannot activate a card", async () => {
    const id = await approved();
    const retrieve = stripe.issuing.cardholders.retrieve;
    stripe.issuing.cardholders.retrieve = async (...args) => {
        const holder = await retrieve(...args);
        await FinanceRequest.updateOne(
            { _id: id },
            { leaseToken: "another-worker" },
        );
        return holder;
    };
    await reconcileFinanceRequest(id, stripe);
    assert.equal(createCalls, 0);
    assert.equal(
        (await FinanceRequest.findById(id)).leaseToken,
        "another-worker",
    );
});

test("freeze, resume and expiry retain allocation and permanently cancel expired cards", async () => {
    const record = await issued();
    const id = String(record._id);
    await service.setCardStatus(reviewer, id, "inactive");
    await reconcileFinanceRequest(id, stripe);
    assert.equal((await FinanceRequest.findById(id)).cardStatus, "inactive");
    await service.setCardStatus(reviewer, id, "active");
    await reconcileFinanceRequest(id, stripe);
    assert.equal((await FinanceRequest.findById(id)).cardStatus, "active");
    await FinanceRequest.updateOne(
        { _id: id },
        { neededUntil: new Date(Date.now() - 1000) },
    );
    await reconcileFinanceRequest(id, stripe);
    assert.equal((await FinanceRequest.findById(id)).cardStatus, "canceled");
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
    await assert.rejects(service.setCardStatus(reviewer, id, "active"), {
        status: 409,
    });
});

test("removed members cannot receive cards and existing cards are frozen", async () => {
    const id = await approved();
    membershipAllowed = false;
    await reconcileFinanceRequest(id, stripe);
    assert.equal(createCalls, 0);
    assert.equal((await FinanceRequest.findById(id)).status, "expired");
    membershipAllowed = true;
    await reconcileFinanceRequest(id, stripe);
    assert.equal(
        createCalls,
        0,
        "expired requests without cards must not be resurrected",
    );
    const record = await issued();
    membershipAllowed = false;
    await reconcileFinanceRequest(String(record._id), stripe);
    assert.equal(
        (await FinanceRequest.findById(record._id)).cardStatus,
        "inactive",
    );
});

test("webhooks deduplicate events and reconcile current state rather than old delivery snapshots", async () => {
    const record = await issued();
    const auth = {
        id: "iauth_fixture",
        card: { id: record.stripeCardId },
        livemode: false,
        approved: true,
        status: "pending",
        amount: 3000,
        currency: "usd",
        merchant_data: { name: "Example" },
        created: 1,
    };
    stripe.authorizations.set(auth.id, auth);
    const e = event("issuing_authorization.created", auth.id);
    await Promise.all([
        processFinanceWebhook(e, stripe),
        processFinanceWebhook(e, stripe),
    ]);
    assert.equal(await FinanceWebhookEvent.countDocuments({ _id: e.id }), 1);
    assert.equal(
        (await FinanceEntry.findOne({ stripeId: auth.id })).amount,
        3000,
    );
    auth.status = "closed";
    await processFinanceWebhook(
        event("issuing_authorization.created", auth.id),
        stripe,
    );
    assert.equal((await FinanceEntry.findOne({ stripeId: auth.id })).amount, 0);
});

test("captures, refunds and pending holds are counted separately", async () => {
    const record = await issued();
    for (const [id, amount, type] of [
        ["ipi_capture", -4000, "capture"],
        ["ipi_refund", 1000, "refund"],
    ]) {
        stripe.transactions.set(id, {
            id,
            amount,
            type,
            card: record.stripeCardId,
            currency: "usd",
            livemode: false,
            created: 1,
            merchant_data: { name: "Example" },
        });
        await processFinanceWebhook(
            event("issuing_transaction.created", id),
            stripe,
        );
    }
    const detail = await service.detail(owner, String(record._id));
    assert.equal(detail.settledCents, 3000);
    assert.equal(detail.heldCents, 0);
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
});

test("card details belong only to the custodian and require fresh membership", async () => {
    const record = await issued();
    const id = String(record._id);
    await assert.rejects(service.detail({ pk: 999, reviewer: false }, id), {
        status: 404,
    });
    await assert.rejects(
        service.ephemeralKey(reviewer, id, "ekn_test_nonce", stripe),
        { status: 403 },
    );
    assert.equal(
        (await service.ephemeralKey(owner, id, "ekn_test_nonce", stripe))
            .ephemeralKeySecret,
        "ek_test_fixture",
    );
    membershipAllowed = false;
    await assert.rejects(
        service.ephemeralKey(owner, id, "ekn_test_nonce", stripe),
        { status: 403 },
    );
});

test("HTTP routes enforce sign-in, reviewer allowlist, CSRF origin and extra-property rejection", async () => {
    await request(app).get("/api/finance/requests").expect(401);
    await request(app)
        .get("/api/finance/budget")
        .set("x-test-user", String(owner.pk))
        .expect(403);
    await request(app)
        .post("/api/finance/requests")
        .set("x-test-user", String(owner.pk))
        .send(input())
        .expect(403);
    await request(app)
        .post("/api/finance/requests")
        .set("x-test-user", String(owner.pk))
        .set("Origin", "https://evil.invalid")
        .send(input())
        .expect(403);
    await request(app)
        .post("/api/finance/requests")
        .set("x-test-user", String(owner.pk))
        .set("Origin", process.env.PEOPLEPORTAL_FINANCE_ORIGIN)
        .send({ ...input(), requesterPk: reviewer.pk })
        .expect(422);
    const response = await request(app)
        .post("/api/finance/requests")
        .set("x-test-user", String(owner.pk))
        .set("Origin", process.env.PEOPLEPORTAL_FINANCE_ORIGIN)
        .send(input())
        .expect(200);
    assert.equal(response.body.requesterPk, owner.pk);
    activeUsers.delete(owner.pk);
    await request(app)
        .get("/api/finance/requests")
        .set("x-test-user", String(owner.pk))
        .expect(403);
});

test("webhook HTTP endpoint verifies the original signed bytes and rejects tampering/live events", async () => {
    const payload = JSON.stringify(event("unhandled.event", "fixture"));
    const signature = realStripe.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    await request(app)
        .post("/api/finance/webhook")
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", signature)
        .send(payload)
        .expect(200);
    await request(app)
        .post("/api/finance/webhook")
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", signature)
        .send(`${payload} `)
        .expect(400);
    await request(app).post("/api/finance/webhook").send({}).expect(400);
    const live = JSON.stringify({
        ...event("unhandled.event", "fixture"),
        livemode: true,
    });
    const liveSignature = realStripe.webhooks.generateTestHeaderString({
        payload: live,
        secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    await request(app)
        .post("/api/finance/webhook")
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", liveSignature)
        .send(live)
        .expect(400);
});

test("context exposes server role and verified memberships without secrets", async () => {
    const response = await request(app)
        .get("/api/finance/context")
        .set("x-test-user", String(owner.pk))
        .expect(200);
    assert.equal(response.body.userPk, owner.pk);
    assert.equal(response.body.reviewer, false);
    assert.equal(response.body.teams[0].subteamPk, "sub");
    assert.equal(response.body.publishableKey, null);
    membershipAllowed = false;
    const revoked = await request(app)
        .get("/api/finance/context")
        .set("x-test-user", String(owner.pk))
        .expect(200);
    assert.deepEqual(revoked.body.teams, []);
});

test("team ceiling bounds concurrent approvals and rolls back failed reservations", async () => {
    await service.setTeamBudget(reviewer, "root", 15000);
    const a = await service.create(owner, input());
    const b = await service.create(owner, input());
    const outcomes = await Promise.allSettled(
        [a, b].map((row) =>
            service.approve(reviewer, row.id, 10000, "Project costs", stripe),
        ),
    );
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
        (await FinanceTeamBudget.findById("root")).reservedCents,
        10000,
    );
    assert.equal(
        (await FinanceBudget.findById("usd-test")).reservedCents,
        10000,
    );
    await assert.rejects(
        service.setTeamBudget(reviewer, "root", 5000),
        /committed/,
    );
});

test("team ceilings cannot overpromise club funds or bypass reviewer access", async () => {
    await assert.rejects(
        service.setTeamBudget(owner, "root", 50000),
        /reviewer/,
    );
    await assert.rejects(
        service.setTeamBudget(reviewer, "root", 100001),
        /club/,
    );
    await assert.rejects(service.setBudget(reviewer, 99999), /committed/);
    await service.setTeamBudget(reviewer, "root", 0);
    const row = await service.create(owner, input());
    await assert.rejects(
        service.approve(reviewer, row.id, 10000, "Project costs", stripe),
        /team allocation/,
    );
    assert.equal((await FinanceBudget.findById("usd-test")).reservedCents, 0);
});

test("team-envelope migration preserves old allocations and is idempotent", async () => {
    await approved();
    await FinanceTeamBudget.deleteMany({});
    await FinanceBudget.updateOne(
        { _id: "usd-test" },
        { $unset: { envelopeVersion: 1, teamAllocatedCents: 1 } },
    );
    await models.initializeFinanceModels();
    await models.initializeFinanceModels();
    assert.equal(
        (await FinanceBudget.findById("usd-test")).teamAllocatedCents,
        10000,
    );
    const team = await FinanceTeamBudget.findById("root");
    assert.equal(team.totalCents, 10000);
    assert.equal(team.reservedCents, 10000);
});

test("card-list totals match reconciled detail and remain requester-scoped", async () => {
    const card = await issued();
    await FinanceEntry.create([
        {
            stripeId: "ipttx_listing",
            kind: "transaction",
            cardId: card.stripeCardId,
            amount: -7600,
            currency: "usd",
        },
        {
            stripeId: "iauth_listing",
            kind: "authorization",
            cardId: card.stripeCardId,
            amount: 1200,
            currency: "usd",
        },
        {
            stripeId: "ipttx_other",
            kind: "transaction",
            cardId: "ic_somebodyelse",
            amount: -99999,
            currency: "usd",
        },
    ]);
    const list = await service.list(owner);
    assert.equal(list.length, 1);
    assert.equal(list[0].settledCents, 7600);
    assert.equal(list[0].heldCents, 1200);
    const detail = await service.detail(owner, list[0].id);
    assert.equal(list[0].settledCents, detail.settledCents);
    assert.equal(list[0].heldCents, detail.heldCents);
    assert.deepEqual(await service.list({ pk: 303, reviewer: false }), []);
});
