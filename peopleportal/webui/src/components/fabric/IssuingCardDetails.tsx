import { useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { financeApi } from "@/commons/finance-api";

export function IssuingCardDetails({
    requestId,
    cardId,
    publishableKey,
}: {
    requestId: string;
    cardId: string;
    publishableKey: string;
}) {
    const number = useRef<HTMLDivElement>(null);
    const expiry = useRef<HTMLDivElement>(null);
    const cvc = useRef<HTMLDivElement>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const displays: { destroy(): void }[] = [];
        async function mount() {
            const stripe = await loadStripe(publishableKey);
            if (!stripe || stopped) return;
            const result = await stripe.createEphemeralKeyNonce({
                issuingCard: cardId,
            });
            if (result.error || !result.nonce)
                throw new Error("Stripe could not authorize card details.");
            const { ephemeralKeySecret, expires } = await financeApi<{
                ephemeralKeySecret: string;
                expires: number;
            }>(`requests/${requestId}/ephemeral-key`, "POST", {
                nonce: result.nonce,
            });
            if (stopped) return;
            // Newer Stripe.js registers the card before Elements creation.
            // The published TypeScript SDK also supports the legacy path.
            const issuing = stripe as typeof stripe & {
                retrieveIssuingCard?: (
                    id: string,
                    options: { ephemeralKeySecret: string; nonce: string },
                ) => Promise<{ error?: unknown }>;
            };
            if (issuing.retrieveIssuingCard) {
                const registered = await issuing.retrieveIssuingCard(cardId, {
                    ephemeralKeySecret,
                    nonce: result.nonce,
                });
                if (registered.error)
                    throw new Error("Stripe could not retrieve this card.");
            }
            if (stopped) return;
            const elements = stripe.elements();
            const options = {
                issuingCard: cardId,
                nonce: result.nonce,
                ephemeralKeySecret,
            };
            const fields = [
                elements.create("issuingCardNumberDisplay", options),
                elements.create("issuingCardExpiryDisplay", options),
                elements.create("issuingCardCvcDisplay", options),
            ];
            displays.push(...fields);
            [number, expiry, cvc].forEach((container, i) => {
                if (container.current) fields[i].mount(container.current);
            });
            // Hide details before their short-lived authorization expires.
            timer = setTimeout(
                () => {
                    displays.splice(0).forEach((element) => element.destroy());
                    setError(
                        "Card details expired. Hide and show them again to refresh.",
                    );
                },
                Math.max(0, expires * 1000 - Date.now() - 5000),
            );
        }
        void mount().catch(() => {
            displays.splice(0).forEach((element) => element.destroy());
            if (!stopped)
                setError(
                    "Could not display card details. Hide and show them again to retry.",
                );
        });
        return () => {
            stopped = true;
            clearTimeout(timer);
            displays.splice(0).forEach((element) => element.destroy());
        };
    }, [requestId, cardId, publishableKey]);
    return (
        <section
            className="space-y-3 rounded-lg border p-4"
            aria-label="Secure card details"
        >
            {error && <p role="alert">{error}</p>}
            <p className="text-xs text-muted-foreground">Card number</p>
            <div ref={number} className="min-h-6" />
            <p className="text-xs text-muted-foreground">Expiry</p>
            <div ref={expiry} className="min-h-6" />
            <p className="text-xs text-muted-foreground">CVC</p>
            <div ref={cvc} className="min-h-6" />
        </section>
    );
}
