import { loadFont } from "@remotion/fonts";
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";

import { ProgramCueMark } from "./components/ProgramCueBrand";
import { PALETTE, SCENE_DURATIONS, SCENE_KEYS } from "./constants";
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

// Keep the title still for 1.2 seconds between the two 0.6-second wipes.
// The closing wipe keeps its original lead; the hold uses the next scene’s
// establishing beat so outgoing results retain their reading time.
const TRANSITION_WIPE = 18;
const TRANSITION_HOLD = 36;
const TRANSITION_DURATION = TRANSITION_WIPE * 2 + TRANSITION_HOLD;

type ApertureDirection = "bottom" | "left" | "right" | "top";

const sceneSignals: Record<
  SceneKey,
  {
    accent: string;
    direction: ApertureDirection;
    energy: number;
    eyebrow: string;
    label: string;
  }
> = {
  opening: {
    accent: "#f6c5a9",
    direction: "left",
    energy: 0.74,
    eyebrow: "MEET",
    label: "Program Cue",
  },
  reveal: {
    accent: "#f6c5a9",
    direction: "right",
    energy: 0.72,
    eyebrow: "CONNECT",
    label: "The whole program, together",
  },
  command: {
    accent: "#8fbf9a",
    direction: "left",
    energy: 0.9,
    eyebrow: "SEE",
    label: "Know what needs attention",
  },
  assist: {
    accent: "#8fbf9a",
    direction: "right",
    energy: 0.92,
    eyebrow: "ASSIST",
    label: "Turn gaps into action",
  },
  setup: {
    accent: "#d4a72c",
    direction: "bottom",
    energy: 0.68,
    eyebrow: "SHAPE",
    label: "Set the event once",
  },
  collect: {
    accent: "#f6c5a9",
    direction: "right",
    energy: 0.84,
    eyebrow: "COLLECT",
    label: "Collect the ideas that matter",
  },
  decide: {
    accent: "#8fbf9a",
    direction: "left",
    energy: 1,
    eyebrow: "DECIDE",
    label: "Choose with confidence",
  },
  prepare: {
    accent: "#d4a72c",
    direction: "top",
    energy: 0.7,
    eyebrow: "PREPARE",
    label: "Turn yes into momentum",
  },
  communicate: {
    accent: "#f6c5a9",
    direction: "left",
    energy: 0.78,
    eyebrow: "REACH",
    label: "Every message, connected",
  },
  place: {
    accent: "#8fbf9a",
    direction: "bottom",
    energy: 1.04,
    eyebrow: "PLACE",
    label: "Build a schedule that works",
  },
  publish: {
    accent: "#d4a72c",
    direction: "left",
    energy: 1.18,
    eyebrow: "SHARE",
    label: "One program. Everywhere it matters.",
  },
  operate: {
    accent: "#8fbf9a",
    direction: "right",
    energy: 0.76,
    eyebrow: "OPERATE",
    label: "Stay in control",
  },
  closing: {
    accent: "#f6c5a9",
    direction: "top",
    energy: 0.64,
    eyebrow: "PROGRAM CUE",
    label: "Make the program happen",
  },
};

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const apertureEase = Easing.bezier(0.76, 0, 0.24, 1);
const cueEase = Easing.bezier(0.22, 1, 0.36, 1);

const matteClipPath = (
  direction: ApertureDirection,
  coverage: number,
  revealing: boolean,
) => {
  const open = `${Math.max(0, Math.min(100, (1 - coverage) * 100))}%`;

  if (revealing) {
    switch (direction) {
      case "right":
        return `inset(0 ${open} 0 0)`;
      case "top":
        return `inset(${open} 0 0 0)`;
      case "bottom":
        return `inset(0 0 ${open} 0)`;
      default:
        return `inset(0 0 0 ${open})`;
    }
  }

  switch (direction) {
    case "right":
      return `inset(0 0 0 ${open})`;
    case "top":
      return `inset(0 0 ${open} 0)`;
    case "bottom":
      return `inset(${open} 0 0 0)`;
    default:
      return `inset(0 ${open} 0 0)`;
  }
};

const ApertureCorners = ({
  accent,
  opacity,
  spread,
}: {
  accent: string;
  opacity: number;
  spread: number;
}) => (
  <div
    style={{
      inset: spread,
      opacity,
      position: "absolute",
      transform: `scale(${interpolate(spread, [66, 92], [1, 1.025], clamp)})`,
    }}
  >
    {[0, 1, 2, 3].map((corner) => {
      const onTop = corner < 2;
      const onLeft = corner % 2 === 0;
      return (
        <div
          key={corner}
          style={{
            borderBottom: onTop ? undefined : `2px solid ${accent}`,
            borderLeft: onLeft ? `2px solid ${accent}` : undefined,
            borderRight: onLeft ? undefined : `2px solid ${accent}`,
            borderTop: onTop ? `2px solid ${accent}` : undefined,
            bottom: onTop ? undefined : 0,
            height: 54,
            left: onLeft ? 0 : undefined,
            position: "absolute",
            right: onLeft ? undefined : 0,
            top: onTop ? 0 : undefined,
            width: 54,
          }}
        />
      );
    })}
  </div>
);

const TransitionBridge = ({ toScene }: { toScene: SceneKey }) => {
  const frame = useCurrentFrame();
  const next = sceneSignals[toScene];
  const revealStart = TRANSITION_WIPE + TRANSITION_HOLD;
  const revealing = frame > revealStart;
  const rawProgress = revealing
    ? interpolate(frame, [revealStart, TRANSITION_DURATION - 1], [0, 1], clamp)
    : interpolate(frame, [0, TRANSITION_WIPE], [0, 1], clamp);
  const energyExponent = interpolate(
    next.energy,
    [0.64, 1.18],
    [1.08, 0.84],
    clamp,
  );
  const apertureProgress = apertureEase(rawProgress) ** energyExponent;
  const coverage = revealing ? 1 - apertureProgress : apertureProgress;
  const temporalCueOpacity = interpolate(
    frame,
    [0, 8, 14, revealStart, revealStart + 13, TRANSITION_DURATION - 1],
    [0, 0, 0.92, 1, 0.56, 0],
    { ...clamp, easing: cueEase },
  );
  const cueOpacity =
    temporalCueOpacity * interpolate(coverage, [0.62, 0.74], [0, 1], clamp);
  const directionSign =
    next.direction === "right" || next.direction === "bottom" ? 1 : -1;
  const cueOffset = interpolate(
    frame,
    [0, 12, TRANSITION_WIPE, revealStart + 9, TRANSITION_DURATION - 1],
    [directionSign * 12, 0, 0, 0, directionSign * -8],
    clamp,
  );
  const cueScale = interpolate(
    frame,
    [0, TRANSITION_WIPE, revealStart, TRANSITION_DURATION - 1],
    [0.985, 1, 1, 0.995],
    { ...clamp, easing: cueEase },
  );
  const edgeOpacity =
    Math.sin(apertureProgress * Math.PI) * (0.42 + next.energy * 0.26);
  const edgePosition =
    (next.direction === "right" || next.direction === "bottom"
      ? 1 - apertureProgress
      : apertureProgress) * 100;
  const verticalEdge = next.direction === "left" || next.direction === "right";
  const cornerSpread = interpolate(coverage, [0, 1], [92, 66], clamp);
  const chapter = `${String(SCENE_KEYS.indexOf(toScene) + 1).padStart(2, "0")} / ${String(
    SCENE_KEYS.length,
  ).padStart(2, "0")}`;
  const glowPosition: Record<ApertureDirection, string> = {
    bottom: "50% 105%",
    left: "-5% 50%",
    right: "105% 50%",
    top: "50% -5%",
  };

  return (
    <AbsoluteFill
      style={{
        background: "transparent",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 200,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundColor: PALETTE.ink,
          opacity: frame === TRANSITION_WIPE ? 1 : 0,
        }}
      />

      <div
        style={{
          backgroundColor: PALETTE.ink,
          backgroundImage: `radial-gradient(circle at ${glowPosition[next.direction]}, ${next.accent}24 0, transparent ${
            42 - next.energy * 7
          }%), linear-gradient(135deg, rgba(255,253,248,.026), transparent 44%, ${PALETTE.copper}12)`,
          clipPath: matteClipPath(next.direction, coverage, revealing),
          inset: -2,
          overflow: "hidden",
          position: "absolute",
          willChange: "clip-path",
        }}
      >
        <div
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,253,248,.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,253,248,.022) 1px, transparent 1px)",
            backgroundPosition: "center",
            backgroundSize: "72px 72px",
            inset: 0,
            opacity: 0.54 + next.energy * 0.12,
            position: "absolute",
          }}
        />

        <ApertureCorners
          accent={`${next.accent}94`}
          opacity={cueOpacity * (0.72 + next.energy * 0.14)}
          spread={cornerSpread}
        />

        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 24,
            left: "50%",
            opacity: cueOpacity,
            position: "absolute",
            top: "50%",
            transform: `translate3d(-50%, -50%, 0) ${
              verticalEdge
                ? `translateX(${cueOffset}px)`
                : `translateY(${cueOffset}px)`
            } scale(${cueScale})`,
            transformOrigin: "center",
            whiteSpace: "nowrap",
          }}
        >
          <ProgramCueMark accent={next.accent} ink={PALETTE.paper} size={64} />
          <div
            style={{
              background: `linear-gradient(90deg, ${PALETTE.copper}, ${next.accent})`,
              boxShadow: `0 0 ${12 + next.energy * 9}px ${next.accent}38`,
              height: 2,
              width: 66 + next.energy * 22,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                alignItems: "center",
                display: "flex",
                gap: 12,
              }}
            >
              <span
                style={{
                  color: next.accent,
                  fontSize: 11,
                  fontWeight: 820,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                }}
              >
                {next.eyebrow}
              </span>
              <span
                style={{
                  color: "rgba(255,253,248,.42)",
                  fontSize: 10,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 650,
                  letterSpacing: ".12em",
                }}
              >
                {chapter}
              </span>
            </div>
            <span
              style={{
                color: PALETTE.paper,
                fontSize: 42,
                fontWeight: 690,
                letterSpacing: "-.025em",
                lineHeight: 1.05,
                textShadow: "0 7px 26px rgba(0,0,0,.28)",
              }}
            >
              {next.label}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          background: verticalEdge
            ? `linear-gradient(180deg, transparent, ${next.accent}, ${PALETTE.copper}, transparent)`
            : `linear-gradient(90deg, transparent, ${next.accent}, ${PALETTE.copper}, transparent)`,
          boxShadow: `0 0 ${18 + next.energy * 14}px ${next.accent}55`,
          height: verticalEdge ? "116%" : 2,
          left: verticalEdge ? `${edgePosition}%` : "-8%",
          opacity: edgeOpacity,
          position: "absolute",
          top: verticalEdge ? "-8%" : `${edgePosition}%`,
          width: verticalEdge ? 2 : "116%",
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
        // `video:score` recovers the selected, released Eleven soundtrack as a
        // picture-locked WAV for Studio and Remotion. Keep it at unity.
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
          from={boundary - TRANSITION_WIPE}
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
