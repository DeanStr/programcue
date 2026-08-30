import { AdminParticipantPreviewPage } from "~/components/admin-participant-preview-page";
import {
  type AdminRecordBreadcrumbHandle,
  adminRecordBreadcrumbLabelAtPath,
} from "~/modules/administration/admin-route-breadcrumb";
import { getAdminParticipantPreview } from "~/modules/speakers/admin-participant-preview.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-participant-preview";

export const handle = {
  adminRecordBreadcrumbLabel(data: unknown) {
    if (!data || typeof data !== "object" || !("preview" in data)) {
      throw new Error("The participant preview breadcrumb is unavailable.");
    }
    const preview = (data as { preview: unknown }).preview;
    if (!preview || typeof preview !== "object" || !("available" in preview)) {
      throw new Error("The participant preview breadcrumb is unavailable.");
    }
    if (preview.available === true) {
      const portal = "portal" in preview ? preview.portal : null;
      const profile =
        portal && typeof portal === "object" && "profile" in portal
          ? portal.profile
          : null;
      const name =
        profile && typeof profile === "object" && "name" in profile
          ? profile.name
          : null;
      return typeof name === "string" && name.trim() ? name : "Participant";
    }
    return adminRecordBreadcrumbLabelAtPath(data, [
      "preview",
      "person",
      "name",
    ]);
  },
} satisfies AdminRecordBreadcrumbHandle;

export const meta: Route.MetaFunction = ({ loaderData }) => [
  {
    title: loaderData
      ? `${loaderData.preview.available ? (loaderData.preview.portal.profile.name ?? "Participant") : loaderData.preview.person.name} · Participant preview · Program Cue`
      : "Participant preview · Program Cue",
  },
];

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return {
    preview: await getAdminParticipantPreview(env, viewer, params.personId),
  };
}

export default function AdminParticipantPreviewRoute({
  loaderData,
}: Route.ComponentProps) {
  return <AdminParticipantPreviewPage preview={loaderData.preview} />;
}
