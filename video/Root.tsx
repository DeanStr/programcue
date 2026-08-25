import { Composition } from "remotion";

import { FILM_TITLE, TOTAL_FRAMES, VIDEO } from "./constants";
import { LaunchFilm } from "./LaunchFilm";

export const VideoRoot = () => (
  <Composition
    id="ProgramCueLaunch"
    component={LaunchFilm}
    durationInFrames={TOTAL_FRAMES}
    fps={VIDEO.fps}
    width={VIDEO.width}
    height={VIDEO.height}
    defaultProps={{ title: FILM_TITLE }}
  />
);
