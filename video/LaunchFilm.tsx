import { loadFont } from "@remotion/fonts";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";

import { SCENE_DURATIONS, SCENE_KEYS } from "./constants";
import { AssistScene } from "./scenes/AssistScene";
import { ClosingScene, OpeningScene, RevealScene } from "./scenes/BrandScenes";
import { CollectScene, DecideScene } from "./scenes/CollectDecideScenes";
import { CommandScene, SetupScene } from "./scenes/CommandSetupScenes";
import {
  OperateScene,
  PlaceScene,
  PublishScene,
} from "./scenes/PlacePublishOperateScenes";
import {
  CommunicateScene,
  PrepareScene,
} from "./scenes/PrepareCommunicateScenes";

type LaunchFilmProps = {
  title: string;
};

void loadFont({
  family: "Program Cue Inter",
  url: staticFile("fonts/inter-latin-var.woff2"),
  format: "woff2",
  display: "swap",
  style: "normal",
  weight: "100 900",
});

const sceneComponents = {
  opening: OpeningScene,
  reveal: RevealScene,
  command: CommandScene,
  setup: SetupScene,
  collect: CollectScene,
  decide: DecideScene,
  prepare: PrepareScene,
  assist: AssistScene,
  communicate: CommunicateScene,
  place: PlaceScene,
  publish: PublishScene,
  operate: OperateScene,
  closing: ClosingScene,
} as const;

type SceneKey = keyof typeof sceneComponents;

const hasSceneComponent = (key: string): key is SceneKey =>
  Object.hasOwn(sceneComponents, key);

const makeTimelineScene = (key: string) => {
  if (!hasSceneComponent(key)) {
    throw new Error(`No launch-film scene component is registered for ${key}.`);
  }
  return { key, Scene: sceneComponents[key] };
};

const timeline = SCENE_KEYS.map(makeTimelineScene);
const canonicalKeys = new Set(SCENE_KEYS);
const unreferencedComponents = Object.keys(sceneComponents).filter(
  (key) => !canonicalKeys.has(key),
);
if (
  timeline.length !== Object.keys(sceneComponents).length ||
  unreferencedComponents.length > 0
) {
  throw new Error(
    `Launch-film scene components and video/timeline.json differ${
      unreferencedComponents.length > 0
        ? `; unreferenced: ${unreferencedComponents.join(", ")}`
        : ""
    }.`,
  );
}

const TRANSITION_HALF = 18;
const TRANSITION_DURATION = TRANSITION_HALF * 2;

const sceneSignals: Record<
  SceneKey,
  { accent: string; eyebrow: string; label: string }
> = {
  opening: {
    accent: "#f6c5a9",
    eyebrow: "MEET",
    label: "Program Cue",
  },
  reveal: {
    accent: "#f6c5a9",
    eyebrow: "CONNECT",
    label: "The whole programme, together",
  },
  command: {
    accent: "#8fbf9a",
    eyebrow: "SEE",
    label: "Know what needs attention",
  },
  assist: {
    accent: "#8fbf9a",
    eyebrow: "ASSIST",
    label: "Turn gaps into action",
  },
  setup: {
    accent: "#d4a72c",
    eyebrow: "SHAPE",
    label: "Set the event once",
  },
  collect: {
    accent: "#f6c5a9",
    eyebrow: "COLLECT",
    label: "Collect the ideas that matter",
  },
  decide: {
    accent: "#8fbf9a",
    eyebrow: "DECIDE",
    label: "Choose with confidence",
  },
  prepare: {
    accent: "#d4a72c",
    eyebrow: "PREPARE",
    label: "Turn yes into ready",
  },
  communicate: {
    accent: "#f6c5a9",
    eyebrow: "REACH",
    label: "Every message, connected",
  },
  place: {
    accent: "#8fbf9a",
    eyebrow: "PLACE",
    label: "Build a schedule that works",
  },
  publish: {
    accent: "#d4a72c",
    eyebrow: "SHARE",
    label: "One programme, every public view",
  },
  operate: {
    accent: "#8fbf9a",
    eyebrow: "OPERATE",
    label: "Stay in control",
  },
  closing: {
    accent: "#f6c5a9",
    eyebrow: "PROGRAM CUE",
    label: "Make the programme happen",
  },
};

const TransitionBridge = ({ toScene }: { toScene: SceneKey }) => {
  const frame = useCurrentFrame();
  const duration = TRANSITION_DURATION;
  const next = sceneSignals[toScene];
  const washOpacity = interpolate(
    frame,
    [0, 6, TRANSITION_HALF, duration - 7, duration - 1],
    [0, 0.22, 0.46, 0.18, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  const seam = interpolate(frame, [0, duration - 1], [-24, 124], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const gleam = interpolate(
    frame,
    [0, TRANSITION_HALF, duration - 1],
    [0, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  const cueOpacity = interpolate(
    frame,
    [0, 5, TRANSITION_HALF, duration - 7, duration - 1],
    [0, 0.84, 1, 0.72, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  const cueScale = interpolate(
    frame,
    [0, TRANSITION_HALF, duration - 1],
    [0.96, 1, 0.98],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <AbsoluteFill
      style={{
        background: "transparent",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 200,
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(112deg, rgba(11,20,19,0), rgba(11,20,19,.82) 34%, rgba(11,20,19,.66) 62%, rgba(11,20,19,0))",
          filter: "blur(0.4px)",
          inset: "-8% -18%",
          opacity: washOpacity,
          position: "absolute",
          transform: `translateX(${seam - 54}%) skewX(-10deg)`,
          width: "46%",
        }}
      />
      <div
        style={{
          background:
            "linear-gradient(90deg, rgba(7,15,14,.22), rgba(7,15,14,.04) 58%, rgba(7,15,14,0))",
          inset: 0,
          opacity: washOpacity,
          position: "absolute",
        }}
      />
      <div
        style={{
          alignItems: "center",
          backdropFilter: "blur(14px)",
          background: "rgba(7, 15, 14, 0.88)",
          border: `1px solid ${next.accent}66`,
          borderRadius: 999,
          boxShadow: "0 18px 54px rgba(0,0,0,.26)",
          display: "flex",
          gap: 13,
          left: `${seam}%`,
          minHeight: 44,
          opacity: cueOpacity,
          padding: "0 18px 0 14px",
          position: "absolute",
          top: "50%",
          transform: `translate3d(-50%, -50%, 0) scale(${cueScale})`,
          whiteSpace: "nowrap",
        }}
      >
        <div
          style={{
            border: `1px solid ${next.accent}88`,
            borderRadius: 999,
            height: 10,
            position: "relative",
            width: 10,
          }}
        >
          <div
            style={{
              background: next.accent,
              borderRadius: 999,
              height: 4,
              left: 2,
              position: "absolute",
              top: 2,
              width: 4,
            }}
          />
        </div>
        <span
          style={{
            color: next.accent,
            fontSize: 10,
            fontWeight: 820,
            letterSpacing: ".18em",
            textTransform: "uppercase",
          }}
        >
          {next.eyebrow}
        </span>
        <div
          style={{
            background: "rgba(255,253,248,.24)",
            height: 14,
            width: 1,
          }}
        />
        <span
          style={{
            color: "#fffdf8",
            fontSize: 16,
            fontWeight: 720,
            letterSpacing: "-.01em",
          }}
        >
          {next.label}
        </span>
      </div>
      <div
        style={{
          background:
            "linear-gradient(180deg, transparent, rgba(246,197,169,.78), rgba(190,98,66,.52), transparent)",
          boxShadow: "0 0 24px rgba(246,197,169,.28)",
          height: "118%",
          left: `${seam}%`,
          opacity: gleam * 0.62,
          position: "absolute",
          top: "-9%",
          transform: "skewX(-10deg)",
          width: 2,
        }}
      />
    </AbsoluteFill>
  );
};

export const LaunchFilm = ({ title: _title }: LaunchFilmProps) => {
  let cursor = 0;
  const scenes = timeline.map(({ key, Scene }) => {
    const from = cursor;
    const duration = SCENE_DURATIONS[key];
    cursor += duration;
    return { duration, from, key, Scene };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1413" }}>
      <Audio
        src={staticFile("video/program-cue-score.wav")}
        // The deterministic WAV owns its mastering and its short fades. Keep
        // Remotion at unity so the music-only film does not lose 2.9 dB.
        volume={1}
      />

      {scenes.map(({ duration, from, key, Scene }) => (
        <Sequence
          key={key}
          from={from}
          durationInFrames={duration}
          premountFor={30}
        >
          <Scene duration={duration} />
        </Sequence>
      ))}

      {scenes.slice(1).map(({ from: boundary, key }) => (
        <Sequence
          key={`bridge-${boundary}`}
          from={boundary - TRANSITION_HALF}
          durationInFrames={TRANSITION_DURATION}
          premountFor={12}
        >
          <TransitionBridge toScene={key} />
        </Sequence>
      ))}

      <AbsoluteFill
        style={{
          pointerEvents: "none",
          boxShadow: "inset 0 0 180px rgba(4, 10, 9, 0.34)",
        }}
      />
    </AbsoluteFill>
  );
};
