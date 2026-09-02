import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  BrowserWindow,
  between,
  Callout,
  ease,
  enter,
  FocusRing,
  fade,
  GridBackdrop,
  Hairline,
  Kicker,
  PhaseRail,
  type ProductSceneProps,
  rise,
  SegmentLabel,
  sans,
  softEase,
} from "./CommandSetupSceneShared";

function cssTransform(...parts: Array<string | number>) {
  return parts.join(" ");
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function Cursor({
  x,
  y,
  opacity = 1,
  scale = 1,
  click = false,
}: {
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
  click?: boolean;
}) {
  return (
    <div
      style={{
        height: 45,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width: 34,
        zIndex: 8,
      }}
    >
      {click ? (
        <span
          style={{
            border: `2px solid ${PALETTE.copper}`,
            borderRadius: "50%",
            height: 38,
            left: -5,
            opacity: 0.24,
            position: "absolute",
            top: -5,
            width: 38,
          }}
        />
      ) : null}
      <svg aria-hidden="true" height="42" viewBox="0 0 34 42" width="34">
        <path
          d="M3 2.5 4.2 31l7.9-6.2 5 11.6 5.1-2.2-5-11.7 10.3-.4L3 2.5Z"
          fill="#fffdf8"
          stroke="#10211e"
          strokeLinejoin="round"
          strokeWidth="2.5"
        />
      </svg>
    </div>
  );
}

function Metric({
  x,
  y,
  value,
  label,
  color = PALETTE.copperSoft,
  opacity = 1,
  transform,
}: {
  x: number;
  y: number;
  value: string;
  label: string;
  color?: string;
  opacity?: number;
  transform?: string;
}) {
  return (
    <div
      style={{
        color: PALETTE.paper,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        transform,
        zIndex: 4,
      }}
    >
      <div style={{ alignItems: "baseline", display: "flex", gap: 9 }}>
        <span
          style={{
            color,
            fontFamily: sans,
            fontSize: 47,
            fontWeight: 780,
            letterSpacing: "-0.06em",
            lineHeight: 0.95,
          }}
        >
          {value}
        </span>
        <span
          style={{
            color: "rgba(255,253,248,.68)",
            fontFamily: sans,
            fontSize: 13,
            fontWeight: 650,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          background: "rgba(255,253,248,.18)",
          height: 2,
          marginTop: 12,
          overflow: "hidden",
          width: 210,
        }}
      >
        <div style={{ background: color, height: "100%", width: "72%" }} />
      </div>
    </div>
  );
}

export function CommandScene({ duration }: ProductSceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 750;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const { fps } = useVideoConfig();

  const commandWindowX = 718;
  const commandWindowTop = 178;
  const commandWindowWidth = 1128;
  const commandWindowHeight = 760;
  const commandContentTop = 46;
  const sceneFade = fade(
    frame,
    0,
    58,
    Math.max(0, sourceDuration - 74),
    sourceDuration,
  );
  const intro = fade(frame, 0, 58, 580, 630);
  const commandWindowIn = enter(frame, 34, 74);
  const commandWindowY = between(frame, 24, 150, 56, 0, ease);
  const commandScale = between(frame, 0, 260, 0.96, 1.015, softEase);
  const titleY = rise(frame, 12, 28, 62);
  const focusOne = fade(frame, 180, 228, 425, 458);
  const focusTwo = fade(frame, 404, 444, 642, 682);
  const final = fade(frame, 636, 684, sourceDuration - 40, sourceDuration);
  const cursorLocalX = between(frame, 394, 478, 720, 576.45, ease);
  const cursorLocalY = between(frame, 394, 478, 100, 204.6, ease);
  const cursorClick = frame > 484 && frame < 524;

  // The command centre is the one product surface where the story depends on
  // reading a small amount of dense UI. Keep the browser chrome and editorial
  // copy steady, then move a single image/annotation camera through the two
  // important proof points. Focus rings and the cursor use the same camera
  // coordinates below, so they never drift from the UI they explain.
  const readinessProgress = between(frame, 100, 190, 0, 1, softEase);
  const actionProgress = between(frame, 350, 438, 0, 1, softEase);
  const actionEdgeFade = between(frame, 390, 460, 0, 1, softEase);
  const actionEdgeMatteWidth = mix(0, 292, actionEdgeFade);
  const actionEdgeFeather = mix(0, 10, actionEdgeFade);
  const commandZoom =
    frame < 100
      ? between(frame, 0, 100, 1, 1.08, softEase)
      : frame < 190
        ? between(frame, 100, 190, 1.08, 1.45, softEase)
        : frame < 350
          ? 1.45
          : frame < 438
            ? between(frame, 350, 438, 1.45, 1.56, softEase)
            : frame < 610
              ? 1.56
              : between(frame, 610, 678, 1.56, 1.06, softEase);
  // Keep the readiness pass flush to the browser edge so a zoom never opens
  // a paper-coloured gutter. The action pass can travel left, but is clamped
  // so the enlarged image still covers the browser viewport.
  const readinessPanX = 0;
  const actionPanX = Math.max(-580, 586 - 842 * commandZoom);
  const readinessPanY = -18;
  const actionPanY = -24;
  const focusPanX =
    frame < 350
      ? mix(0, readinessPanX, readinessProgress)
      : mix(readinessPanX, actionPanX, actionProgress);
  const focusPanY =
    frame < 350
      ? mix(0, readinessPanY, readinessProgress)
      : mix(readinessPanY, actionPanY, actionProgress);
  const commandPanExit = between(frame, 610, 678, 0, 1, softEase);
  const commandPanX = mix(focusPanX, 0, commandPanExit);
  const commandPanY = mix(focusPanY, 0, commandPanExit);
  const baseImageTop = between(frame, 0, 510, -4, -54, softEase);
  const commandImageTop = commandPanY + baseImageTop;

  const rawCursorX = commandWindowX + commandPanX + cursorLocalX * commandZoom;
  const rawCursorY =
    commandWindowTop +
    commandContentTop +
    commandImageTop +
    cursorLocalY * commandZoom;
  const windowCenterX = commandWindowX + commandWindowWidth / 2;
  const windowCenterY = commandWindowTop + commandWindowHeight / 2;
  const commandCursorX =
    windowCenterX + (rawCursorX - windowCenterX) * commandScale;
  const commandCursorY =
    windowCenterY +
    (rawCursorY - windowCenterY) * commandScale +
    commandWindowY;
  const cardSpring = spring({
    fps,
    frame: Math.max(0, frame - 202),
    config: { damping: 18, stiffness: 120, mass: 0.7 },
  });

  return (
    <AbsoluteFill
      style={{ color: PALETTE.paper, fontFamily: sans, overflow: "hidden" }}
    >
      <GridBackdrop />
      <div
        style={{
          background:
            "linear-gradient(90deg, rgba(10,20,18,.72), transparent 66%)",
          inset: 0,
          position: "absolute",
        }}
      />
      <SegmentLabel
        number="03 / 13"
        title="Command centre"
        opacity={sceneFade}
      />
      <PhaseRail
        active={frame > 430 ? 2 : frame > 180 ? 1 : 0}
        opacity={sceneFade}
        phases={["Readiness", "Blockers", "Actions"]}
      />

      <div
        style={{
          left: 80,
          opacity: intro,
          position: "absolute",
          top: 195,
          transform: `translateY(${titleY}px)`,
          width: 570,
          zIndex: 3,
        }}
      >
        <Kicker>Command centre</Kicker>
        <h1
          style={{
            fontFamily: sans,
            fontSize: 72,
            fontWeight: 760,
            letterSpacing: "-0.067em",
            lineHeight: 0.98,
            margin: "20px 0 0",
            maxWidth: 560,
          }}
        >
          Know what matters.
          <br />
          <span style={{ color: PALETTE.copperSoft }}>Move what’s next.</span>
        </h1>
        <p
          style={{
            color: "rgba(255,253,248,.70)",
            fontSize: 21,
            lineHeight: 1.45,
            margin: "26px 0 0",
            maxWidth: 475,
          }}
        >
          Readiness, priorities and ownership in one clear view.
        </p>
        <div
          style={{
            alignItems: "center",
            color: "rgba(255,253,248,.52)",
            display: "flex",
            fontSize: 12,
            fontWeight: 700,
            gap: 11,
            letterSpacing: "0.12em",
            marginTop: 54,
            textTransform: "uppercase",
          }}
        >
          <span
            style={{
              background: PALETTE.copperSoft,
              borderRadius: "50%",
              height: 7,
              width: 7,
            }}
          />
          Readiness · priorities · owners
        </div>
      </div>

      <BrowserWindow
        alt="Program Cue command centre showing event readiness and action queue"
        height={760}
        imageLeft={commandPanX}
        imageScale={commandZoom}
        imageTop={commandImageTop}
        imageWidth={1085}
        opacity={commandWindowIn}
        src={ASSETS.commandCentre}
        transform={cssTransform(
          `translateY(${commandWindowY}px)`,
          `scale(${commandScale})`,
        )}
        width={1128}
        x={718}
        y={178}
      >
        <div
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, #f7f6f0 0%, #f7f6f0 96%, rgba(247,246,240,0) 100%)",
            bottom: 0,
            left: 0,
            opacity: actionEdgeFade,
            pointerEvents: "none",
            position: "absolute",
            top: 0,
            width: actionEdgeMatteWidth + actionEdgeFeather,
            zIndex: 1,
          }}
        />
        <div
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, #f7f6f0 0%, #f7f6f0 94%, rgba(247,246,240,0) 100%)",
            bottom: 0,
            left: 0,
            opacity: actionEdgeFade,
            pointerEvents: "none",
            position: "absolute",
            top: commandImageTop + 302 * commandZoom,
            width: 640,
            zIndex: 1,
          }}
        />
        <FocusRing
          color={PALETTE.copper}
          height={138}
          opacity={between(frame, 176, 224, 0, 1, ease) * focusOne}
          radius={7}
          scale={commandZoom}
          width={365}
          x={commandPanX + 187 * commandZoom}
          y={commandImageTop + 153 * commandZoom}
        />
        <FocusRing
          color={PALETTE.gold}
          height={125}
          label="Action queue"
          labelPosition="top"
          opacity={focusTwo}
          radius={8}
          scale={commandZoom}
          width={503}
          x={commandPanX + 568 * commandZoom}
          y={commandImageTop + 153 * commandZoom}
        />
      </BrowserWindow>

      <Metric
        color={PALETTE.copperSoft}
        label="readiness"
        opacity={between(frame, 174, 228, 0, 1, ease) * focusOne}
        transform={`translateY(${rise(frame, 174, 15, 54)}px)`}
        value="75%"
        x={120}
        y={726}
      />
      <Callout
        body="See the whole programme at a glance, with every signal connected to its source."
        color={PALETTE.copperSoft}
        eyebrow="01 / readiness"
        opacity={between(frame, 174, 228, 0, 1, ease) * focusOne}
        title="See the whole programme at a glance."
        transform={`translateY(${rise(frame, 174, 18, 54)}px)`}
        width={340}
        x={120}
        y={829}
      />

      <Callout
        body="Open the exact workflow behind every priority and move straight into action."
        color={PALETTE.gold}
        eyebrow="02 / blockers"
        opacity={focusTwo}
        title="Go straight from priority to action."
        transform={`translateY(${rise(frame, 404, 18, 54)}px)`}
        width={355}
        x={120}
        y={744}
      />
      <Cursor
        click={cursorClick}
        opacity={focusTwo}
        scale={0.74 * commandZoom * commandScale}
        x={commandCursorX}
        y={commandCursorY}
      />

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(120deg, rgba(9,20,18,.96), rgba(18,37,33,.98))",
          opacity: final,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            left: 118,
            position: "absolute",
            top: 238,
            transform: `translateY(${between(frame, 636, 700, 24, 0, ease)}px)`,
          }}
        >
          <Kicker>Assigned actions</Kicker>
          <div
            style={{
              fontFamily: sans,
              fontSize: 70,
              fontWeight: 760,
              letterSpacing: "-0.07em",
              lineHeight: 1,
              marginTop: 24,
            }}
          >
            Move the programme
            <br />
            <span style={{ color: PALETTE.copperSoft }}>forward.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 20,
              lineHeight: 1.4,
              marginTop: 28,
              maxWidth: 480,
            }}
          >
            Go from the signal to the source workflow and act without losing
            momentum.
          </div>
        </div>
        <div
          style={{
            border: "1px solid rgba(255,253,248,.14)",
            borderRadius: 18,
            left: 1060,
            opacity: cardSpring,
            padding: 25,
            position: "absolute",
            top: 275,
            transform: `translateY(${(1 - cardSpring) * 24}px)`,
            width: 585,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                color: "rgba(255,253,248,.54)",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              Command centre / next
            </span>
            <span
              style={{
                backgroundColor: PALETTE.sage,
                borderRadius: 99,
                color: PALETTE.inkDeep,
                fontSize: 11,
                fontWeight: 800,
                padding: "6px 10px",
              }}
            >
              ON TRACK
            </span>
          </div>
          <div
            style={{
              color: PALETTE.paper,
              fontSize: 29,
              fontWeight: 720,
              letterSpacing: "-0.04em",
              marginTop: 23,
            }}
          >
            Resolve critical work
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 15,
              lineHeight: 1.45,
              marginTop: 9,
            }}
          >
            Open the filtered task list to see the owner, impact and available
            actions.
          </div>
          <Hairline color="rgba(255,253,248,.14)" />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginTop: 17,
            }}
          >
            <span
              style={{
                color: PALETTE.copperSoft,
                fontSize: 13,
                fontWeight: 760,
              }}
            >
              Open action queue
            </span>
            <span style={{ color: "rgba(255,253,248,.58)", fontSize: 19 }}>
              →
            </span>
          </div>
        </div>
        <div
          style={{ bottom: 54, left: 118, position: "absolute", right: 118 }}
        >
          <Hairline />
          <div
            style={{
              color: "rgba(255,253,248,.44)",
              fontSize: 11,
              letterSpacing: "0.12em",
              marginTop: 17,
              textTransform: "uppercase",
            }}
          >
            Program Cue · Organiser workspace
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
