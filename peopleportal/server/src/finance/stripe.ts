import Stripe from "stripe";
import { financeConfig, fail } from "./config";

export function stripeClient(): Stripe {
    return new Stripe(financeConfig().key, {
        apiVersion: "2026-10-28.endive",
        maxNetworkRetries: 2,
        timeout: 15_000,
    });
}

export function requireTestObject(object: { livemode?: boolean }) {
    if (object.livemode !== false)
        fail(409, "Expected a Stripe test-mode object");
}

export function requireUsableCardholder(holder: Stripe.Issuing.Cardholder) {
    requireTestObject(holder);
    if (
        holder.status !== "active" ||
        holder.requirements?.past_due?.length ||
        holder.requirements?.disabled_reason
    )
        fail(
            409,
            "Cardholder must complete Stripe requirements before issuance",
        );
}
