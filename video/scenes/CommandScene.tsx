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
  pressProgress = 0,
  firstRippleProgress,
  secondRippleProgress,
}: {
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
  pressProgress?: number;
  firstRippleProgress?: number;
  secondRippleProgress?: number;
}) {
  return (
    <div
      style={{
        height: 45,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        transform: `scale(${scale * (1 - pressProgress * 0.075)})`,
        transformOrigin: "top left",
        width: 34,
        zIndex: 8,
      }}
    >
      {firstRippleProgress !== undefined ? (
        <span
          style={{
            border: `2px solid ${PALETTE.copper}`,
            borderRadius: "50%",
            boxShadow: `0 0 24px ${PALETTE.copper}55`,
            height: 42,
            left: -8,
            opacity: (1 - firstRippleProgress) * 0.78,
            position: "absolute",
            top: -8,
            transform: `scale(${0.68 + firstRippleProgress * 1.45})`,
            transformOrigin: "center",
            width: 42,
          }}
        />
      ) : null}
      {secondRippleProgress !== undefined ? (
        <span
          style={{
            border: `2px solid ${PALETTE.copperSoft}`,
            borderRadius: "50%",
            height: 42,
            left: -8,
            opacity: (1 - secondRippleProgress) * 0.5,
            position: "absolute",
            top: -8,
            transform: `scale(${0.74 + secondRippleProgress * 1.08})`,
            transformOrigin: "center",
            width: 42,
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
  progress = 0.8,
  status,
  transform,
}: {
  x: number;
  y: number;
  value: string;
  label: string;
  color?: string;
  opacity?: number;
  progress?: number;
  status?: string;
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
            fontSize: 58,
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
            fontSize: 15,
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
          height: 3,
          marginTop: 12,
          overflow: "hidden",
          width: 270,
        }}
      >
        <div
          style={{
            background: color,
            height: "100%",
            width: `${Math.round(progress * 100)}%`,
          }}
        />
      </div>
      {status ? (
        <div
          style={{
            color: PALETTE.paper,
            fontFamily: sans,
            fontSize: 17,
            fontWeight: 720,
            marginTop: 13,
          }}
        >
          {status}
        </div>
      ) : null}
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
  const clickStart = 470;
  const clickRelease = clickStart + 10;
  const finalStart = 492;
  const finalContentStart = finalStart + 8;
  const handoffOpacity = between(
    timelineFrame,
    finalStart - 12,
    finalStart,
    1,
    0,
    softEase,
  );
  const intro = fade(frame, 0, 58, 580, 630) * handoffOpacity;
  const commandWindowIn = enter(frame, 34, 74);
  const commandWindowY = between(frame, 24, 150, 56, 0, ease);
  const commandScale = between(frame, 0, 260, 0.96, 1.015, softEase);
  const titleY = rise(frame, 12, 28, 62);
  const focusOne = fade(frame, 180, 228, 425, 458);
  const focusTwo = fade(frame, 404, 444, 642, 682) * handoffOpacity;
  // Keep the previous product surface covered until the chapter wipe takes over.
  const finalMatte = enter(
    timelineFrame,
    finalStart,
    finalContentStart - finalStart,
  );
  const final = fade(
    timelineFrame,
    finalContentStart,
    finalContentStart + 20,
    duration - 40,
    duration,
  );
  const cursorLocalX = between(frame, 394, 478, 742, 1034, ease);
  const cursorLocalY = between(frame, 394, 478, 112, 204, ease);
  const cursorPress =
    timelineFrame >= clickStart && timelineFrame <= clickRelease
      ? timelineFrame <= clickStart + 5
        ? between(timelineFrame, clickStart, clickStart + 5, 0, 1, ease)
        : between(timelineFrame, clickStart + 5, clickRelease, 1, 0, ease)
      : 0;
  const firstRippleProgress =
    timelineFrame >= clickStart && timelineFrame <= clickStart + 22
      ? between(timelineFrame, clickStart, clickStart + 22, 0, 1, ease)
      : undefined;
  const secondRippleStart = clickStart + 6;
  const secondRippleProgress =
    timelineFrame >= secondRippleStart &&
    timelineFrame <= secondRippleStart + 20
      ? between(
          timelineFrame,
          secondRippleStart,
          secondRippleStart + 20,
          0,
          1,
          ease,
        )
      : undefined;
  const actionResponse = Math.min(
    between(timelineFrame, clickStart + 2, clickStart + 4, 0, 1, ease),
    between(timelineFrame, finalStart, finalStart + 10, 1, 0, ease),
  );
  const finalLift = between(
    timelineFrame,
    finalContentStart,
    finalContentStart + 34,
    24,
    0,
    ease,
  );

  // The command centre is the one product surface where the story depends on
  // reading a small amount of dense UI. Keep the browser chrome and editorial
  // copy steady, then move a single image/annotation camera through the two
  // important proof points. Focus rings and the cursor use the same camera
  // coordinates below, so they never drift from the UI they explain.
  const readinessProgress = between(frame, 100, 190, 0, 1, softEase);
  const actionProgress = between(frame, 350, 438, 0, 1, softEase);
  const actionEdgeFade = between(frame, 390, 460, 0, 1, softEase);
  const actionEdgeMatteWidth = mix(0, 360, actionEdgeFade);
  const actionEdgeFeather = mix(0, 10, actionEdgeFade);
  const commandZoom =
    frame < 100
      ? between(frame, 0, 100, 1, 1.08, softEase)
      : frame < 190
        ? between(frame, 100, 190, 1.08, 1.45, softEase)
        : frame < 350
          ? 1.45
          : frame < 438
            ? between(frame, 350, 438, 1.45, 1.48, softEase)
            : frame < 610
              ? 1.48
              : between(frame, 610, 678, 1.48, 1.06, softEase);
  // Keep the readiness pass flush to the browser edge so a zoom never opens
  // a paper-coloured gutter. The action pass can travel left, but is clamped
  // so the enlarged image still covers the browser viewport.
  const readinessPanX = 0;
  const actionPanX = Math.max(
    commandWindowWidth - 1085 * commandZoom,
    548 - 742 * commandZoom,
  );
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
    frame: Math.max(0, timelineFrame - (finalContentStart + 3)),
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
        phases={["80% readiness", "1 critical", "Do this next"]}
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
          80% readiness · 1 critical · ranked next
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
          height={150}
          label="Needs attention"
          opacity={between(frame, 176, 224, 0, 1, ease) * focusOne}
          radius={7}
          scale={commandZoom}
          width={365}
          x={commandPanX + 187 * commandZoom}
          y={commandImageTop + 153 * commandZoom}
        />
        <FocusRing
          color={PALETTE.copper}
          height={125}
          label="Do this next"
          labelPosition="top"
          opacity={focusTwo}
          radius={8}
          scale={commandZoom}
          width={503}
          x={commandPanX + 568 * commandZoom}
          y={commandImageTop + 153 * commandZoom}
        />
        <div
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: `rgba(190,98,66,${0.09 * actionResponse})`,
            border: `2px solid rgba(190,98,66,${0.76 * actionResponse})`,
            borderRadius: 7 * commandZoom,
            boxShadow: `0 0 ${28 * actionResponse}px rgba(190,98,66,.28), inset 0 0 ${18 * actionResponse}px rgba(190,98,66,.12)`,
            display: "flex",
            height: 82 * commandZoom,
            justifyContent: "flex-end",
            left: commandPanX + 576 * commandZoom,
            opacity: actionResponse,
            pointerEvents: "none",
            position: "absolute",
            top: commandImageTop + 181 * commandZoom,
            transform: `scale(${1 - cursorPress * 0.008})`,
            transformOrigin: "center",
            width: 487 * commandZoom,
            zIndex: 2,
          }}
        >
          <span
            style={{
              alignItems: "center",
              background: PALETTE.copper,
              borderRadius: "50%",
              color: PALETTE.paper,
              display: "flex",
              fontSize: 18 * commandZoom,
              fontWeight: 800,
              height: 34 * commandZoom,
              justifyContent: "center",
              marginRight: 14 * commandZoom,
              transform: `translateX(${7 * actionResponse}px) scale(${0.82 + 0.18 * actionResponse})`,
              width: 34 * commandZoom,
            }}
          >
            →
          </span>
        </div>
      </BrowserWindow>

      <Metric
        color={PALETTE.copperSoft}
        label="needs attention"
        opacity={between(frame, 174, 228, 0, 1, ease) * focusOne}
        progress={0.8}
        status="1 critical condition"
        transform={`translateY(${rise(frame, 174, 15, 54)}px)`}
        value="80%"
        x={120}
        y={690}
      />
      <Callout
        body="The signal stays linked to the exact source workflow."
        color={PALETTE.copperSoft}
        eyebrow="01 / readiness"
        opacity={between(frame, 174, 228, 0, 1, ease) * focusOne}
        title="One critical condition."
        transform={`translateY(${rise(frame, 174, 18, 54)}px)`}
        width={390}
        x={120}
        y={842}
      />

      <Callout
        body="Open the affected task with its owner and impact attached."
        color={PALETTE.copperSoft}
        eyebrow="02 / do this next"
        opacity={focusTwo}
        title="Resolve critical work."
        transform={`translateY(${rise(frame, 404, 18, 54)}px)`}
        width={390}
        x={120}
        y={720}
      />
      <div
        style={{
          alignItems: "center",
          background: "rgba(212,167,44,.11)",
          border: "1px solid rgba(212,167,44,.38)",
          borderRadius: 999,
          color: "rgba(255,253,248,.78)",
          display: "flex",
          fontFamily: sans,
          fontSize: 13,
          fontWeight: 720,
          gap: 9,
          left: 120,
          letterSpacing: "0.02em",
          opacity: focusTwo,
          padding: "10px 14px",
          position: "absolute",
          top: 888,
          transform: `translateY(${rise(frame, 422, 14, 48)}px)`,
          zIndex: 5,
        }}
      >
        <span
          style={{
            background: PALETTE.gold,
            borderRadius: "50%",
            height: 7,
            width: 7,
          }}
        />
        Due soon · non-critical 7-day watch
      </div>
      <Cursor
        firstRippleProgress={firstRippleProgress}
        opacity={focusTwo}
        pressProgress={cursorPress}
        scale={0.74 * commandZoom * commandScale}
        secondRippleProgress={secondRippleProgress}
        x={commandCursorX}
        y={commandCursorY}
      />

      <AbsoluteFill
        style={{
          pointerEvents: "none",
        }}
      >
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(circle at 68% 38%, rgba(190,98,66,.08), transparent 31%), linear-gradient(120deg, #091412, #122521)",
            opacity: finalMatte,
          }}
        />
        <div
          style={{
            left: 118,
            opacity: final,
            position: "absolute",
            top: 238,
            transform: `translateY(${finalLift}px)`,
          }}
        >
          <Kicker>Current readiness</Kicker>
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
            80% readiness.
            <br />
            <span style={{ color: PALETTE.copperSoft }}>
              One clear next move.
            </span>
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
            One critical condition ranks first. Due-soon work remains a separate
            seven-day watch.
          </div>
        </div>
        <div
          style={{
            border: "1px solid rgba(255,253,248,.14)",
            borderRadius: 18,
            left: 950,
            opacity: final * cardSpring,
            padding: 25,
            position: "absolute",
            top: 246,
            transform: `translateY(${(1 - cardSpring) * 24}px)`,
            width: 750,
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
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              Do this next · ranked #1
            </span>
            <span
              style={{
                backgroundColor: PALETTE.copper,
                borderRadius: 99,
                color: PALETTE.paper,
                fontSize: 11,
                fontWeight: 800,
                padding: "6px 10px",
              }}
            >
              NEEDS ATTENTION
            </span>
          </div>
          <div
            style={{
              color: PALETTE.paper,
              fontSize: 34,
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
              fontSize: 17,
              lineHeight: 1.45,
              marginTop: 9,
            }}
          >
            Critical tasks incomplete · 1 affected
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
                fontSize: 15,
                fontWeight: 760,
              }}
            >
              Open critical work
            </span>
            <span style={{ color: "rgba(255,253,248,.58)", fontSize: 19 }}>
              →
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 9,
              marginTop: 19,
            }}
          >
            <span
              style={{
                background: "rgba(190,98,66,.17)",
                border: "1px solid rgba(246,197,169,.34)",
                borderRadius: 999,
                color: PALETTE.copperSoft,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.1em",
                padding: "7px 10px",
              }}
            >
              1 CRITICAL CONDITION
            </span>
            <span
              style={{
                background: "rgba(212,167,44,.10)",
                border: "1px solid rgba(212,167,44,.34)",
                borderRadius: 999,
                color: "#f0d67c",
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.1em",
                padding: "7px 10px",
              }}
            >
              DUE SOON · NON-CRITICAL WATCH
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
