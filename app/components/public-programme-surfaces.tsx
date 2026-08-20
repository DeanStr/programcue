import type { PublicProgrammeModel } from "./public-programme-model";
import { PublicScheduleSurface } from "./public-programme-schedule-surface";
import {
  PublicSpeakerGallerySurface,
  PublicSpeakersSurface,
} from "./public-programme-speakers-surface";
import { PublicTimetableSurface } from "./public-programme-timetable-surface";

export { publicTimetableLayout } from "./public-programme-timetable-surface";
export {
  PublicScheduleSurface,
  PublicSpeakerGallerySurface,
  PublicSpeakersSurface,
  PublicTimetableSurface,
};

export function PublicProgrammeSurfaceContent({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  if (model.surface === "schedule")
    return <PublicScheduleSurface model={model} />;
  if (model.surface === "timetable")
    return <PublicTimetableSurface model={model} />;
  if (model.surface === "speakers")
    return <PublicSpeakersSurface model={model} />;
  if (model.surface === "gallery")
    return <PublicSpeakerGallerySurface model={model} />;
  return null;
}
