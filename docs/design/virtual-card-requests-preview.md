# Virtual card request preview

This branch adds an interactive development-only Finance preview. Open /dev/finance/cards without signing in, or /finance/cards within the signed-in dashboard. The sidebar links to the standalone preview. All amounts, cards, identities and activity records are sample data held in React state; reloading resets everything. There is no Stripe connection or financial operation.

Team leads can enter a team/subteam, purpose, vendor, amount, one-time or monthly budget, and end date. New requests appear in the pending queue. The preview role selector exposes an independent finance reviewer who can approve an amount up to the request, decline with a reason, and freeze or resume simulated cards. The requester cannot approve their own request. Roles here illustrate the workflow and are not authorization controls.

Approved allocations reserve the demo club budget. Card tiles separate settled spending, pending authorizations and remaining allocation. Freezing a card retains its budget reservation. A detail panel includes request terms, review notes and activity history. Card numbers and CVCs are absent. Monthly rollover, real receipts, payments, policy-based access and audit persistence remain future backend work.

Integration requires club Issuing eligibility and account ownership confirmation, server-side membership and finance permissions, atomic budget reservation, idempotent issuance, verified webhooks, reconciliation and authorized Stripe Issuing Elements. Configured spending limits must not be described as guaranteed isolated balances. The preview routes and navigation are disabled outside development builds.

Run the existing pplui build and test targets with Nx. The source also removes an upstream duplicate pk property in the sidebar user object, which otherwise blocks TypeScript compilation.

## VS Code Remote SSH

Open this worktree as the remote folder. Workspace settings enable automatic port forwarding and label port 5180 as Virtual card UI preview. The persistent appdev-cards-preview user service serves the preview at http://localhost:5180/dev/finance/cards. If it is not listed automatically, use Forward a Port in the Ports panel and enter 5180. You can right-click its entry and choose Change Local Address Port to use a different local port while the service continues listening on remote port 5180.
