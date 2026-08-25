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

import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";

export type SceneProps = { duration: number };

type StageProps = {
  start: number;
  end: number;
  feather?: number;
  visibleFrom?: number;
  visibleUntil?: number;
  children: React.ReactNode;
};

type TimedStageProps = Pick<
  StageProps,
  "start" | "end" | "visibleFrom" | "visibleUntil"
>;

type ShotProps = {
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

const ease = Easing.bezier(0.16, 1, 0.3, 1);

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const fade = (frame: number, start: number, end: number, feather = 34) => {
  const span = Math.max(4, end - start);
  const edge = Math.max(1, Math.min(feather, Math.floor((span - 2) / 2)));
  return interpolate(
    frame,
    [start, start + edge, end - edge, end],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
  );
};

const reveal = (frame: number, start: number, length = 34) =>
  interpolate(frame, [start, start + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

const pop = (frame: number, start: number, fps: number) =>
  spring({
    fps,
    frame: Math.max(0, frame - start),
    config: { damping: 20, mass: 0.72, stiffness: 140 },
  });

const baseText: CSSProperties = {
  fontFamily:
    '"Program Cue Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

const panelShadow =
  "0 30px 90px rgba(0, 0, 0, .38), 0 8px 24px rgba(0, 0, 0, .22)";

const hairline = "rgba(255,255,255,.14)";

function Stage({
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

function DotGrid({ tint = "rgba(255,255,255,.06)" }: { tint?: string }) {
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

function Grain() {
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

function TopBar({
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

function Footer({
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

function RolePill({
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

function Headline({
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

function Line({
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

function MetaRow({
  label,
  value,
  accent = PALETTE.paper,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 24,
        padding: "12px 0",
        borderBottom: `1px solid ${hairline}`,
        ...baseText,
      }}
    >
      <span style={{ color: "rgba(255,255,255,.44)", fontSize: 12 }}>
        {label}
      </span>
      <span
        style={{
          color: accent,
          fontSize: 12,
          fontWeight: 700,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function InfoCard({
  title,
  body,
  icon,
  accent = PALETTE.copperSoft,
  width = 270,
}: {
  title: string;
  body: string;
  icon: string;
  accent?: string;
  width?: number;
}) {
  return (
    <div
      style={{
        width,
        padding: "17px 18px 18px",
        border: `1px solid ${accent}44`,
        background: "rgba(12, 25, 23, .84)",
        borderRadius: 14,
        boxShadow: "0 16px 30px rgba(0,0,0,.18)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            background: `${accent}18`,
            color: accent,
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, color: PALETTE.paper }}>
          {title}
        </span>
      </div>
      <div
        style={{
          color: "rgba(255,255,255,.56)",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function BrowserShot({
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

function AdminIdentityOverlay() {
  return (
    <div
      style={{
        alignItems: "center",
        background: "#11201d",
        borderRadius: 7,
        bottom: 42,
        color: "rgba(255,253,248,.8)",
        display: "flex",
        fontSize: 9,
        gap: 7,
        left: 10,
        padding: "7px 9px",
        position: "absolute",
        zIndex: 4,
      }}
    >
      <span
        style={{
          background: PALETTE.sage,
          borderRadius: "50%",
          height: 6,
          width: 6,
        }}
      />
      Event administrator
    </div>
  );
}

function ReviewEvidenceState({
  compact = false,
  showSuggestions = false,
  style,
}: {
  compact?: boolean;
  showSuggestions?: boolean;
  style: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #f7fbf7, #ffffff)",
        border: "1px solid rgba(58,95,66,.24)",
        borderRadius: compact ? 7 : 10,
        boxShadow: "0 8px 22px rgba(24,37,34,.07)",
        boxSizing: "border-box",
        color: PALETTE.ink,
        overflow: "hidden",
        padding: compact ? "8px 10px" : "12px 14px",
        position: "absolute",
        zIndex: 3,
        ...style,
      }}
    >
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: compact ? 7 : 10,
          fontWeight: 850,
          letterSpacing: ".08em",
          textTransform: "uppercase",
        }}
      >
        Evidence assistant ready
      </div>
      <div
        style={{
          fontSize: compact ? 8 : 11,
          fontWeight: 760,
          lineHeight: 1.35,
          marginTop: compact ? 5 : 7,
        }}
      >
        Cited suggestions bring the strongest source evidence into focus.
      </div>
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: compact ? 7 : 9,
          fontWeight: 760,
          marginTop: compact ? 5 : 7,
        }}
      >
        Source linked · reviewer decides
      </div>
      {showSuggestions ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {["Audience relevance · 4", "Practical value · 5"].map((item) => (
            <span
              key={item}
              style={{
                background: "rgba(143,191,154,.13)",
                border: "1px solid rgba(58,95,66,.18)",
                borderRadius: 999,
                color: PALETTE.sageDeep,
                fontSize: 8,
                fontWeight: 760,
                padding: "4px 7px",
              }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PhoneShot({
  src,
  label,
  x,
  y,
  width,
  height,
  start,
  end,
  objectPosition = "50% 12%",
  holdToEnd = false,
  children,
}: ShotProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = holdToEnd
    ? reveal(frame, start, 34)
    : fade(frame, start, end, 34);
  const mounted = pop(frame, start + 8, fps);
  const yShift = interpolate(mounted, [0, 1], [46, 0]);
  const rotate = interpolate(mounted, [0, 1], [2.8, -1.2]);

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
        transformOrigin: "50% 90%",
        filter: "drop-shadow(0 30px 32px rgba(0,0,0,.38))",
        ...baseText,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: 10,
          borderRadius: 35,
          background: "linear-gradient(145deg,#304843,#101918 70%)",
          border: "1px solid rgba(255,255,255,.24)",
          boxShadow: "inset 0 0 0 2px rgba(255,255,255,.05)",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            borderRadius: 27,
            background: "#f5f4ef",
          }}
        >
          <Img
            src={src}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              objectFit: "cover",
              objectPosition,
            }}
          />
          {children}
          <div
            style={{
              position: "absolute",
              top: 7,
              left: "50%",
              width: 58,
              height: 17,
              borderRadius: 20,
              background: "#111918",
              transform: "translateX(-50%)",
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: -30,
          transform: "translateX(-50%)",
          padding: "7px 10px",
          borderRadius: 999,
          background: "rgba(11,20,19,.9)",
          border: "1px solid rgba(255,255,255,.16)",
          color: "rgba(255,255,255,.72)",
          whiteSpace: "nowrap",
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: ".12em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function Connector({
  x,
  y,
  width,
  start,
  color = PALETTE.copper,
}: {
  x: number;
  y: number;
  width: number;
  start: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const progress = reveal(frame, start, 42);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: width * progress,
        height: 1,
        background: `linear-gradient(90deg, ${color}, transparent)`,
        transformOrigin: "left center",
      }}
    />
  );
}

function Check({
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

function FlowRail({ items, active }: { items: string[]; active: number }) {
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

function SceneBackdrop({ mode }: { mode: "collect" | "decide" }) {
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

function CollectOpening({ start, end, visibleUntil }: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleScale = interpolate(pop(frame, start, fps), [0, 1], [0.94, 1]);
  return (
    <Stage start={start} end={end} visibleUntil={visibleUntil}>
      <div style={{ position: "absolute", left: 110, top: 265, ...baseText }}>
        <RolePill label="Programme operations" />
        <div
          style={{
            marginTop: 27,
            transform: `scale(${titleScale})`,
            transformOrigin: "left center",
          }}
        >
          <h1
            style={{
              margin: 0,
              width: 920,
              color: PALETTE.paper,
              fontSize: 94,
              lineHeight: 0.94,
              letterSpacing: "-.08em",
              fontWeight: 740,
            }}
          >
            From application form
            <br />
            to <span style={{ color: PALETTE.copperSoft }}>programme</span>{" "}
            decision.
          </h1>
        </div>
        <p
          style={{
            margin: "33px 0 0",
            color: "rgba(255,255,255,.6)",
            fontSize: 22,
            lineHeight: 1.4,
            maxWidth: 580,
            ...baseText,
          }}
        >
          A traceable workflow from application to decision.
        </p>
      </div>
      <div
        style={{
          position: "absolute",
          right: 160,
          top: 270,
          width: 470,
          height: 470,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.copper}5c`,
          opacity: 0.65,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 240,
          top: 350,
          width: 310,
          height: 310,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.sage}4d`,
          opacity: 0.65,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 382,
          top: 492,
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: PALETTE.copper,
          boxShadow: `0 0 0 12px ${PALETTE.copper}1f, 0 0 60px ${PALETTE.copper}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 185,
          top: 320,
          color: "rgba(255,255,255,.36)",
          fontSize: 12,
          letterSpacing: ".13em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        collect → decide
      </div>
    </Stage>
  );
}

function CollectBuilder({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="Admin · form builder" />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="01 / Build the form"
            title={"Define the\napplication\nquestions."}
            body="Configure sections and conditional fields, then preview the applicant form."
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 31,
            width: 500,
          }}
        >
          <Check>Build the next version without touching the live form.</Check>
          <Check color={PALETTE.copperSoft}>
            Every question maps to a clear review goal.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.formBuilder}
        label="Admin workspace · form builder"
        caption="Draft v2 · saved"
        x={715}
        y={189}
        width={1110}
        height={685}
        start={start + 15}
        end={end}
        holdToEnd
        objectPosition="50% 50%"
      >
        <AdminIdentityOverlay />
      </BrowserShot>
      <div style={{ position: "absolute", left: 680, top: 908 }}>
        <InfoCard
          title="Version every application with confidence"
          body="Draft the next version while applicants keep using the published form."
          icon="↗"
          width={370}
        />
      </div>
      <Connector x={682} y={837} width={240} start={start + 142} />
    </Stage>
  );
}

function CollectPreview({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="Admin · preview" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="02 / Preview the application"
            title={"Review the\napplicant-facing form."}
            body="Preview the applicant-facing form before publishing."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 430,
          }}
        >
          <MetaRow label="Surface" value="Public application" />
          <MetaRow label="Experience" value="Applicant journey" />
          <MetaRow label="State" value="Live preview" accent={PALETTE.sage} />
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Public surface · desktop preview"
        caption="Applicant preview"
        x={690}
        y={164}
        width={1050}
        height={715}
        start={start + 5}
        end={end}
        holdToEnd
        objectPosition="50% 17%"
      />
      <PhoneShot
        src={ASSETS.publicApplicationMobile}
        label="Mobile preview"
        x={1575}
        y={382}
        width={228}
        height={449}
        start={start + 40}
        end={end}
        holdToEnd
        objectPosition="50% 8%"
      >
        <div
          style={{
            position: "absolute",
            right: 13,
            top: 116,
            padding: "6px 8px",
            borderRadius: 6,
            color: PALETTE.paper,
            background: "rgba(11,20,19,.86)",
            fontSize: 9,
            fontWeight: 800,
          }}
        >
          MOBILE READY
        </div>
      </PhoneShot>
      <div
        style={{
          position: "absolute",
          left: 765,
          top: 840,
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: "rgba(255,255,255,.52)",
          fontSize: 12,
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.sage,
          }}
        />
        Preview mirrors the applicant-facing route
      </div>
    </Stage>
  );
}

function CollectPublish({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pulse = interpolate(Math.sin((frame - start) / 11), [-1, 1], [0.95, 1]);
  const badgeProgress = pop(frame, start + 24, fps);
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 190 }}>
        <RolePill label="Admin · publish version" />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="03 / Publish a version"
            title={"Launch a stable\nform version."}
            body="Applicants submit against the version they opened."
          />
        </div>
        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 455,
          }}
        >
          <Check>Draft v2 remains available for the next edit.</Check>
          <Check color={PALETTE.sage}>
            Published v1 is the version under review.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.formBuilderLaptop}
        label="Admin workspace · publish"
        caption="Version history"
        x={720}
        y={214}
        width={1010}
        height={578}
        start={start + 10}
        end={end}
        holdToEnd
        objectPosition="50% 48%"
      >
        <AdminIdentityOverlay />
        <div
          style={{
            position: "absolute",
            right: 22,
            bottom: 18,
            display: "flex",
            gap: 7,
          }}
        >
          <span
            style={{
              padding: "7px 10px",
              borderRadius: 7,
              background: "#fffdf8",
              border: "1px solid #d5d2c8",
              color: "#253631",
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            v2 · Draft
          </span>
          <span
            style={{
              padding: "7px 10px",
              borderRadius: 7,
              background: `${PALETTE.sage}e8`,
              color: "#183421",
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            v1 · Published
          </span>
        </div>
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          left: 1398,
          top: 337,
          width: 266,
          padding: "18px 20px 20px",
          borderRadius: 15,
          background: "rgba(247,245,241,.98)",
          color: PALETTE.ink,
          opacity: badgeProgress,
          transform: `scale(${interpolate(badgeProgress, [0, 1], [0.86, 1])})`,
          boxShadow: "0 22px 52px rgba(0,0,0,.34)",
          ...baseText,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            color: PALETTE.sageDeep,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background: `${PALETTE.sage}44`,
              color: PALETTE.sageDeep,
            }}
          >
            ✓
          </span>{" "}
          PUBLISHED AND VERSIONED
        </div>
        <div
          style={{
            marginTop: 15,
            fontSize: 25,
            fontWeight: 800,
            letterSpacing: "-.05em",
          }}
        >
          Published version 01
        </div>
        <div
          style={{
            marginTop: 7,
            color: "#65736d",
            fontSize: 11,
            lineHeight: 1.42,
          }}
        >
          Immutable snapshot · ready for applications
        </div>
        <div
          style={{
            marginTop: 17,
            height: 3,
            borderRadius: 3,
            background: PALETTE.sage,
            transform: `scaleX(${pulse})`,
            transformOrigin: "left",
          }}
        />
      </div>
      <Connector
        x={1300}
        y={501}
        width={120}
        start={start + 55}
        color={PALETTE.sage}
      />
    </Stage>
  );
}

function CollectApplicant({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 193 }}>
        <RolePill label="Applicant · private draft" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="04 / Start an application"
            title={"Save and resume\na private draft."}
            body="Email verification controls access to the private draft."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 33,
            display: "flex",
            flexDirection: "column",
            gap: 13,
            width: 450,
          }}
        >
          <Check color={PALETTE.sage}>
            Draft saved before final submission.
          </Check>
          <Check color={PALETTE.sage}>
            Email verification is required to resume.
          </Check>
          <Check color={PALETTE.copperSoft}>
            This draft stays linked to the form version it started with.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Applicant surface · public form"
        caption="Draft saved"
        x={724}
        y={151}
        width={790}
        height={774}
        start={start + 8}
        end={end}
        holdToEnd
        objectPosition="50% 38%"
      />
      <PhoneShot
        src={ASSETS.publicApplicationMobile}
        label="Applicant · verified"
        x={1540}
        y={320}
        width={300}
        height={535}
        start={start + 38}
        end={end}
        holdToEnd
        objectPosition="50% 48%"
      >
        <div
          style={{
            position: "absolute",
            left: 15,
            right: 15,
            top: 222,
            padding: "11px 10px",
            borderRadius: 8,
            background: "rgba(244,252,244,.96)",
            border: `1px solid ${PALETTE.sage}99`,
            color: PALETTE.sageDeep,
            fontSize: 10,
            lineHeight: 1.3,
            fontWeight: 800,
            boxShadow: "0 5px 18px rgba(10,40,25,.16)",
          }}
        >
          ✓ Email verified
          <br />
          <span style={{ fontWeight: 600 }}>
            Your private draft is ready to resume.
          </span>
        </div>
      </PhoneShot>
      <div
        style={{
          position: "absolute",
          left: 730,
          top: 945,
          display: "flex",
          gap: 9,
          ...baseText,
        }}
      >
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 999,
            background: "rgba(143,191,154,.15)",
            border: `1px solid ${PALETTE.sage}55`,
            color: PALETTE.sage,
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          DRAFT SAVED
        </span>
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 999,
            background: "rgba(255,255,255,.06)",
            border: `1px solid ${hairline}`,
            color: "rgba(255,255,255,.58)",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          6 questions · 12 min
        </span>
      </div>
    </Stage>
  );
}

function CollectSubmit({ start, end, visibleFrom }: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const submitted = pop(frame, start + 96, fps);
  return (
    <Stage start={start} end={end} visibleFrom={visibleFrom}>
      <div style={{ position: "absolute", left: 110, top: 200 }}>
        <RolePill label="Applicant · submission" color={PALETTE.copperSoft} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="05 / Submit the application"
            title={"Submission state and\nform version are recorded."}
            body="Reviewers see the submitted answers and form version."
          />
        </div>
        <div
          style={{
            marginTop: 38,
            display: "flex",
            alignItems: "center",
            gap: 14,
            ...baseText,
          }}
        >
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background: `${PALETTE.sage}22`,
              border: `1px solid ${PALETTE.sage}77`,
              color: PALETTE.sage,
              fontSize: 18,
            }}
          >
            ✓
          </span>
          <div>
            <div
              style={{ color: PALETTE.paper, fontSize: 14, fontWeight: 800 }}
            >
              Verified submission
            </div>
            <div
              style={{
                color: "rgba(255,255,255,.48)",
                fontSize: 12,
                marginTop: 4,
              }}
            >
              Attached to published version 01
            </div>
          </div>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Applicant surface · submitted"
        caption="Submission received · version 01"
        x={746}
        y={177}
        width={910}
        height={696}
        start={start + 6}
        end={end}
        objectPosition="50% 61%"
      >
        <div
          style={{
            position: "absolute",
            left: 36,
            right: 36,
            top: 185,
            padding: "17px 18px",
            borderRadius: 12,
            background: "rgba(247,253,247,.98)",
            border: `1px solid ${PALETTE.sage}aa`,
            color: PALETTE.sageDeep,
            boxShadow: "0 10px 30px rgba(5,30,14,.16)",
            ...baseText,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 14,
              fontWeight: 900,
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                display: "grid",
                placeItems: "center",
                borderRadius: "50%",
                background: `${PALETTE.sage}44`,
              }}
            >
              ✓
            </span>{" "}
            Submission received
          </div>
          <div
            style={{
              marginTop: 7,
              marginLeft: 34,
              fontSize: 11,
              color: "#5d7063",
            }}
          >
            Future of Events 2027 · Call for Speakers · v01
          </div>
        </div>
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          right: 150,
          top: 265,
          width: 298,
          padding: 20,
          borderRadius: 15,
          background: "rgba(18,32,30,.94)",
          border: `1px solid ${PALETTE.copper}55`,
          opacity: submitted,
          transform: `translateY(${interpolate(submitted, [0, 1], [24, 0])}px)`,
          ...baseText,
        }}
      >
        <div
          style={{
            color: PALETTE.copperSoft,
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: ".13em",
            textTransform: "uppercase",
          }}
        >
          Ready for review
        </div>
        <div
          style={{
            marginTop: 12,
            color: PALETTE.paper,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-.03em",
          }}
        >
          Reviewers see the
          <br />
          submitted answers and form version.
        </div>
        <div
          style={{
            marginTop: 15,
            color: "rgba(255,255,255,.52)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          Submission retains its published form version.
        </div>
      </div>
      <Connector
        x={1570}
        y={563}
        width={84}
        start={start + 130}
        color={PALETTE.copperSoft}
      />
    </Stage>
  );
}

function DecideOpening({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <Stage start={start} end={end}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 273,
          transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
          ...baseText,
        }}
      >
        <RolePill label="Review & selection" color={PALETTE.sage} />
        <h1
          style={{
            margin: "27px 0 0",
            color: PALETTE.paper,
            fontSize: 94,
            lineHeight: 0.94,
            letterSpacing: "-.08em",
            fontWeight: 740,
          }}
        >
          Choose the programme
          <br />
          <span style={{ color: PALETTE.sage }}>your audience came for.</span>
        </h1>
        <p
          style={{
            margin: "33px 0 0",
            color: "rgba(255,255,255,.6)",
            fontSize: 22,
            lineHeight: 1.4,
            maxWidth: 620,
          }}
        >
          See every proposal, compare it with one shared rubric and make the
          final call with confidence.
        </p>
      </div>
      <div
        style={{
          position: "absolute",
          right: 173,
          top: 230,
          width: 495,
          height: 495,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.sage}55`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 255,
          top: 310,
          width: 335,
          height: 335,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.copper}4d`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 405,
          top: 459,
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: PALETTE.sage,
          boxShadow: `0 0 0 13px ${PALETTE.sage}1f, 0 0 65px ${PALETTE.sage}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 168,
          top: 720,
          display: "flex",
          gap: 8,
          color: "rgba(255,255,255,.42)",
          fontSize: 11,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        <span style={{ color: PALETTE.sage }}>review</span>
        <span>·</span>
        <span>evidence</span>
        <span>·</span>
        <span>decision</span>
      </div>
    </Stage>
  );
}

function DecideContext({ start, end }: { start: number; end: number }) {
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 187 }}>
        <RolePill label="Evaluator · assigned queue" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="01 / Start with context"
            title={"Review with the\nfull queue in view."}
            body="The workbench shows the assignment, proposal and conflict check together."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            gap: 11,
            width: 420,
          }}
        >
          <Check color={PALETTE.sage}>
            The reviewer sees the submitted answers and published form version.
          </Check>
          <Check color={PALETTE.sage}>
            Queue state and assignment stay visible.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · review workbench"
        caption="Assigned · 1 of 2"
        x={692}
        y={156}
        width={1055}
        height={728}
        start={start + 7}
        end={end}
        objectPosition="72% 38%"
      >
        <ReviewEvidenceState
          showSuggestions
          style={{ height: 116, left: 220, top: 188, width: 425 }}
        />
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          left: 782,
          top: 909,
          padding: "9px 12px",
          borderRadius: 9,
          color: PALETTE.sage,
          border: `1px solid ${PALETTE.sage}55`,
          background: `${PALETTE.sage}10`,
          fontSize: 11,
          fontWeight: 800,
          ...baseText,
        }}
      >
        QUEUE CONTEXT · PROPOSAL · CONFLICT CHECK
      </div>
    </Stage>
  );
}

function RubricCard({
  label,
  weight,
  value,
  x,
  y,
  start,
}: {
  label: string;
  weight: string;
  value: number;
  x: number;
  y: number;
  start: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 286,
        padding: "15px 16px 16px",
        borderRadius: 13,
        background: "rgba(247,245,241,.98)",
        color: PALETTE.ink,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [16, 0])}px)`,
        boxShadow: "0 18px 32px rgba(0,0,0,.24)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "baseline",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 900 }}>{label}</span>
        <span
          style={{ color: PALETTE.copperDeep, fontSize: 11, fontWeight: 900 }}
        >
          {weight}
        </span>
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 6 }}>
        {[1, 2, 3, 4, 5].map((item) => (
          <span
            key={item}
            style={{
              width: 31,
              height: 31,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              border: `1px solid ${item === value ? PALETTE.copper : "#d8d6cc"}`,
              background: item === value ? PALETTE.copper : "#fffdf8",
              color: item === value ? "#fff" : PALETTE.ink,
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            {item}
          </span>
        ))}
      </div>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          justifyContent: "space-between",
          color: "#78827c",
          fontSize: 10,
        }}
      >
        <span>Weak</span>
        <span>Strong</span>
      </div>
    </div>
  );
}

function DecideRubric({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const total = interpolate(frame, [start + 80, start + 145], [0, 4.25], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 190 }}>
        <RolePill
          label="Evaluator · reviewer scoring"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="02 / Score the proposal"
            title={"Apply the scoring\nrubric."}
            body="Score weighted criteria with reviewer control."
          />
        </div>
        <div
          style={{
            marginTop: 35,
            color: "rgba(255,255,255,.48)",
            fontSize: 12,
            lineHeight: 1.5,
            width: 390,
            ...baseText,
          }}
        >
          Criterion scores and weights remain visible alongside the total.
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · weighted rubric"
        caption="Draft score · not submitted"
        x={702}
        y={157}
        width={1034}
        height={727}
        start={start + 8}
        end={end}
        objectPosition="77% 53%"
      />
      <RubricCard
        label="Audience relevance"
        weight="30%"
        value={4}
        x={1034}
        y={267}
        start={start + 35}
      />
      <RubricCard
        label="Content substance"
        weight="25%"
        value={5}
        x={1338}
        y={359}
        start={start + 62}
      />
      <RubricCard
        label="Practical value"
        weight="25%"
        value={4}
        x={1034}
        y={565}
        start={start + 89}
      />
      <RubricCard
        label="Delivery approach"
        weight="20%"
        value={4}
        x={1338}
        y={657}
        start={start + 116}
      />
      <div
        style={{
          position: "absolute",
          left: 1160,
          top: 846,
          width: 390,
          padding: "12px 16px",
          borderRadius: 11,
          background: "rgba(11,20,19,.91)",
          border: `1px solid ${PALETTE.copper}66`,
          color: PALETTE.paper,
          opacity: reveal(frame, start + 146, 30),
          ...baseText,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "rgba(255,255,255,.56)", fontSize: 11 }}>
            Weighted draft score
          </span>
          <span
            style={{
              color: PALETTE.copperSoft,
              fontSize: 21,
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {total.toFixed(2)} / 5
          </span>
        </div>
      </div>
    </Stage>
  );
}

function AdvisoryCard({
  x,
  y,
  start,
}: {
  x: number;
  y: number;
  start: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 437,
        padding: "19px 20px 18px",
        borderRadius: 15,
        background: "rgba(15,31,28,.96)",
        border: `1px solid ${PALETTE.sage}77`,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [23, 0])}px)`,
        boxShadow: "0 25px 55px rgba(0,0,0,.38)",
        ...baseText,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 27,
            height: 27,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: `${PALETTE.sage}22`,
            color: PALETTE.sage,
            fontSize: 14,
          }}
        >
          ✦
        </span>
        <span style={{ color: PALETTE.paper, fontSize: 14, fontWeight: 850 }}>
          AI evidence assistant
        </span>
        <span
          style={{
            marginLeft: "auto",
            padding: "5px 8px",
            borderRadius: 999,
            background: `${PALETTE.sage}17`,
            border: `1px solid ${PALETTE.sage}55`,
            color: PALETTE.sage,
            fontSize: 9,
            fontWeight: 900,
            letterSpacing: ".1em",
            textTransform: "uppercase",
          }}
        >
          Evidence-linked suggestions
        </span>
      </div>
      <p
        style={{
          margin: "15px 0 0",
          color: "rgba(255,255,255,.64)",
          fontSize: 12,
          lineHeight: 1.46,
        }}
      >
        Source-linked suggestions bring the strongest evidence into focus.
        Import what matters, then complete the review.
      </p>
      <div style={{ marginTop: 15, display: "flex", flexWrap: "wrap", gap: 7 }}>
        {["Source cited", "Import what matters", "Reviewer decides"].map(
          (item) => (
            <span
              key={item}
              style={{
                padding: "7px 9px",
                borderRadius: 7,
                color: "rgba(255,255,255,.56)",
                background: "rgba(255,255,255,.055)",
                border: `1px solid ${hairline}`,
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {item}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function DecideAdvisory({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="AI-assisted review" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="03 / Turn evidence into insight"
            title={"Let AI bring\nthe evidence\ninto focus."}
            body="AI brings cited evidence and suggested values alongside the source. Reviewers choose what matters."
            accent={PALETTE.sage}
          />
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · reviewer suggestions"
        caption="Cited suggestions · your call"
        x={703}
        y={161}
        width={1050}
        height={724}
        start={start + 8}
        end={end}
        objectPosition="50% 51%"
      >
        <ReviewEvidenceState
          style={{ height: 92, left: 232, top: 130, width: 410 }}
        />
        <div
          style={{
            position: "absolute",
            left: 232,
            top: 128,
            width: 410,
            height: 96,
            borderRadius: 15,
            border: `2px solid ${PALETTE.sage}aa`,
            boxShadow: `0 0 0 6px ${PALETTE.sage}16, 0 0 28px ${PALETTE.sage}38`,
          }}
        />
      </BrowserShot>
      <AdvisoryCard x={105} y={650} start={start + 62} />
      <div
        style={{
          position: "absolute",
          left: 784,
          top: 840,
          opacity: reveal(frame, start + 95, 28),
          color: PALETTE.sage,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".09em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        Source → cited insight → confident review
      </div>
    </Stage>
  );
}

function SubmitReviewCard({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: 1254,
        top: 300,
        width: 382,
        padding: 21,
        borderRadius: 15,
        background: "rgba(247,245,241,.98)",
        color: PALETTE.ink,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [22, 0])}px)`,
        boxShadow: "0 24px 50px rgba(0,0,0,.32)",
        ...baseText,
      }}
    >
      <div
        style={{
          color: PALETTE.copperDeep,
          fontSize: 10,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          fontWeight: 900,
        }}
      >
        SUBMITTED REVIEW
      </div>
      <div
        style={{
          marginTop: 12,
          color: PALETTE.ink,
          fontSize: 23,
          lineHeight: 1.05,
          letterSpacing: "-.05em",
          fontWeight: 850,
        }}
      >
        Review recorded.
      </div>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        {[
          "4 criteria scored",
          "Recommendation · Waitlist",
          "Applicant feedback reviewed",
        ].map((item) => (
          <div
            key={item}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: "#596860",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <span style={{ color: PALETTE.sageDeep, fontSize: 14 }}>✓</span>
            {item}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 19,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <span
          style={{
            padding: "9px 13px",
            borderRadius: 8,
            background: PALETTE.sageDeep,
            border: `1px solid ${PALETTE.sageDeep}`,
            color: PALETTE.paper,
            fontSize: 11,
            fontWeight: 850,
          }}
        >
          REVIEW SUBMITTED ✓
        </span>
      </div>
    </div>
  );
}

function DecideSubmit({ start, end }: { start: number; end: number }) {
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 191 }}>
        <RolePill
          label="Evaluator · recommendation"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="04 / Make the recommendation"
            title={"Turn every review\ninto a clear\nrecommendation."}
            body="Finish the shared rubric, add useful feedback and send the organiser a confident recommendation."
          />
        </div>
        <div
          style={{
            marginTop: 37,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 415,
          }}
        >
          <Check>Keep conflicts of interest clear.</Check>
          <Check>Share helpful feedback without exposing private notes.</Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · final check"
        x={724}
        y={178}
        width={690}
        height={704}
        start={start + 8}
        end={end}
        objectPosition="76% 55%"
      >
        <ReviewEvidenceState
          compact
          style={{ height: 88, left: 144, top: 178, width: 281 }}
        />
      </BrowserShot>
      <SubmitReviewCard start={start + 56} />
      <div
        style={{
          position: "absolute",
          left: 750,
          top: 837,
          display: "flex",
          alignItems: "center",
          gap: 9,
          color: PALETTE.sage,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.sage,
            boxShadow: `0 0 0 5px ${PALETTE.sage}22`,
          }}
        />{" "}
        The organiser's decision preview now includes this review
      </div>
    </Stage>
  );
}

function DecisionPreviewCard({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        right: 137,
        top: 288,
        width: 375,
        padding: 20,
        borderRadius: 15,
        background: "rgba(11,20,19,.95)",
        border: `1px solid ${PALETTE.copperSoft}77`,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
        boxShadow: "0 24px 54px rgba(0,0,0,.34)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            color: PALETTE.copperSoft,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: ".14em",
            textTransform: "uppercase",
          }}
        >
          Released decision
        </span>
        <span
          style={{
            padding: "5px 8px",
            borderRadius: 999,
            background: `${PALETTE.gold}17`,
            border: `1px solid ${PALETTE.gold}55`,
            color: PALETTE.gold,
            fontSize: 9,
            fontWeight: 900,
          }}
        >
          DECISION RELEASED · WAITLISTED
        </span>
      </div>
      <div
        style={{
          marginTop: 16,
          color: PALETTE.paper,
          fontSize: 24,
          fontWeight: 850,
          letterSpacing: "-.05em",
        }}
      >
        Decision state
        <br />
        and review evidence
      </div>
      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 9,
        }}
      >
        <div
          style={{
            padding: "10px 11px",
            borderRadius: 9,
            background: "rgba(255,255,255,.06)",
          }}
        >
          <div style={{ color: "rgba(255,255,255,.42)", fontSize: 10 }}>
            Reviews
          </div>
          <div
            style={{
              marginTop: 4,
              color: PALETTE.paper,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            2 / 2
          </div>
        </div>
        <div
          style={{
            padding: "10px 11px",
            borderRadius: 9,
            background: "rgba(255,255,255,.06)",
          }}
        >
          <div style={{ color: "rgba(255,255,255,.42)", fontSize: 10 }}>
            Average
          </div>
          <div
            style={{
              marginTop: 4,
              color: PALETTE.sage,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            3.40 / 5
          </div>
        </div>
      </div>
      <div
        style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: `1px solid ${hairline}`,
          color: "rgba(255,255,255,.6)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        Decision released · communication status visible.
      </div>
      <div
        style={{ marginTop: 15, display: "flex", justifyContent: "flex-end" }}
      >
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 8,
            background: PALETTE.copper,
            color: "#fff",
            fontSize: 10,
            fontWeight: 850,
          }}
        >
          Review evidence
        </span>
      </div>
    </div>
  );
}

function DecidePreview({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <Stage start={start} end={end}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 192,
          transform: `translateY(${interpolate(p, [0, 1], [12, 0])}px)`,
        }}
      >
        <RolePill
          label="Admin · review & selection"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="05 / Review decision evidence"
            title={"Review decision evidence\nand release status."}
            body="Submitted reviews inform an organiser-approved programme decision."
          />
        </div>
        <div
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 445,
          }}
        >
          <Check color={PALETTE.sage}>
            Assignments, review count and discussion state stay visible.
          </Check>
          <Check color={PALETTE.copperSoft}>
            Release links the decision to its tracked communication status.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.evaluationAdmin}
        label="Admin workspace · review & selection"
        caption="2 submissions · 1 decision to review"
        x={694}
        y={157}
        width={1072}
        height={727}
        start={start + 6}
        end={end}
        objectPosition="50% 50%"
      />
      <DecisionPreviewCard start={start + 67} />
      <div
        style={{
          position: "absolute",
          left: 753,
          top: 840,
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "rgba(255,255,255,.53)",
          fontSize: 11,
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.gold,
          }}
        />
        <span>Committee evidence collected</span>
        <span style={{ color: PALETTE.copperSoft }}>→</span>
        <span>Decision released · communication status visible</span>
      </div>
    </Stage>
  );
}

function EndCard({
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

export function CollectScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const d = Math.max(1, duration);
  const openingEnd = Math.round(d * 0.15);
  const builderStart = Math.round(d * 0.12);
  const builderEnd = Math.round(d * 0.35);
  const previewStart = Math.round(d * 0.32);
  const previewEnd = Math.round(d * 0.51);
  const publishStart = Math.round(d * 0.47);
  const publishEnd = Math.round(d * 0.66);
  const applicantStart = Math.round(d * 0.63);
  const applicantEnd = Math.round(d * 0.82);
  const submitStart = Math.round(d * 0.79);
  const submitEnd = Math.round(d * 0.93);
  const endStart = Math.round(d * 0.9);
  const builderCut = openingEnd;
  const previewCut = Math.round(d / 3);
  const publishCut = Math.round(d * 0.504);
  const applicantCut = publishEnd;
  const submitCut = applicantEnd;
  const railActive =
    frame < builderCut
      ? 0
      : frame < previewCut
        ? 1
        : frame < publishCut
          ? 2
          : frame < applicantCut
            ? 3
            : 4;

  return (
    <AbsoluteFill
      style={{
        background: PALETTE.inkDeep,
        color: PALETTE.paper,
        overflow: "hidden",
      }}
    >
      <SceneBackdrop mode="collect" />
      <TopBar
        section="Collect"
        chapter="Versioned application forms"
        step="05 / 13"
      />
      <FlowRail
        items={["Intent", "Build", "Preview", "Publish", "Submit"]}
        active={railActive}
      />
      <CollectOpening start={0} end={openingEnd} visibleUntil={builderCut} />
      <CollectBuilder
        start={builderStart}
        end={builderEnd}
        visibleFrom={builderCut}
        visibleUntil={previewCut}
      />
      <CollectPreview
        start={previewStart}
        end={previewEnd}
        visibleFrom={previewCut}
        visibleUntil={publishCut}
      />
      <CollectPublish
        start={publishStart}
        end={publishEnd}
        visibleFrom={publishCut}
        visibleUntil={applicantCut}
      />
      <CollectApplicant
        start={applicantStart}
        end={applicantEnd}
        visibleFrom={applicantCut}
        visibleUntil={submitCut}
      />
      <CollectSubmit
        start={submitStart}
        end={submitEnd}
        visibleFrom={submitCut}
      />
      <EndCard start={endStart} end={d + 45} mode="collect" />
      <Footer
        label="Collect"
        progress={frame / d}
        right="builder → preview → publish → verified submit"
      />
      <Grain />
    </AbsoluteFill>
  );
}

export function DecideScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const d = Math.max(1, duration);
  const openingEnd = Math.round(d * 0.14);
  const contextStart = Math.round(d * 0.11);
  const contextEnd = Math.round(d * 0.32);
  const rubricStart = Math.round(d * 0.29);
  const rubricEnd = Math.round(d * 0.49);
  const advisoryStart = Math.round(d * 0.46);
  const advisoryEnd = Math.round(d * 0.65);
  const submitStart = Math.round(d * 0.62);
  const submitEnd = Math.round(d * 0.81);
  const previewStart = Math.round(d * 0.78);
  const previewEnd = Math.round(d * 0.93);
  const endStart = Math.round(d * 0.9);
  const railActive =
    frame < contextStart
      ? 0
      : frame < rubricStart
        ? 1
        : frame < advisoryStart
          ? 2
          : frame < submitStart
            ? 3
            : 4;

  return (
    <AbsoluteFill
      style={{
        background: PALETTE.inkDeep,
        color: PALETTE.paper,
        overflow: "hidden",
      }}
    >
      <SceneBackdrop mode="decide" />
      <TopBar
        section="Decide"
        chapter="Evidence before release"
        step="06 / 13"
      />
      <FlowRail
        items={["Context", "Rubric", "Advisory", "Submit", "Preview"]}
        active={railActive}
      />
      <DecideOpening start={0} end={openingEnd} />
      <DecideContext start={contextStart} end={contextEnd} />
      <DecideRubric start={rubricStart} end={rubricEnd} />
      <DecideAdvisory start={advisoryStart} end={advisoryEnd} />
      <DecideSubmit start={submitStart} end={submitEnd} />
      <DecidePreview start={previewStart} end={previewEnd} />
      <EndCard start={endStart} end={d + 45} mode="decide" />
      <Footer
        label="Decide"
        progress={frame / d}
        right="context → rubric → advisory → submit → decision preview"
      />
      <Grain />
    </AbsoluteFill>
  );
}
