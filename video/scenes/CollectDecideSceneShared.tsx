import type { CSSProperties } from "react";

import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE } from "../constants";

export type SceneProps = { duration: number };

export type StageProps = {
  start: number;
  end: number;
  feather?: number;
  visibleFrom?: number;
  visibleUntil?: number;
  children: React.ReactNode;
};

export type ShotProps = {
  src: string;
  label: string;
  caption?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  objectPosition?: string;
  objectFit?: "cover" | "contain";
  holdToEnd?: boolean;
  children?: React.ReactNode;
  tone?: "light" | "dark";
};

export const ease = Easing.bezier(0.16, 1, 0.3, 1);

export const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export const fade = (
  frame: number,
  start: number,
  end: number,
  feather = 34,
) => {
  const span = Math.max(4, end - start);
  const edge = Math.max(1, Math.min(feather, Math.floor((span - 2) / 2)));
  return interpolate(
    frame,
    [start, start + edge, end - edge, end],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
  );
};

export const reveal = (frame: number, start: number, length = 34) =>
  interpolate(frame, [start, start + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

export const pop = (frame: number, start: number, fps: number) =>
  spring({
    fps,
    frame: Math.max(0, frame - start),
    config: { damping: 20, mass: 0.72, stiffness: 140 },
  });

export const baseText: CSSProperties = {
  fontFamily:
    '"Program Cue Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

export const panelShadow =
  "0 30px 90px rgba(0, 0, 0, .38), 0 8px 24px rgba(0, 0, 0, .22)";

export const hairline = "rgba(255,255,255,.14)";

export function Stage({
  start,
  end,
  feather,
  visibleFrom,
  visibleUntil,
  children,
}: StageProps) {
  const frame = useCurrentFrame();
  const span = Math.max(4, end - start);
  const edge = Math.max(1, Math.min(45, Math.floor((span - 2) / 2)));
  const fadeEdge = Math.max(
    1,
    Math.min(feather ?? 34, Math.floor((span - 2) / 2)),
  );
  const enterOpacity =
    visibleFrom === undefined
      ? interpolate(frame, [start, start + fadeEdge], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        })
      : frame >= visibleFrom
        ? 1
        : 0;
  const exitOpacity =
    visibleUntil === undefined
      ? interpolate(frame, [end - fadeEdge, end], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        })
      : frame < visibleUntil
        ? 1
        : 0;
  const opacity = Math.min(enterOpacity, exitOpacity);
  const lift = interpolate(
    frame,
    [start, start + edge, end - edge, end],
    [24, 0, 0, -20],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    },
  );
  const scale = interpolate(
    frame,
    [start, start + Math.max(1, Math.min(50, span - 1)), end],
    [0.985, 1, 1.01],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    },
  );

  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `translate3d(0, ${lift}px, 0) scale(${scale})`,
        transformOrigin: "50% 50%",
        pointerEvents: "none",
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

export function DotGrid({ tint = "rgba(255,255,255,.06)" }: { tint?: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: 0.52,
        backgroundImage: `linear-gradient(${tint} 1px, transparent 1px), linear-gradient(90deg, ${tint} 1px, transparent 1px)`,
        backgroundSize: "72px 72px",
        maskImage: "linear-gradient(to bottom, black, transparent 78%)",
      }}
    />
  );
}

export function Grain() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: 0.1,
        mixBlendMode: "screen",
        backgroundImage:
          "radial-gradient(circle at 20% 30%, rgba(255,255,255,.6) 0 1px, transparent 1.4px), radial-gradient(circle at 75% 60%, rgba(255,255,255,.4) 0 1px, transparent 1.3px)",
        backgroundSize: "23px 19px, 31px 27px",
        pointerEvents: "none",
      }}
    />
  );
}

export function TopBar({
  section,
  chapter,
  step,
}: {
  section: string;
  chapter: string;
  step: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 88,
        padding: "0 108px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: `1px solid ${hairline}`,
        color: "rgba(255,255,255,.78)",
        ...baseText,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <ProgramCueMark size={32} />
        <div
          style={{
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "-.02em",
            color: PALETTE.paper,
          }}
        >
          Program Cue
        </div>
        <div
          style={{
            width: 1,
            height: 22,
            background: hairline,
            margin: "0 3px",
          }}
        />
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: ".06em",
            textTransform: "uppercase",
          }}
        >
          {section}
        </div>
      </div>
      <div
        style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 13 }}
      >
        <span style={{ color: "rgba(255,255,255,.48)" }}>{chapter}</span>
        <span
          style={{
            color: PALETTE.copperSoft,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
          }}
        >
          {step}
        </span>
      </div>
    </div>
  );
}

export function Footer({
  label,
  progress,
  right,
}: {
  label: string;
  progress: number;
  right: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 108,
        right: 108,
        bottom: 40,
        display: "flex",
        alignItems: "center",
        gap: 18,
        color: "rgba(255,255,255,.56)",
        fontSize: 12,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        ...baseText,
      }}
    >
      <span style={{ color: PALETTE.copperSoft, fontWeight: 700 }}>
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 2,
          borderRadius: 2,
          background: "rgba(255,255,255,.15)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${clamp(progress) * 100}%`,
            height: "100%",
            background: PALETTE.copper,
          }}
        />
      </div>
      <span>{right}</span>
    </div>
  );
}

export function RolePill({
  label,
  color = PALETTE.copperSoft,
}: {
  label: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        border: `1px solid ${color}55`,
        borderRadius: 999,
        color,
        background: `${color}10`,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        ...baseText,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 14px ${color}`,
        }}
      />
      {label}
    </div>
  );
}

export function Headline({
  eyebrow,
  title,
  body,
  accent = PALETTE.copperSoft,
}: {
  eyebrow: string;
  title: string;
  body: string;
  accent?: string;
}) {
  return (
    <div style={{ width: 620, ...baseText }}>
      <div
        style={{
          color: accent,
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          marginBottom: 23,
        }}
      >
        {eyebrow}
      </div>
      <h2
        style={{
          margin: 0,
          color: PALETTE.paper,
          fontSize: 66,
          lineHeight: 0.99,
          letterSpacing: "-.065em",
          fontWeight: 720,
          whiteSpace: "pre-line",
        }}
      >
        {title}
      </h2>
      <p
        style={{
          margin: "28px 0 0",
          color: "rgba(255,255,255,.66)",
          fontSize: 20,
          lineHeight: 1.42,
          letterSpacing: "-.015em",
          maxWidth: 560,
        }}
      >
        {body}
      </p>
    </div>
  );
}

export function Line({
  width = 88,
  color = PALETTE.copper,
}: {
  width?: number;
  color?: string;
}) {
  return (
    <div
      style={{
        width,
        height: 3,
        borderRadius: 3,
        background: color,
        boxShadow: `0 0 20px ${color}66`,
      }}
    />
  );
}

export function BrowserShot({
  src,
  label,
  caption,
  x,
  y,
  width,
  height,
  start,
  end,
  objectPosition = "50% 50%",
  objectFit = "cover",
  holdToEnd = false,
  children,
  tone = "light",
}: ShotProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = holdToEnd
    ? reveal(frame, start, 38)
    : fade(frame, start, end, 38);
  const mounted = pop(frame, start, fps);
  const yShift = interpolate(mounted, [0, 1], [28, 0]);
  const rotate = interpolate(mounted, [0, 1], [0.9, 0]);
  const border =
    tone === "light" ? "rgba(255,255,255,.34)" : "rgba(255,255,255,.16)";

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        opacity,
        transform: `translate3d(0, ${yShift}px, 0) rotate(${rotate}deg)`,
        transformOrigin: "50% 80%",
        borderRadius: 18,
        overflow: "hidden",
        background: tone === "light" ? "#f8f7f2" : PALETTE.nav,
        border: `1px solid ${border}`,
        boxShadow: panelShadow,
        ...baseText,
      }}
    >
      <div
        style={{
          height: 34,
          padding: "0 13px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: tone === "light" ? "#eeede8" : "#172522",
          borderBottom: `1px solid ${tone === "light" ? "#d6d5cf" : hairline}`,
        }}
      >
        <span style={{ display: "flex", gap: 5 }}>
          {[PALETTE.copper, PALETTE.gold, PALETTE.sage].map((color) => (
            <i
              key={color}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                opacity: 0.9,
              }}
            />
          ))}
        </span>
        <span
          style={{
            marginLeft: 4,
            color: tone === "light" ? "#69746f" : "rgba(255,255,255,.6)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".08em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span
          style={{
            marginLeft: "auto",
            color: tone === "light" ? "#8a918c" : "rgba(255,255,255,.4)",
            fontSize: 10,
          }}
        >
          app.programcue.com
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: height - 34,
          overflow: "hidden",
        }}
      >
        <Img
          src={src}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit,
            objectPosition,
            display: "block",
          }}
        />
        {children}
      </div>
      {caption ? (
        <div
          style={{
            position: "absolute",
            left: 18,
            bottom: 14,
            padding: "7px 10px",
            borderRadius: 7,
            background: "rgba(11,20,19,.86)",
            color: PALETTE.paper,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".02em",
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}

export function Check({
  children,
  color = PALETTE.sage,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        color: "rgba(255,255,255,.7)",
        fontSize: 13,
        lineHeight: 1.35,
        ...baseText,
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 19,
          height: 19,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          marginTop: 1,
          background: `${color}1f`,
          color,
          border: `1px solid ${color}66`,
          fontSize: 11,
          fontWeight: 900,
        }}
      >
        ✓
      </span>
      <span>{children}</span>
    </div>
  );
}

export function FlowRail({
  items,
  active,
}: {
  items: string[];
  active: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 108,
        top: 125,
        display: "flex",
        alignItems: "center",
        gap: 11,
        ...baseText,
      }}
    >
      {items.map((item, index) => (
        <div
          key={item}
          style={{ display: "flex", alignItems: "center", gap: 11 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: index <= active ? PALETTE.paper : "rgba(255,255,255,.34)",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  index <= active ? PALETTE.copper : "rgba(255,255,255,.25)",
                boxShadow:
                  index === active ? `0 0 0 5px ${PALETTE.copper}22` : "none",
              }}
            />
            {item}
          </div>
          {index < items.length - 1 ? (
            <span
              style={{
                width: 34,
                height: 1,
                background: index < active ? `${PALETTE.copper}99` : hairline,
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function SceneBackdrop({ mode }: { mode: "collect" | "decide" }) {
  const accent = mode === "collect" ? PALETTE.copper : PALETTE.sage;
  return (
    <>
      <DotGrid tint={`${accent}18`} />
      <div
        style={{
          position: "absolute",
          width: 860,
          height: 860,
          left: mode === "collect" ? -280 : 1240,
          top: -260,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accent}22 0%, transparent 69%)`,
          filter: "blur(10px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 700,
          height: 700,
          right: mode === "collect" ? -250 : 1100,
          bottom: -410,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${mode === "collect" ? PALETTE.sage : PALETTE.copper}15 0%, transparent 70%)`,
          filter: "blur(12px)",
        }}
      />
    </>
  );
}

export function EndCard({
  start,
  end,
  mode,
}: {
  start: number;
  end: number;
  mode: "collect" | "decide";
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  const collect = mode === "collect";
  return (
    <Stage start={start} end={end}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          ...baseText,
        }}
      >
        <div
          style={{
            transform: `translateY(${interpolate(p, [0, 1], [22, 0])}px)`,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              color: collect ? PALETTE.copperSoft : PALETTE.sage,
              fontSize: 12,
              fontWeight: 900,
              letterSpacing: ".15em",
              textTransform: "uppercase",
            }}
          >
            <Line width={42} color={collect ? PALETTE.copper : PALETTE.sage} />
            <span>
              {collect ? "Ready for review" : "Your programme, your call"}
            </span>
            <Line width={42} color={collect ? PALETTE.copper : PALETTE.sage} />
          </div>
          <h2
            style={{
              margin: "27px 0 0",
              color: PALETTE.paper,
              fontSize: 70,
              lineHeight: 0.96,
              letterSpacing: "-.07em",
              fontWeight: 730,
            }}
          >
            {collect ? (
              <>
                From application
                <br />
                <span style={{ color: PALETTE.copperSoft }}>
                  to confident decision.
                </span>
              </>
            ) : (
              <>
                Evidence in view.
                <br />
                <span style={{ color: PALETTE.sage }}>
                  Your team in control.
                </span>
              </>
            )}
          </h2>
          <p
            style={{
              margin: "26px auto 0",
              maxWidth: 590,
              color: "rgba(255,255,255,.57)",
              fontSize: 18,
              lineHeight: 1.42,
            }}
          >
            {collect
              ? "Every submission, version and review stays connected from start to finish."
              : "AI focuses the evidence. Reviewers recommend. Organisers decide."}
          </p>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 163,
          width: 2,
          height: 62,
          transform: "translateX(-50%)",
          background: `linear-gradient(${collect ? PALETTE.copper : PALETTE.sage}, transparent)`,
        }}
      />
    </Stage>
  );
}
