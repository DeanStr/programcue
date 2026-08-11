export interface EvaluationAdminRealtimeFailure {
  ok: false;
  committed: true;
  entityId: string | null;
  message: string;
}

export function decisionActionOutcome(
  notificationStatus: "not_requested" | "queued" | "queue_failed",
  released: boolean,
  realtimeFailure: EvaluationAdminRealtimeFailure | null,
  webhookWarning: string | null = null,
  speakerInvitationStatus:
    | "not_required"
    | "queued"
    | "queue_failed"
    | "demo_not_sent" = "not_required",
  speakerInvitationCount = 0,
) {
  const warnings = [
    notificationStatus === "queue_failed"
      ? "Decision released. Its notification is saved but needs a queue retry."
      : null,
    realtimeFailure?.message ?? null,
    webhookWarning,
    speakerInvitationStatus === "queue_failed"
      ? `Speaker access was saved, but ${speakerInvitationCount} sign-in invitation${speakerInvitationCount === 1 ? "" : "s"} need${speakerInvitationCount === 1 ? "s" : ""} a queue retry.`
      : null,
  ].filter((warning): warning is string => Boolean(warning));
  if (warnings.length > 0) {
    return { partial: true as const, message: warnings.join(" ") };
  }
  return {
    partial: false as const,
    message: released
      ? `Decision released and notification queued.${
          speakerInvitationStatus === "queued"
            ? ` ${speakerInvitationCount} speaker sign-in invitation${speakerInvitationCount === 1 ? " was" : "s were"} queued.`
            : speakerInvitationStatus === "demo_not_sent"
              ? ` ${speakerInvitationCount} demo speaker invitation${speakerInvitationCount === 1 ? " was" : "s were"} saved; explicit demo mode sent no email.`
              : ""
        }`
      : "Decision draft saved.",
  };
}

export function canReleaseEvaluationDecisions(
  role: string,
  plan: { status: string; decisionRole: string } | null,
) {
  return (
    role === "owner" ||
    role === "administrator" ||
    (role === "committee_chair" &&
      plan?.status === "active" &&
      plan.decisionRole === "committee_chair")
  );
}
