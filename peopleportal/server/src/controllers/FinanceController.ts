import {
    Body,
    Controller,
    Get,
    Path,
    Post,
    Put,
    Query,
    Request,
    Route,
    Security,
    SuccessResponse,
    Tags,
} from "tsoa";
import type { Request as ExpressRequest } from "express";
import { AuthentikClient } from "../clients/AuthentikClient";
import {
    financeActor,
    requireTeamMember,
    requireFinanceOrigin,
    requireReviewer,
} from "../finance/access";
import {
    CreateFinanceRequest,
    FinanceService,
    reconcileFinanceRequest,
} from "../finance/service";

@Route("/api/finance")
@Tags("Finance (Stripe Issuing test mode)")
@Security("oidc")
export class FinanceController extends Controller {
    private service = new FinanceService();

    /** Current server-authorized role and verified subteam memberships. */
    @SuccessResponse(200)
    @Get("context")
    async context(@Request() req: ExpressRequest) {
        const actor = await financeActor(req);
        const directory = new AuthentikClient();
        const user = await directory.getUserInfo(actor.pk);
        const { memberships } = await directory.getTeamMembershipsForUsername(
            user.username,
        );
        const teams: {
            rootTeamPk: string;
            subteamPk: string;
            team: string;
            subteam: string;
        }[] = [];
        for (const membership of memberships) {
            if (
                !membership.parent ||
                membership.flaggedForDeletion ||
                membership.archivedAt
            )
                continue;
            // Use the same authoritative checks as request creation. Directory
            // errors fail the context load rather than fabricating empty access.
            try {
                await requireTeamMember(
                    actor.pk,
                    membership.parent,
                    membership.pk,
                );
            } catch (error) {
                if ((error as { status?: number }).status === 403) continue;
                throw error;
            }
            teams.push({
                rootTeamPk: membership.parent,
                subteamPk: membership.pk,
                team:
                    membership.parentFriendlyName ||
                    membership.parentName ||
                    membership.parent,
                subteam: membership.friendlyName || membership.name,
            });
        }
        const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
        return {
            userPk: actor.pk,
            reviewer: actor.reviewer,
            teams,
            publishableKey: publishableKey?.startsWith("pk_test_")
                ? publishableKey
                : null,
        };
    }

    @SuccessResponse(200)
    @Post("requests")
    async create(
        @Request() req: ExpressRequest,
        @Body() body: CreateFinanceRequest,
    ) {
        requireFinanceOrigin(req);
        return this.service.create(await financeActor(req), body);
    }

    @SuccessResponse(200)
    @Get("requests")
    async list(@Request() req: ExpressRequest, @Query() before?: string) {
        return this.service.list(await financeActor(req), before);
    }

    @SuccessResponse(200)
    @Get("requests/{id}")
    async detail(@Request() req: ExpressRequest, @Path() id: string) {
        return this.service.detail(await financeActor(req), id);
    }

    @SuccessResponse(200)
    @Post("requests/{id}/approve")
    async approve(
        @Request() req: ExpressRequest,
        @Path() id: string,
        @Body() body: { approvedCents: number; note: string },
    ) {
        requireFinanceOrigin(req);
        return this.service.approve(
            await financeActor(req),
            id,
            body.approvedCents,
            body.note,
        );
    }

    @SuccessResponse(200)
    @Post("requests/{id}/decline")
    async decline(
        @Request() req: ExpressRequest,
        @Path() id: string,
        @Body() body: { note: string },
    ) {
        requireFinanceOrigin(req);
        return this.service.decline(await financeActor(req), id, body.note);
    }

    @SuccessResponse(200)
    @Put("requests/{id}/card-status")
    async cardStatus(
        @Request() req: ExpressRequest,
        @Path() id: string,
        @Body() body: { status: "active" | "inactive" | "canceled" },
    ) {
        requireFinanceOrigin(req);
        return this.service.setCardStatus(
            await financeActor(req),
            id,
            body.status,
        );
    }

    @SuccessResponse(200)
    @Post("requests/{id}/reconcile")
    async reconcile(@Request() req: ExpressRequest, @Path() id: string) {
        requireFinanceOrigin(req);
        const actor = await financeActor(req);
        requireReviewer(actor);
        await reconcileFinanceRequest(id);
        return this.service.detail(actor, id);
    }

    @SuccessResponse(200)
    @Get("budget")
    async budget(@Request() req: ExpressRequest) {
        return this.service.budget(await financeActor(req));
    }

    /** Exchange a Stripe.js nonce; PAN/CVC never pass through this server. */
    @SuccessResponse(200)
    @Post("requests/{id}/ephemeral-key")
    async ephemeralKey(
        @Request() req: ExpressRequest,
        @Path() id: string,
        @Body() body: { nonce: string },
    ) {
        requireFinanceOrigin(req);
        req.res?.setHeader("Cache-Control", "no-store");
        return this.service.ephemeralKey(
            await financeActor(req),
            id,
            body.nonce,
        );
    }

    @SuccessResponse(200)
    @Put("budget")
    async setBudget(
        @Request() req: ExpressRequest,
        @Body() body: { totalCents: number },
    ) {
        requireFinanceOrigin(req);
        return this.service.setBudget(await financeActor(req), body.totalCents);
    }

    @SuccessResponse(200)
    @Get("team-budgets")
    async teamBudgets(@Request() req: ExpressRequest) {
        return this.service.teamBudgets(await financeActor(req));
    }

    @SuccessResponse(200)
    @Put("team-budgets/{rootTeamPk}")
    async setTeamBudget(
        @Request() req: ExpressRequest,
        @Path() rootTeamPk: string,
        @Body() body: { totalCents: number },
    ) {
        requireFinanceOrigin(req);
        return this.service.setTeamBudget(
            await financeActor(req),
            rootTeamPk,
            body.totalCents,
        );
    }

    /** Map a person to a cardholder already onboarded by finance in Stripe. */
    @SuccessResponse(200)
    @Put("cardholders/{userPk}")
    async cardholder(
        @Request() req: ExpressRequest,
        @Path() userPk: number,
        @Body() body: { stripeCardholderId: string },
    ) {
        requireFinanceOrigin(req);
        return this.service.assignCardholder(
            await financeActor(req),
            userPk,
            body.stripeCardholderId,
        );
    }
}
