import express, { Request, Response } from "express";
import { stripeClient } from "./stripe";
import { processFinanceWebhook } from "./service";

export const financeWebhook = express.Router();
// Must be mounted before express.json(): Stripe signs the original bytes.
financeWebhook.post("/api/finance/webhook", express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res: Response) => {
        if (process.env.PEOPLEPORTAL_FINANCE_ENABLED !== "true") {
            res.status(503).json({ message: "Finance integration is disabled" }); return;
        }
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) { res.status(503).json({ message: "Finance webhook is not configured" }); return; }
        const signature = req.get("stripe-signature");
        if (!signature || !Buffer.isBuffer(req.body)) {
            res.status(400).json({ message: "Missing Stripe signature or raw payload" }); return;
        }
        let event;
        try { event = stripeClient().webhooks.constructEvent(req.body, signature, secret); }
        catch { res.status(400).json({ message: "Invalid Stripe webhook signature" }); return; }
        if (event.livemode) { res.status(400).json({ message: "Only test events are accepted" }); return; }
        try {
            await processFinanceWebhook(event);
            res.json({ received: true });
        } catch { res.status(503).json({ message: "Finance event processing failed; retry delivery" }); }
    });
