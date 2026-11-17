# Organization spending: design and launch gates

Reviewed against Stripe documentation on 17 November 2026. This branch is a
sandbox integration, not authorization to launch a live financial program.

## Recommended initial structure

Use one organization-owned Issuing program and funding balance, subject to
Stripe's confirmation that the proposed authorized users and use case qualify.
Represent internal teams with application budget envelopes rather than claiming
that each team is a separate business. All money remains organization money.
Do not create connected accounts for internal teams merely to obtain budgets.

Finance assigns a ceiling to each root team. Every subteam, card and custodian
under that team consumes the same envelope. The sum of team ceilings fits within
the club ceiling; approved card reservations fit within both the team and club
ceilings. These invariants are enforced in a MongoDB transaction, including under
concurrent approvals and budget edits. A missing team ceiling blocks approval.

For example, a $1,000 organization ceiling can fund $600 and $400 team envelopes.
The first team can allocate $200 and $300 cards, leaving $100 available for another
approval. Giving the same person cards for two teams does not merge team budgets.
An individual Stripe cardholder represents that person, not a team budget.

Give each card one accountable custodian and purpose. An organization can have
several cards per custodian. Finance maps an already onboarded cardholder; the
application does not invent identity information or consent. Team/vendor names
are accounting context, not proof that a merchant restriction is enforced.

## Allocation is different from cash and spending

The club ceiling and team envelopes are allocation limits, not bank accounts or
copies of Stripe's funded balance. Spending must also be supported by actual
Issuing funds. Fund only from the approved organization's bank/funding sources.

The initial policy reserves a card's entire approved commitment. Monthly cards
reserve every covered UTC month and have both monthly and all-time limits.
Cancellations, refunds and expiry retain reservations because late captures may
arrive. This is suitable for bounded project grants. It does not yet implement
rolling departmental budgets, automatic recycling, semester rollover, receipts,
accounting export, funding automation or disputes. Those workflows need explicit
policy and implementation before promising a full expense-management product.

Stripe's native controls support cards and cardholders, rather than arbitrary
application team groups. Cardholder limits aggregate one person's cards and can
be useful as another control, but cannot represent a team with several people.
Spending aggregation can lag by 30 seconds and later tips/fees can exceed limits.
The application therefore enforces allocation invariants, not a guarantee that
network settlement can never exceed the allocation.

For stricter pooled, shared team spending, add a separate synchronous
authorization service with atomic holds across all relevant cards. Stripe
requires a decision within two seconds. Configure timeout behavior to decline,
monitor it, and handle incremental authorizations, reversals and captures. Do not
subscribe the existing asynchronous webhook to issuing_authorization.request;
it is not that service. Even synchronous checks cannot prevent every late or
offline capture; maintain an explicit overage policy and liquidity buffer.

## Alternatives

Treasury for platforms can separate funds across Financial Accounts and attach
cards to those accounts. This is worth considering for separate cash
pots or additional money movement, rather than application budget envelopes.
It needs separate access, onboarding and operational work. Current v2 financial
accounts and associated Issuing capabilities include preview features; Stripe
labels Treasury v1 legacy and says not to start a new v1 integration. Confirm
availability, account count, bank terms and migration path with Stripe before
choosing it. It is not a configuration switch on this Issuing-only backend.

If the only requirement is team spending, compare a managed expense platform
before maintaining a card program. A custom integration makes sense when the
organization deliberately wants its own People Portal workflow and can support
finance operations, security, reconciliation and officer turnover.

## Organization configuration and launch sequence

1. Obtain Stripe and bank approval for the exact legal entity, funding sources,
   spending purposes and authorized users. A nonprofit's tax status does not
   automatically approve Issuing. Ask explicitly about unpaid volunteers and
   student members; do not describe them as employees or contractors if untrue.
2. Have an authorized organizational officer own the account and accept applicable
   terms. Use organization-controlled email, bank account, recovery and MFA, with
   a second responsible administrator and a documented officer handover.
3. Confirm direct Issuing versus Connect with Stripe. Internal teams are not
   separate legal customers. If Connect is required, implement the approved
   account model and scope every Stripe request, webhook and stored identifier
   to the correct account before launch. Do not apply platform credentials to a
   connected account implicitly.
4. Configure the sandbox first: disabled by default; test secret and publishable
   keys from the same account; endpoint-specific webhook signing secret; exact
   browser origin; independent finance reviewer PKs; transaction-capable MongoDB;
   running maintenance worker. Secret keys stay server-side. Card details stay
   in Stripe-hosted iframes. Reviewer rights do not reveal other people's cards.
5. Exercise actual Issuing sandbox creation, activation, spending, duplicate and
   out-of-order webhooks, account restrictions, expiry, revocation and recovery.
   Automated SDK/transport tests do not establish that a real account is enabled.
6. Before adding live mode, pin/verify the approved account ID and program, verify
   active capabilities and cardholder requirements, isolate live storage from
   sandbox data, and test account/mode mismatches. The current code rejects live
   keys and objects. Replacing sk_test_ with sk_live_ will not enable it.
7. Deploy durable sessions, secure cookies/TLS, database backups and restoration,
   webhook/worker monitoring, spending and liquidity alerts, audit retention,
   support/complaint/dispute procedures and emergency cancellation. Pilot a small
   approved allocation before scaling. Finance owns funding and approvals;
   technical administrators do not become reviewers automatically.

The sandbox is deliberately useful before approval without pretending that
commercial approval, operational readiness or live-mode implementation is done.

## Sources

- [Spending controls](https://docs.stripe.com/issuing/controls/spending-controls)
- [Real-time authorizations](https://docs.stripe.com/issuing/controls/real-time-authorizations)
- [How Issuing works](https://docs.stripe.com/issuing/how-issuing-works)
- [Issuing and Connect](https://docs.stripe.com/issuing/connect)
- [Cardholder types](https://docs.stripe.com/issuing/other/choose-cardholder)
- [Treasury for platforms](https://docs.stripe.com/treasury/connect)
- [Multiple Financial Accounts](https://docs.stripe.com/treasury/connect/examples/multi-financial-accounts)
- [Legacy Treasury v1](https://docs.stripe.com/treasury/connect/legacy/v1/account-management/financial-accounts)
- [US commercial compliance](https://docs.stripe.com/issuing/commercial-compliance)
- [US Issuing terms](https://stripe.com/legal/ssa-service-terms#stripe-issuing-accountholder-united-states)
