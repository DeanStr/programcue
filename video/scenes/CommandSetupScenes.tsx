import type { ReactNode } from "react";

import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";

/**
 * The command and setup chapters intentionally live in one file. They share a
 * visual language, but each still has a clear product story when it is viewed
 * in isolation in the Remotion studio.
 */
export type ProductSceneProps = {
  duration: number;
};

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const sans =
  '"Program Cue Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const softEase = Easing.bezier(0.33, 1, 0.68, 1);

function between(
  frame: number,
  start: number,
  end: number,
  from = 0,
  to = 1,
  easing: (value: number) => number = ease,
) {
  return interpolate(frame, [start, end], [from, to], {
    ...clamp,
    easing,
  });
}

function enter(frame: number, start: number, length = 42) {
  return between(frame, start, start + length, 0, 1, softEase);
}

function fade(
  frame: number,
  start: number,
  end: number,
  outStart?: number,
  outEnd?: number,
) {
  const inOpacity = enter(frame, start, Math.max(1, end - start));
  if (outStart === undefined || outEnd === undefined) return inOpacity;
  return Math.min(inOpacity, between(frame, outStart, outEnd, 1, 0, softEase));
}

function rise(frame: number, start: number, distance = 24, length = 48) {
  return between(frame, start, start + length, distance, 0, softEase);
}

function cssTransform(...parts: Array<string | number>) {
  return parts.join(" ");
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function Kicker({
  children,
  color = PALETTE.copperSoft,
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <div
      style={{
        color,
        fontFamily: sans,
        fontSize: 14,
        fontWeight: 750,
        letterSpacing: "0.18em",
        lineHeight: 1.2,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function GridBackdrop({ light = false }: { light?: boolean }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: light ? PALETTE.editorial : PALETTE.inkDeep,
        backgroundImage: light
          ? "linear-gradient(rgba(24,37,34,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(24,37,34,.045) 1px, transparent 1px), radial-gradient(circle at 90% 6%, rgba(190,98,66,.10), transparent 32%)"
          : "linear-gradient(rgba(255,253,248,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,253,248,.035) 1px, transparent 1px), radial-gradient(circle at 80% 0%, rgba(190,98,66,.20), transparent 34%), radial-gradient(circle at 10% 94%, rgba(58,95,66,.18), transparent 32%)",
        backgroundSize: "64px 64px, 64px 64px, auto, auto",
        pointerEvents: "none",
      }}
    />
  );
}

function Hairline({
  color = "rgba(255,253,248,.16)",
  width = 1,
}: {
  color?: string;
  width?: number;
}) {
  return (
    <div style={{ backgroundColor: color, height: width, width: "100%" }} />
  );
}

function BrowserWindow({
  src,
  alt,
  x,
  y,
  width,
  height,
  imageWidth,
  imageTop = 0,
  imageLeft = 0,
  imageScale = 1,
  radius = 18,
  shadow = true,
  children,
  opacity = 1,
  transform,
}: {
  src: string;
  alt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageTop?: number;
  imageLeft?: number;
  imageScale?: number;
  radius?: number;
  shadow?: boolean;
  children?: ReactNode;
  opacity?: number;
  transform?: string;
}) {
  return (
    <div
      style={{
        backgroundColor: "#fdfcf8",
        border: "1px solid rgba(255,255,255,.38)",
        borderRadius: radius,
        boxShadow: shadow
          ? "0 34px 70px rgba(0,0,0,.34), 0 3px 12px rgba(0,0,0,.22)"
          : undefined,
        height,
        left: x,
        opacity,
        overflow: "hidden",
        position: "absolute",
        top: y,
        transform,
        transformOrigin: "center center",
        width,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(180deg, #fafbf8 0%, #f0f2ee 100%)",
          borderBottom: "1px solid #d9ddd7",
          display: "flex",
          height: 46,
          justifyContent: "space-between",
          padding: "0 18px",
        }}
      >
        <div style={{ display: "flex", gap: 7 }}>
          {(["#e49b85", "#e9c56b", "#8fbf9a"] as const).map((color) => (
            <span
              key={color}
              style={{
                backgroundColor: color,
                borderRadius: "50%",
                height: 9,
                width: 9,
              }}
            />
          ))}
        </div>
        <div
          style={{
            backgroundColor: "#ffffff",
            border: "1px solid #dde2dc",
            borderRadius: 7,
            color: "#71817a",
            fontFamily: sans,
            fontSize: 11,
            letterSpacing: "0.01em",
            overflow: "hidden",
            padding: "7px 52px",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >
          app.programcue.com / Future of Events 2027
        </div>
        <div style={{ color: "#8a9790", fontFamily: sans, fontSize: 14 }}>
          •••
        </div>
      </div>
      <div
        style={{
          bottom: 0,
          left: 0,
          overflow: "hidden",
          position: "absolute",
          right: 0,
          top: 46,
        }}
      >
        <Img
          alt={alt}
          src={src}
          style={{
            display: "block",
            left: imageLeft,
            maxWidth: "none",
            position: "absolute",
            top: imageTop,
            transform: `scale(${imageScale})`,
            transformOrigin: "top left",
            width: imageWidth,
          }}
        />
        {children}
      </div>
    </div>
  );
}

function AdminIdentityBadge() {
  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: "#12211e",
        borderRadius: "0 8px 0 0",
        bottom: 0,
        color: "rgba(255,253,248,.78)",
        display: "flex",
        fontFamily: sans,
        fontSize: 9,
        gap: 7,
        boxSizing: "border-box",
        left: 0,
        padding: "32px 12px 10px",
        position: "absolute",
        width: 160,
        zIndex: 4,
      }}
    >
      <span
        style={{
          backgroundColor: PALETTE.sage,
          borderRadius: "50%",
          height: 6,
          width: 6,
        }}
      />
      Event administrator
    </div>
  );
}

function FocusRing({
  x,
  y,
  width,
  height,
  opacity = 1,
  scale = 1,
  color = PALETTE.copper,
  radius = 10,
  label,
  labelPosition = "top",
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  scale?: number;
  color?: string;
  radius?: number;
  label?: string;
  labelPosition?: "top" | "bottom";
}) {
  return (
    <div
      style={{
        border: `2px solid ${color}`,
        borderRadius: radius,
        boxShadow: `0 0 0 5px ${color}18, 0 0 30px ${color}38`,
        height,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width,
      }}
    >
      {label ? (
        <div
          style={{
            backgroundColor: color,
            borderRadius: 5,
            color: PALETTE.paper,
            fontFamily: sans,
            fontSize: 11,
            fontWeight: 760,
            left: 10,
            letterSpacing: "0.12em",
            padding: "6px 9px",
            position: "absolute",
            textTransform: "uppercase",
            top: labelPosition === "top" ? -32 : height + 10,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
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

function Callout({
  x,
  y,
  width = 300,
  eyebrow,
  title,
  body,
  color = PALETTE.copper,
  opacity = 1,
  transform,
  dark = true,
}: {
  x: number;
  y: number;
  width?: number;
  eyebrow: string;
  title: string;
  body: string;
  color?: string;
  opacity?: number;
  transform?: string;
  dark?: boolean;
}) {
  const fg = dark ? PALETTE.paper : PALETTE.ink;
  const copy = dark ? "rgba(255,253,248,.70)" : PALETTE.muted;
  const eyebrowColor =
    !dark && color === PALETTE.copper ? PALETTE.copperDeep : color;
  return (
    <div
      style={{
        background: dark
          ? "linear-gradient(145deg, rgba(29,47,43,.96), rgba(16,29,27,.92))"
          : "rgba(255,255,255,.88)",
        border: `1px solid ${dark ? "rgba(255,255,255,.14)" : "rgba(24,37,34,.12)"}`,
        borderRadius: 14,
        boxShadow: dark
          ? "0 18px 38px rgba(0,0,0,.25)"
          : "0 14px 30px rgba(24,37,34,.10)",
        color: fg,
        left: x,
        opacity,
        padding: "17px 19px 18px",
        position: "absolute",
        top: y,
        transform,
        width,
        zIndex: 5,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 8,
          marginBottom: 9,
        }}
      >
        <span
          style={{
            backgroundColor: color,
            borderRadius: "50%",
            boxShadow: `0 0 0 4px ${color}22`,
            height: 7,
            width: 7,
          }}
        />
        <span
          style={{
            color: eyebrowColor,
            fontFamily: sans,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </span>
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: 21,
          fontWeight: 740,
          letterSpacing: "-0.03em",
          lineHeight: 1.12,
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: copy,
          fontFamily: sans,
          fontSize: 14,
          lineHeight: 1.42,
          marginTop: 8,
        }}
      >
        {body}
      </div>
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

function PhaseRail({
  phases,
  active,
  light = false,
  opacity = 1,
}: {
  phases: string[];
  active: number;
  light?: boolean;
  opacity?: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 12,
        opacity,
        position: "absolute",
        right: 74,
        top: 52,
        zIndex: 10,
      }}
    >
      {phases.map((phase, index) => {
        const selected = index === active;
        return (
          <div
            key={phase}
            style={{ alignItems: "center", display: "flex", gap: 7 }}
          >
            <span
              style={{
                backgroundColor: selected
                  ? light
                    ? PALETTE.copper
                    : PALETTE.copperSoft
                  : light
                    ? "#b7c1bb"
                    : "rgba(255,253,248,.28)",
                borderRadius: "50%",
                boxShadow: selected
                  ? `0 0 0 4px ${light ? PALETTE.copper : PALETTE.copperSoft}25`
                  : undefined,
                height: selected ? 8 : 5,
                width: selected ? 8 : 5,
              }}
            />
            <span
              style={{
                color: selected
                  ? light
                    ? PALETTE.ink
                    : PALETTE.paper
                  : light
                    ? PALETTE.muted
                    : "rgba(255,253,248,.45)",
                fontFamily: sans,
                fontSize: 10,
                fontWeight: selected ? 800 : 650,
                letterSpacing: "0.11em",
                textTransform: "uppercase",
              }}
            >
              {phase}
            </span>
            {index < phases.length - 1 ? (
              <span
                style={{
                  backgroundColor: light ? "#d4d9d3" : "rgba(255,253,248,.18)",
                  height: 1,
                  marginLeft: 3,
                  width: 22,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SegmentLabel({
  number,
  title,
  light = false,
  opacity = 1,
  x = 80,
  y = 54,
}: {
  number: string;
  title: string;
  light?: boolean;
  opacity?: number;
  x?: number;
  y?: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        color: light ? PALETTE.muted : "rgba(255,253,248,.58)",
        display: "flex",
        fontFamily: sans,
        fontSize: 12,
        fontWeight: 720,
        gap: 12,
        left: x,
        letterSpacing: "0.12em",
        opacity,
        position: "absolute",
        textTransform: "uppercase",
        top: y,
        zIndex: 10,
      }}
    >
      <ProgramCueMark
        accent={PALETTE.copper}
        ink={light ? PALETTE.ink : PALETTE.paper}
        size={28}
      />
      <span
        style={{
          color: light ? PALETTE.ink : PALETTE.paper,
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}
      >
        Program Cue
      </span>
      <span
        style={{
          backgroundColor: light ? "#cbd2cb" : "rgba(255,253,248,.2)",
          height: 18,
          width: 1,
        }}
      />
      <span
        style={{
          color: light ? PALETTE.copperDeep : PALETTE.copperSoft,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {number}
      </span>
      <span
        style={{
          backgroundColor: light ? "#cbd2cb" : "rgba(255,253,248,.2)",
          height: 1,
          width: 38,
        }}
      />
      <span>{title}</span>
    </div>
  );
}

function CommandScene({ duration }: ProductSceneProps) {
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

function FlowArrow({
  opacity = 1,
  x,
  y,
}: {
  opacity?: number;
  x: number;
  y: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        color: PALETTE.copper,
        display: "flex",
        gap: 8,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        zIndex: 9,
      }}
    >
      <span style={{ backgroundColor: PALETTE.copper, height: 2, width: 34 }} />
      <span
        style={{
          borderBottom: `2px solid ${PALETTE.copper}`,
          borderRight: `2px solid ${PALETTE.copper}`,
          height: 8,
          transform: "rotate(-45deg)",
          width: 8,
        }}
      />
    </div>
  );
}

function PhonePreview({
  frame,
  start,
  opacity = 1,
}: {
  frame: number;
  start: number;
  opacity?: number;
}) {
  const inValue = enter(frame, start, 65);
  const y = rise(frame, start, 46, 65);
  return (
    <div
      style={{
        border: "7px solid #162622",
        borderRadius: 27,
        boxShadow:
          "0 24px 48px rgba(24,37,34,.20), 0 1px 4px rgba(24,37,34,.25)",
        height: 590,
        left: 1510,
        opacity: opacity * inValue,
        overflow: "hidden",
        position: "absolute",
        top: 250,
        transform: `translateY(${y}px) rotate(2deg)`,
        transformOrigin: "center bottom",
        width: 310,
        zIndex: 6,
      }}
    >
      <div
        style={{
          background: PALETTE.ink,
          height: 21,
          left: "50%",
          position: "absolute",
          top: 0,
          transform: "translateX(-50%)",
          width: 92,
          zIndex: 2,
        }}
      />
      <Img
        alt="Mobile published programme preview"
        src={ASSETS.brandingMobile}
        style={{
          display: "block",
          height: "100%",
          objectFit: "cover",
          objectPosition: "top center",
          width: "100%",
        }}
      />
      <div
        style={{
          background:
            "linear-gradient(180deg, transparent 56%, rgba(8,18,16,.28))",
          inset: 0,
          position: "absolute",
        }}
      />
    </div>
  );
}

function SetupScene({ duration }: ProductSceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 750;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const { fps } = useVideoConfig();
  const sceneFade = fade(
    frame,
    -24,
    36,
    Math.max(0, sourceDuration - 80),
    sourceDuration,
  );
  const intro = fade(frame, -24, 36, 372, 420);
  const identity = fade(frame, -18, 34, 310, 344);
  const dataCard = fade(frame, 300, 344, 474, 516);
  const brand = fade(frame, 430, 484, 644, 692);
  const brandWindowY = between(frame, 432, 510, 70, 0, ease);
  const identityWindowScale = between(frame, 0, 340, 0.965, 1.012, softEase);
  const setupX = between(frame, 0, 460, 205, 130, ease);
  const setupWidth = between(frame, 0, 460, 1050, 985, ease);
  const publicIdentityPan =
    between(frame, 70, 110, 0, 1, ease) * between(frame, 184, 212, 1, 0, ease);
  const dataSlide = between(frame, 294, 362, 90, 0, ease);
  const brandSpring = spring({
    fps,
    frame: Math.max(0, frame - 442),
    config: { damping: 17, stiffness: 110, mass: 0.72 },
  });
  const final = fade(frame, 646, 696);

  return (
    <AbsoluteFill
      style={{ color: PALETTE.ink, fontFamily: sans, overflow: "hidden" }}
    >
      <GridBackdrop light />
      <SegmentLabel
        light
        number="04 / 13"
        opacity={sceneFade}
        title="Event setup"
      />
      <PhaseRail
        active={frame > 430 ? 2 : frame > 278 ? 1 : 0}
        light
        opacity={sceneFade}
        phases={["Set the foundation", "Choose the source", "Go public"]}
      />

      <div
        style={{
          left: 80,
          opacity: intro,
          position: "absolute",
          top: 174,
          transform: `translateY(${rise(frame, 12, 26, 62)}px)`,
          width: 480,
          zIndex: 3,
        }}
      >
        <Kicker color={PALETTE.copperDeep}>Event configuration</Kicker>
        <h1
          style={{
            color: PALETTE.ink,
            fontFamily: sans,
            fontSize: 68,
            fontWeight: 760,
            letterSpacing: "-0.07em",
            lineHeight: 0.99,
            margin: "20px 0 0",
            maxWidth: 470,
          }}
        >
          Set the event once.
          <br />
          <span style={{ color: PALETTE.copper }}>Use it everywhere.</span>
        </h1>
        <p
          style={{
            color: PALETTE.muted,
            fontSize: 20,
            lineHeight: 1.46,
            margin: "25px 0 0",
            maxWidth: 430,
          }}
        >
          Define the event foundation once, then reuse it across every
          participant experience.
        </p>
        <div
          style={{
            alignItems: "center",
            color: PALETTE.muted,
            display: "flex",
            fontSize: 12,
            fontWeight: 760,
            gap: 10,
            letterSpacing: "0.1em",
            marginTop: 47,
            textTransform: "uppercase",
          }}
        >
          <span
            style={{
              border: `1px solid ${PALETTE.copper}`,
              borderRadius: "50%",
              height: 18,
              position: "relative",
              width: 18,
            }}
          >
            <span
              style={{
                background: PALETTE.copper,
                borderRadius: "50%",
                height: 5,
                left: 5,
                position: "absolute",
                top: 5,
                width: 5,
              }}
            />
          </span>
          One event foundation
        </div>
      </div>

      <BrowserWindow
        alt="Program Cue event settings identity screen"
        height={670}
        imageTop={-6 - 50 * publicIdentityPan}
        imageWidth={985}
        opacity={identity}
        radius={17}
        src={ASSETS.eventSetup}
        transform={`translate(${setupX}px, ${between(frame, 0, 360, 72, 0, ease)}px) scale(${identityWindowScale})`}
        width={setupWidth}
        x={700}
        y={260}
      >
        <AdminIdentityBadge />
        <FocusRing
          color={PALETTE.sageDeep}
          height={141}
          opacity={
            between(frame, 88, 126, 0, 1, ease) *
            between(frame, 188, 212, 1, 0, ease) *
            identity
          }
          radius={7}
          width={779}
          x={181}
          y={519 - 50 * publicIdentityPan}
        />
      </BrowserWindow>

      <BrowserWindow
        alt="Program Cue event data and retention settings"
        height={650}
        imageTop={-4}
        imageWidth={1015}
        opacity={dataCard}
        radius={17}
        src={ASSETS.eventSetupData}
        transform={`translate(${between(frame, 300, 370, 72, 0, ease)}px, ${between(frame, 300, 380, 48, 0, ease)}px) scale(${between(frame, 300, 410, 0.96, 1, softEase)})`}
        width={1030}
        x={704}
        y={266}
      >
        <AdminIdentityBadge />
        <FocusRing
          color={PALETTE.copper}
          height={295}
          label="Data source & retention"
          opacity={between(frame, 326, 368, 0, 1, ease)}
          radius={9}
          width={485}
          x={510}
          y={250}
        />
      </BrowserWindow>

      <Callout
        body="Set dates, venue, timezone and the public slug before publication."
        color={PALETTE.copper}
        eyebrow="01 / model the event"
        opacity={identity}
        title="Configure public identity."
        transform={`translateY(${rise(frame, 78, 19, 56)}px)`}
        width={365}
        x={90}
        y={730}
        dark={false}
      />
      <div
        style={{
          color: PALETTE.muted,
          fontFamily: sans,
          fontSize: 13,
          left: 90,
          opacity: identity,
          position: "absolute",
          top: 934,
          width: 430,
          zIndex: 4,
        }}
      >
        <Hairline color="#cbd2cb" />
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 9,
            marginTop: 14,
          }}
        >
          <span
            style={{
              background: PALETTE.sageDeep,
              borderRadius: "50%",
              height: 7,
              width: 7,
            }}
          />{" "}
          Participant-facing surfaces reuse these settings.
        </div>
      </div>

      <div
        style={{
          backgroundColor: "rgba(255,255,255,.9)",
          border: "1px solid #d8ddd6",
          borderRadius: 15,
          boxShadow: "0 20px 45px rgba(24,37,34,.12)",
          left: 90,
          opacity: dataCard,
          padding: "20px 22px",
          position: "absolute",
          top: 575,
          transform: `translateY(${dataSlide}px)`,
          width: 460,
          zIndex: 8,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: PALETTE.ink, fontSize: 16, fontWeight: 760 }}>
            Data and files
          </span>
          <span
            style={{
              alignItems: "center",
              color: PALETTE.copperDeep,
              display: "flex",
              fontSize: 10,
              fontWeight: 800,
              gap: 6,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                background: PALETTE.copper,
                borderRadius: "50%",
                height: 6,
                width: 6,
              }}
            />{" "}
            Source selected
          </span>
        </div>
        <div
          style={{
            color: PALETTE.muted,
            fontSize: 13,
            lineHeight: 1.4,
            marginTop: 8,
          }}
        >
          Choose Program Cue or Airtable for event data, with clear file and
          retention policies.
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 18 }}>
          {["Private files", "Source selected", "24 months"].map(
            (item, index) => (
              <div
                key={item}
                style={{
                  background: index === 1 ? "#f4e4db" : "#f2f4f0",
                  borderRadius: 6,
                  color: index === 1 ? PALETTE.copperDeep : PALETTE.muted,
                  fontSize: 11,
                  fontWeight: 740,
                  padding: "7px 9px",
                }}
              >
                {item}
              </div>
            ),
          )}
        </div>
      </div>
      <AbsoluteFill
        style={{
          background: PALETTE.editorial,
          opacity: brand,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background:
              "radial-gradient(circle at 81% 23%, rgba(190,98,66,.12), transparent 35%)",
            inset: 0,
            position: "absolute",
          }}
        />
        <div
          style={{
            left: 95,
            position: "absolute",
            top: 182,
            transform: `translateY(${between(frame, 430, 500, 34, 0, ease)}px)`,
            width: 445,
          }}
        >
          <Kicker color={PALETTE.copperDeep}>Public identity</Kicker>
          <div
            style={{
              color: PALETTE.ink,
              fontFamily: sans,
              fontSize: 59,
              fontWeight: 760,
              letterSpacing: "-0.068em",
              lineHeight: 1.01,
              marginTop: 20,
            }}
          >
            Make every touchpoint
            <br />
            <span style={{ color: PALETTE.copper }}>feel like your event.</span>
          </div>
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 18,
              lineHeight: 1.45,
              marginTop: 22,
              width: 390,
            }}
          >
            Fine-tune in preview. Publish when the experience feels right.
          </div>
        </div>
        <BrowserWindow
          alt="Program Cue branding editor and published programme preview"
          height={680}
          imageTop={brandWindowY - 3}
          imageWidth={1035}
          opacity={brandSpring}
          radius={17}
          src={ASSETS.branding}
          transform={`translateY(${between(frame, 432, 506, 90, 0, ease)}px) scale(${between(frame, 432, 600, 0.95, 1, softEase)})`}
          width={1060}
          x={580}
          y={236}
        >
          <AdminIdentityBadge />
          <FocusRing
            color={PALETTE.copper}
            height={78}
            label="Draft preview"
            opacity={
              between(frame, 496, 545, 0, 1, ease) *
              between(frame, 552, 578, 1, 0, ease)
            }
            radius={7}
            width={515}
            x={500}
            y={165}
          />
          <FocusRing
            color={PALETTE.sageDeep}
            height={42}
            opacity={between(frame, 564, 610, 0, 1, ease)}
            radius={7}
            width={120}
            x={895}
            y={573}
          />
        </BrowserWindow>
        <PhonePreview frame={frame} opacity={brand} start={515} />
        <FlowArrow
          opacity={
            between(frame, 510, 550, 0, 1, ease) *
            between(frame, 552, 578, 1, 0, ease)
          }
          x={1324}
          y={520}
        />
        <div
          style={{
            backgroundColor: "rgba(255,255,255,.93)",
            border: "1px solid #d8ddd6",
            borderRadius: 13,
            bottom: 72,
            boxShadow: "0 14px 34px rgba(24,37,34,.10)",
            left: 95,
            opacity: between(frame, 520, 568, 0, 1, ease),
            padding: "16px 19px",
            position: "absolute",
            width: 416,
            zIndex: 10,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <span
              style={{
                background: PALETTE.sageDeep,
                borderRadius: "50%",
                height: 8,
                width: 8,
              }}
            />
            <span style={{ color: PALETTE.ink, fontSize: 15, fontWeight: 760 }}>
              Draft → preview → publish
            </span>
          </div>
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 12,
              lineHeight: 1.4,
              marginTop: 8,
            }}
          >
            Shape the brand once, then carry it across every public touchpoint.
          </div>
        </div>
        <div
          style={{
            bottom: 72,
            color: PALETTE.muted,
            fontFamily: sans,
            fontSize: 12,
            left: 1550,
            opacity: between(frame, 560, 610, 0, 1, ease),
            position: "absolute",
            width: 278,
            zIndex: 10,
          }}
        >
          <Hairline color="#cbd2cb" />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              lineHeight: 1.4,
              marginTop: 12,
            }}
          >
            <span style={{ color: PALETTE.copper, fontSize: 16 }}>↗</span> One
            saved identity flows from preview to the public programme.
          </div>
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: "linear-gradient(120deg, #12231f, #0d1917)",
          opacity: final,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            left: 120,
            position: "absolute",
            top: 245,
            transform: `translateY(${between(frame, 632, 704, 28, 0, ease)}px)`,
          }}
        >
          <Kicker>Ready to publish</Kicker>
          <div
            style={{
              color: PALETTE.paper,
              fontFamily: sans,
              fontSize: 67,
              fontWeight: 760,
              letterSpacing: "-0.07em",
              lineHeight: 1,
              marginTop: 23,
            }}
          >
            Reuse event settings
            <br />
            <span style={{ color: PALETTE.copperSoft }}>
              across programme workflows.
            </span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 20,
              lineHeight: 1.42,
              marginTop: 26,
              maxWidth: 470,
            }}
          >
            Event settings apply across forms, participant workspaces and the
            public programme.
          </div>
        </div>
        <div
          style={{
            border: "1px solid rgba(255,253,248,.14)",
            borderRadius: 18,
            left: 1060,
            opacity: brandSpring,
            padding: 24,
            position: "absolute",
            top: 272,
            transform: `translateY(${(1 - brandSpring) * 30}px)`,
            width: 610,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <span
              style={{
                background: PALETTE.sage,
                borderRadius: "50%",
                height: 8,
                width: 8,
              }}
            />
            <span
              style={{
                color: PALETTE.paper,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              }}
            >
              Ready to publish
            </span>
          </div>
          <div
            style={{
              color: PALETTE.paper,
              fontSize: 29,
              fontWeight: 730,
              letterSpacing: "-0.04em",
              marginTop: 25,
            }}
          >
            One identity. Every public touchpoint.
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 15,
              lineHeight: 1.45,
              marginTop: 9,
            }}
          >
            Review once, then bring the complete event identity to life.
          </div>
          <Hairline />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginTop: 18,
            }}
          >
            <span
              style={{
                color: PALETTE.copperSoft,
                fontSize: 13,
                fontWeight: 760,
              }}
            >
              Continue to application setup
            </span>
            <span style={{ color: "rgba(255,253,248,.58)", fontSize: 20 }}>
              →
            </span>
          </div>
        </div>
        <div
          style={{ bottom: 54, left: 120, position: "absolute", right: 120 }}
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
            Program Cue · Event foundations
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export { CommandScene, SetupScene };
