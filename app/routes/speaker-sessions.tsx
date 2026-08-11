import type { Route } from "./+types/speaker-sessions";
import { SpeakerSessionsPanel } from "~/components/speaker-dashboard-overview";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";

export const meta = () => [{ title: "My Sessions · Program Cue" }];

export default function SpeakerSessions(_props: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Programme</span>
          <h1>My sessions</h1>
          <p>Published schedule details and your role in each session.</p>
        </div>
      </div>
      <SpeakerSessionsPanel portal={portal} />
    </>
  );
}
