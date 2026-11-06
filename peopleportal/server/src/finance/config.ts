import { ResourceAccessError } from "../utils/errors";

// First release deliberately accepts test keys only. Enabling live money needs
// a separate deployment review, rather than a switch on a demo screen.
export function financeConfig() {
    if (process.env.PEOPLEPORTAL_FINANCE_ENABLED !== "true")
        throw new ResourceAccessError(503, "Finance integration is disabled");
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (!/^(sk|rk)_test_/.test(key))
        throw new ResourceAccessError(503, "Finance requires a Stripe test key");
    const reviewers = new Set(
        (process.env.PEOPLEPORTAL_FINANCE_REVIEWER_PKS ?? "")
            .split(",").filter((v) => /^\d+$/.test(v.trim()))
            .map((v) => Number(v.trim())),
    );
    return { key, reviewers };
}

export function fail(status: number, message: string): never {
    throw new ResourceAccessError(status, message);
}

export function cents(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000_000)
        fail(422, "Amount must be integer cents between 1 and 100000000");
    return value;
}
