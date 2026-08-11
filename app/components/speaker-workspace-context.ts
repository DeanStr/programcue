import { useOutletContext } from "react-router";

import type { SpeakerPortal } from "~/components/speaker-dashboard-panel-shared";

export type SpeakerWorkspaceContext = {
  portal: SpeakerPortal;
  viewer: {
    name: string;
    email: string;
    demo: boolean;
  };
};

export function useSpeakerWorkspace() {
  return useOutletContext<SpeakerWorkspaceContext>();
}
