const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const { requireUsableCardholder } = require("../../dist/finance/stripe");

test("official Stripe SDK sends the Issuing API contract and idempotency header", async () => {
    const calls = [];
    const stripe = new Stripe("sk_test_local_fixture", {
        apiVersion: "2026-10-28.endive",
        httpClient: Stripe.createFetchHttpClient(async (url, options) => {
            calls.push({
                url: new URL(url),
                method: options.method,
                headers: new Headers(options.headers),
                body: new URLSearchParams(options.body),
            });
            return new Response(
                JSON.stringify({
                    id: "ic_fixture",
                    object: "issuing.card",
                    livemode: false,
                    status: "inactive",
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        }),
    });
    await stripe.issuing.cards.create(
        {
            cardholder: "ich_fixture",
            type: "virtual",
            currency: "usd",
            status: "inactive",
            spending_controls: {
                spending_limits: [{ amount: 10000, interval: "all_time" }],
            },
        },
        { idempotencyKey: "finance-card-fixture" },
    );
    await stripe.issuing.cards.update("ic_fixture", { status: "inactive" });
    await stripe.ephemeralKeys.create(
        { issuing_card: "ic_fixture", nonce: "nonce_fixture" },
        { apiVersion: "2026-10-28.endive" },
    );
    assert.equal(calls[0].url.pathname, "/v1/issuing/cards");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("stripe-version"), "2026-10-28.endive");
    assert.equal(
        calls[0].headers.get("idempotency-key"),
        "finance-card-fixture",
    );
    assert.equal(
        calls[0].body.get("spending_controls[spending_limits][0][amount]"),
        "10000",
    );
    assert.equal(calls[0].body.get("status"), "inactive");
    assert.equal(calls[1].url.pathname, "/v1/issuing/cards/ic_fixture");
    assert.equal(calls[1].body.get("status"), "inactive");
    assert.equal(calls[2].url.pathname, "/v1/ephemeral_keys");
    assert.equal(calls[2].body.get("issuing_card"), "ic_fixture");
    assert.equal(calls[2].body.get("nonce"), "nonce_fixture");
});

test("watchlist-disabled cardholders are blocked even without past-due fields", () => {
    assert.throws(
        () =>
            requireUsableCardholder({
                livemode: false,
                status: "active",
                requirements: { past_due: [], disabled_reason: "listed" },
            }),
        /requirements/,
    );
});
