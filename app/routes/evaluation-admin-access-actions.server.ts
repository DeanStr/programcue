import { data } from "react-router";
import { evaluatorEmailRoutingMessage } from "~/platform/evaluation/evaluator-email-alias.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { EvaluationAdminActionContext } from "./evaluation-admin-action-shared.server";

export async function handleEvaluationAdminAccessIntent(
  context: EvaluationAdminActionContext,
) {
  const { env, viewer, values, service } = context;
  if (values.get("intent") === "add-discussion-message") {
    const result = await service.addDiscussionMessage(viewer, {
      roundId: values.get("roundId"),
      targetType: values.get("targetType"),
      targetId: values.get("targetId"),
      body: values.get("body"),
      idempotencyKey: values.get("idempotencyKey"),
    });
    return {
      ok: true,
      message: result.replayed
        ? "Discussion message was already added."
        : "Discussion message added.",
    };
  }

  if (values.get("intent") === "resend-accepted-speaker") {
    const result = await service.resendAcceptedSpeakerInvitation(viewer, {
      decisionId: values.get("decisionId"),
      membershipId: values.get("membershipId"),
      expectedExpiresAt: values.get("expectedExpiresAt"),
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "membership",
      entityId: String(values.get("membershipId") ?? ""),
      changeType: "updated",
    });
    const message =
      result.status === "queue_failed"
        ? "The speaker invitation was renewed, but its saved delivery needs a queue retry."
        : result.status === "sent"
          ? "The renewed speaker invitation was already delivered."
          : result.replayed
            ? "The renewed speaker invitation is already queued."
            : "A new seven-day speaker sign-in invitation was queued; every earlier link is invalid.";
    if (result.status === "queue_failed" || realtimeFailure) {
      return data(
        {
          ok: false,
          committed: true,
          message: [message, realtimeFailure?.message]
            .filter(Boolean)
            .join(" "),
        },
        { status: 207 },
      );
    }
    return { ok: true, message };
  }

  if (values.get("intent") === "invite-evaluation-member") {
    const result = await service.inviteEvaluationMember(viewer, {
      name: values.get("name"),
      email: values.get("email"),
      role: values.get("role"),
      teamId: values.get("teamId") || null,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "membership",
      entityId: result.membershipId,
      changeType: "created",
    });
    const roleLabel =
      values.get("role") === "committee_chair"
        ? "Committee-chair"
        : "Evaluator";
    const invitationMessage =
      result.delivery === "sent"
        ? `${roleLabel} invitation created and a one-time sign-in link was sent.`
        : result.demoAccessActivation === "activated" ||
            result.demoAccessActivation === "already_active"
          ? `Demo ${roleLabel.toLowerCase()} invitation created, and the fixed demo identity was activated locally. No email was sent.`
          : `Demo ${roleLabel.toLowerCase()} invitation created. No email was sent, because this is demo mode.`;
    const routingDisclosure = evaluatorEmailRoutingMessage(
      "routing" in result ? (result.routing ?? null) : null,
    );
    const message = `${invitationMessage}${routingDisclosure ? ` ${routingDisclosure}` : ""}`;
    if (realtimeFailure) {
      return data(
        {
          ok: false,
          committed: true,
          message: `${message} ${realtimeFailure.message}`,
        },
        { status: 207 },
      );
    }
    return { ok: true, message };
  }

  if (values.get("intent") === "change-chair-access") {
    const result = await service.changeCommitteeChairAccess(viewer, {
      personId: values.get("personId"),
      operation: values.get("operation"),
      confirmed: values.get("confirmed") === "true",
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "membership",
      entityId: result.membershipId,
      changeType: "updated",
    });
    const message =
      result.operation === "promote"
        ? "Evaluator promoted to committee chair."
        : "Committee-chair access revoked; named team-chair positions were cleared.";
    if (realtimeFailure)
      return data(
        {
          ok: false,
          committed: true,
          message: `${message} ${realtimeFailure.message}`,
        },
        { status: 207 },
      );
    return { ok: true, message };
  }

  return null;
}
