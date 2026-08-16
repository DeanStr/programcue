import { DEMO_ORGANISATION_ID } from "~/platform/demo/demo-identities";
import {
  type EvaluatorEmailRouting,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import type { Applicant } from "./submission-repository.server";
import { answerValidationError } from "./submission-service-foundation.server";

export async function routeEvaluationCoSpeakerEmails<
  Payload extends { speakers: Array<{ email: string }> },
>(
  env: CloudflareEnvironment,
  eventId: string,
  applicant: Applicant,
  payload: Payload,
): Promise<{
  payload: Payload;
  evaluatorEmailRoutings: EvaluatorEmailRouting[];
}> {
  if (!applicant.verified || applicant.evaluation !== true) {
    return { payload, evaluatorEmailRoutings: [] };
  }
  const resolutions = await Promise.all(
    payload.speakers.map(async (speaker, index) => {
      if (index === 0) return { speaker, routing: null };
      const resolution = await resolveEvaluatorEmailAlias(
        env,
        {
          organisationId: DEMO_ORGANISATION_ID,
          eventId,
          evaluation: true,
        },
        speaker.email,
      );
      return {
        speaker: { ...speaker, email: resolution.email },
        routing: resolution.routing,
      };
    }),
  );
  const speakers = resolutions.map((resolution) => resolution.speaker);
  const evaluatorEmailRoutings = resolutions.flatMap((resolution) =>
    resolution.routing ? [resolution.routing] : [],
  );
  if (
    new Set(speakers.map((speaker) => speaker.email)).size !== speakers.length
  ) {
    throw answerValidationError({
      speakers: ["Each speaker must resolve to a different evaluator inbox."],
    });
  }
  return {
    payload: { ...payload, speakers } as Payload,
    evaluatorEmailRoutings,
  };
}
