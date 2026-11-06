import type { Request } from "express";
import { AuthentikClient } from "../clients/AuthentikClient";
import { financeConfig, fail } from "./config";

export interface FinanceActor { pk: number; reviewer: boolean }

export async function financeActor(req: Request): Promise<FinanceActor> {
    const config = financeConfig();
    const pk = req.session.authorizedUser?.pk;
    if (!Number.isSafeInteger(pk) || !pk) fail(401, "Sign in to use finance");
    // Refresh from the directory; session groups can survive a membership change.
    const user = await new AuthentikClient().getUserInfo(pk!);
    if (!user.active || user.attributes?.alumniAccount)
        fail(403, "Finance requires an active current member");
    return { pk: pk!, reviewer: config.reviewers.has(pk!) };
}

export function requireReviewer(actor: FinanceActor) {
    if (!actor.reviewer) fail(403, "Independent finance reviewer permission required");
}

export async function requireTeamMember(pk: number, rootPk: string, subteamPk: string) {
    const directory = new AuthentikClient();
    const options = { disableSubteamMemberPopulate: true };
    const [root, subteam, user] = await Promise.all([
        directory.getGroupInfo(rootPk, options), directory.getGroupInfo(subteamPk, options),
        directory.getUserInfo(pk),
    ]);
    if (!user.active || user.attributes?.alumniAccount || root.parentPk ||
        subteam.parentPk !== root.pk || root.attributes.flaggedForDeletion ||
        root.attributes.archivedAt || subteam.attributes.flaggedForDeletion ||
        subteam.attributes.archivedAt ||
        !subteam.users.some((member) => String(member.pk) === String(pk)))
        fail(403, "Requester must be a current member of the selected active subteam");
}

// Browser cookie sessions need explicit same-origin protection for financial
// mutations. Do not trust forwarded Host or allow a caller-supplied origin.
export function requireFinanceOrigin(req: Request) {
    const configured = process.env.PEOPLEPORTAL_FINANCE_ORIGIN;
    if (!configured) fail(503, "Finance origin is not configured");
    const origin = req.get("origin");
    if (!origin || origin !== configured || req.get("sec-fetch-site") === "cross-site")
        fail(403, "Finance writes require the configured browser origin");
    if (!req.is("application/json")) fail(415, "Finance writes require JSON");
}
