import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  interpolateColors,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";

export type SceneProps = {
  duration: number;
};

type RevealProps = {
  amount: number;
  children: ReactNode;
  x?: number;
  y?: number;
  scale?: number;
  style?: CSSProperties;
};

const ink = PALETTE.ink;
const deep = PALETTE.inkDeep;
const paper = PALETTE.paper;
const canvas = PALETTE.canvas;
const copper = PALETTE.copper;
const copperText = PALETTE.copperDeep;
const sage = PALETTE.sage;
const line = PALETTE.line;
const muted = PALETTE.muted;

const placementStory = {
  title: "Future of urban care",
  speaker: "Maya Chen",
  conflictRoom: "Main Hall",
  placedRoom: "Studio B",
  slot: "Thu 10:30",
  currentDescription: "Description · “Care at city scale”",
  draftDescription: "Description · “Care at neighbourhood scale”",
} as const;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const local = (value: number, start: number, end: number) =>
  clamp((value - start) / Math.max(0.0001, end - start));

const cut = (value: number, start: number, end: number) =>
  value >= start && value < end ? 1 : 0;

const ease = (value: number) => Easing.bezier(0.22, 1, 0.36, 1)(clamp(value));

const after = (value: number, start: number) => (value >= start ? 1 : 0);

const frameProgress = (frame: number, duration: number) =>
  duration <= 1 ? 1 : clamp(frame / (duration - 1));

const PLACE_TRANSITION_HALF = 0.0065;

function Reveal({
  amount,
  children,
  x = 0,
  y = 18,
  scale = 0.985,
  style,
}: RevealProps) {
  const eased = ease(amount);
  return (
    <div
      style={{
        opacity: eased,
        transform: `translate3d(${interpolate(eased, [0, 1], [x, 0])}px, ${interpolate(eased, [0, 1], [y, 0])}px, 0) scale(${interpolate(eased, [0, 1], [scale, 1])})`,
        transformOrigin: "center center",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function BrandMark({ dark = false }: { dark?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <ProgramCueMark
        accent={copper}
        ink={dark ? paper : ink}
        size={34}
        style={{
          filter: dark
            ? "drop-shadow(0 8px 12px rgba(190,98,66,.22))"
            : "drop-shadow(0 8px 12px rgba(24,37,34,.15))",
        }}
      />
      <div
        style={{
          color: dark ? paper : ink,
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: "0.02em",
        }}
      >
        PROGRAM CUE
      </div>
    </div>
  );
}

function DotGrid({
  opacity = 0.32,
  dark = true,
}: {
  opacity?: number;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        backgroundImage: `radial-gradient(${dark ? "rgba(255,253,248,.28)" : "rgba(24,37,34,.16)"} 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
        maskImage:
          "linear-gradient(90deg, transparent 0%, black 14%, black 86%, transparent 100%)",
        pointerEvents: "none",
      }}
    />
  );
}

function SceneHeader({
  chapter,
  index,
  progress,
  dark = true,
}: {
  chapter: string;
  index: string;
  progress: number;
  dark?: boolean;
}) {
  const textColor = dark ? paper : ink;
  const mutedColor = dark ? "rgba(255,253,248,.55)" : muted;
  return (
    <div
      style={{
        position: "absolute",
        top: 52,
        left: 76,
        right: 76,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        zIndex: 40,
      }}
    >
      <BrandMark dark={dark} />
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.18em",
            color: mutedColor,
          }}
        >
          {chapter}
        </div>
        <div
          style={{
            width: 1,
            height: 18,
            background: dark ? "rgba(255,255,255,.17)" : line,
          }}
        />
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: textColor,
            letterSpacing: "0.12em",
          }}
        >
          {index}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 55,
          height: 1,
          background: dark ? "rgba(255,255,255,.13)" : line,
          transformOrigin: "left center",
          transform: `scaleX(${interpolate(progress, [0, 1], [0.06, 1])})`,
        }}
      />
    </div>
  );
}

function FooterRail({
  activationPoints,
  progress,
  items,
  dark = true,
}: {
  activationPoints?: number[];
  progress: number;
  items: string[];
  dark?: boolean;
}) {
  const railColor = dark ? "rgba(255,253,248,.42)" : muted;
  return (
    <div
      style={{
        position: "absolute",
        left: 76,
        right: 76,
        bottom: 38,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        gap: 18,
        color: railColor,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.13em",
      }}
    >
      <div
        style={{
          height: 2,
          width: 182,
          borderRadius: 99,
          background: dark ? "rgba(255,255,255,.16)" : "rgba(24,37,34,.14)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: copper,
            transformOrigin: "left center",
          }}
        />
      </div>
      {items.map((item, index) => {
        const active = activationPoints
          ? progress >= (activationPoints[index] ?? 1)
          : progress >= index / Math.max(1, items.length - 1) - 0.08;
        return (
          <div
            key={item}
            style={{
              color: active ? (dark ? paper : ink) : railColor,
            }}
          >
            {String(index + 1).padStart(2, "0")} {item}
          </div>
        );
      })}
      <div style={{ marginLeft: "auto", opacity: 0.72 }}>
        PROGRAM CUE / LAUNCH FILM
      </div>
    </div>
  );
}

function Eyebrow({
  children,
  tone = "copper",
  dark = false,
}: {
  children: ReactNode;
  tone?: "copper" | "sage" | "light";
  dark?: boolean;
}) {
  const color = tone === "sage" ? sage : tone === "light" ? paper : copper;
  const textColor = tone === "copper" && !dark ? copperText : color;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        color: textColor,
        fontSize: 11,
        fontWeight: 850,
        letterSpacing: "0.17em",
        textTransform: "uppercase",
        textShadow:
          dark && tone === "light" ? "0 1px 14px rgba(0,0,0,.24)" : undefined,
      }}
    >
      <span
        style={{ width: 20, height: 2, borderRadius: 99, background: color }}
      />
      {children}
    </div>
  );
}

function Chip({
  children,
  tone = "neutral",
  dark = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "copper";
  dark?: boolean;
}) {
  const tones: Record<string, { bg: string; color: string; border: string }> = {
    neutral: {
      bg: dark ? "rgba(255,255,255,.08)" : "rgba(24,37,34,.06)",
      color: dark ? "rgba(255,253,248,.75)" : muted,
      border: dark ? "rgba(255,255,255,.13)" : "rgba(24,37,34,.13)",
    },
    good: {
      bg: "rgba(143,191,154,.14)",
      color: dark ? "#b8e7bf" : PALETTE.sageDeep,
      border: "rgba(143,191,154,.36)",
    },
    warn: {
      bg: "rgba(212,167,44,.15)",
      color: dark ? "#f7d56b" : "#806315",
      border: "rgba(212,167,44,.34)",
    },
    bad: {
      bg: "rgba(220,38,38,.13)",
      color: dark ? "#ffb0a8" : "#a52b27",
      border: "rgba(220,38,38,.32)",
    },
    copper: {
      bg: "rgba(190,98,66,.14)",
      color: dark ? "#ffc5aa" : copperText,
      border: "rgba(190,98,66,.34)",
    },
  };
  const palette = tones[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 25,
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.color,
        fontSize: 10,
        lineHeight: 1,
        fontWeight: 800,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function StatusDot({
  tone = "good",
}: {
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  const colors = {
    good: sage,
    bad: "#ff766a",
    warn: PALETTE.gold,
    neutral: "#96a5a0",
  };
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        display: "inline-block",
        background: colors[tone],
        boxShadow: `0 0 0 4px ${colors[tone]}22`,
      }}
    />
  );
}

function Check({ color = sage }: { color?: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        display: "inline-grid",
        placeItems: "center",
        background: `${color}20`,
        color,
        fontSize: 13,
        fontWeight: 900,
      }}
    >
      ✓
    </span>
  );
}

function AssetWindow({
  src,
  label,
  caption,
  width = 620,
  height = 430,
  objectPosition = "top center",
  dark = false,
  radius = 22,
}: {
  src: string;
  label: string;
  caption?: string;
  width?: number;
  height?: number;
  objectPosition?: string;
  dark?: boolean;
  radius?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        overflow: "hidden",
        background: dark ? "#1a2523" : "#f6f7f2",
        border: `1px solid ${dark ? "rgba(255,255,255,.16)" : "rgba(24,37,34,.14)"}`,
        boxShadow: dark
          ? "0 26px 80px rgba(0,0,0,.3), 0 2px 0 rgba(255,255,255,.06) inset"
          : "0 26px 80px rgba(24,37,34,.15), 0 2px 0 rgba(255,255,255,.9) inset",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 2,
          top: 0,
          left: 0,
          right: 0,
          height: 42,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 16px",
          color: dark ? "rgba(255,253,248,.76)" : muted,
          background: dark ? "rgba(11,20,19,.9)" : "rgba(255,255,255,.9)",
          borderBottom: `1px solid ${dark ? "rgba(255,255,255,.12)" : "rgba(24,37,34,.1)"}`,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.11em",
          textTransform: "uppercase",
          backdropFilter: "blur(12px)",
        }}
      >
        <span style={{ display: "flex", gap: 5 }}>
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#ff766a",
            }}
          />
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: PALETTE.gold,
            }}
          />
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: sage,
            }}
          />
        </span>
        {label}
        {caption ? (
          <span
            style={{
              marginLeft: "auto",
              color: dark ? "rgba(255,253,248,.45)" : muted,
              fontWeight: 700,
            }}
          >
            {caption}
          </span>
        ) : null}
      </div>
      <Img
        src={src}
        style={{
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: "cover",
          objectPosition,
          paddingTop: 42,
          background: dark ? "#1a2523" : "#f6f7f2",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(120deg, rgba(255,255,255,.08), transparent 26%, transparent 70%, rgba(11,20,19,.12))",
        }}
      />
    </div>
  );
}

function MiniAvatar({
  initials,
  color = copper,
}: {
  initials: string;
  color?: string;
}) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: "50%",
        color: paper,
        background: color,
        border: "2px solid rgba(255,255,255,.72)",
        fontSize: 10,
        fontWeight: 900,
      }}
    >
      {initials}
    </span>
  );
}

function Arrow({
  color = copper,
  long = false,
}: {
  color?: string;
  long?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        width: long ? 118 : 72,
        gap: 0,
      }}
    >
      <div style={{ height: 1, flex: 1, background: color }} />
      <div
        style={{
          width: 8,
          height: 8,
          borderTop: `1.5px solid ${color}`,
          borderRight: `1.5px solid ${color}`,
          transform: "rotate(45deg)",
        }}
      />
    </div>
  );
}

function Metric({
  value,
  label,
  tone = "ink",
  dark = false,
}: {
  value: string;
  label: string;
  tone?: "ink" | "copper" | "sage";
  dark?: boolean;
}) {
  const toneColor =
    tone === "copper" ? copper : tone === "sage" ? sage : dark ? paper : ink;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          color: toneColor,
          fontSize: 24,
          fontWeight: 850,
          letterSpacing: "-0.05em",
        }}
      >
        {value}
      </div>
      <div
        style={{
          color: dark ? "rgba(255,253,248,.52)" : muted,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function PlaceConflictCard({ progress }: { progress: number }) {
  const alertPulse = 0.5 + 0.5 * Math.sin(progress * Math.PI * 4 - Math.PI / 2);
  const ownerProgress = ease(local(progress, 0.26, 0.5));
  return (
    <div
      style={{
        width: 632,
        minHeight: 428,
        borderRadius: 24,
        padding: 26,
        background: "rgba(255,253,248,.98)",
        border: `1px solid ${interpolateColors(alertPulse, [0, 1], [line, "rgba(220,38,38,.42)"])}`,
        boxShadow: `0 32px ${interpolate(alertPulse, [0, 1], [90, 110])}px rgba(0,0,0,.28), 0 0 ${interpolate(alertPulse, [0, 1], [0, 22])}px rgba(220,38,38,.16)`,
        color: ink,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StatusDot tone="bad" />
          <span
            style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.13em" }}
          >
            SCHEDULE CONFLICT
          </span>
        </div>
        <Chip tone="bad">2 SESSIONS</Chip>
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 850,
          letterSpacing: "-0.045em",
          marginBottom: 8,
        }}
      >
        Future of Events 2027
      </div>
      <div style={{ color: muted, fontSize: 13, marginBottom: 23 }}>
        A conflict-policy change reveals two sessions in Main Hall at Thu 10:30.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 48px 1fr",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            border: `1px solid ${line}`,
            borderRadius: 16,
            padding: 16,
            background: "#fff",
          }}
        >
          <div
            style={{
              color: muted,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Session A
          </div>
          <div style={{ fontSize: 15, fontWeight: 850 }}>
            {placementStory.title}
          </div>
          <div style={{ color: muted, fontSize: 11, marginTop: 5 }}>
            {placementStory.speaker} · {placementStory.conflictRoom} · 10:30
          </div>
        </div>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            color: "#c33a32",
            fontSize: 24,
            fontWeight: 900,
            transform: `scale(${interpolate(alertPulse, [0, 1], [0.96, 1.16])})`,
          }}
        >
          ×
        </div>
        <div
          style={{
            border: `1px solid rgba(220,38,38,.28)`,
            borderRadius: 16,
            padding: 16,
            background: interpolateColors(
              alertPulse,
              [0, 1],
              ["rgba(220,38,38,.035)", "rgba(220,38,38,.09)"],
            ),
          }}
        >
          <div
            style={{
              color: "#a52b27",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Session B
          </div>
          <div style={{ fontSize: 15, fontWeight: 850 }}>
            Designing inclusive streets
          </div>
          <div style={{ color: muted, fontSize: 11, marginTop: 5 }}>
            Ari Malik · Main Hall · 10:30
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 14,
          padding: "11px 12px",
          borderRadius: 13,
          border: "1px solid rgba(143,191,154,.34)",
          background: "rgba(143,191,154,.08)",
          opacity: ownerProgress,
          transform: `translate3d(${interpolate(ownerProgress, [0, 1], [18, 0])}px, 0, 0)`,
        }}
      >
        <MiniAvatar initials="↗" color={copper} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 9,
              fontWeight: 900,
              letterSpacing: "0.12em",
            }}
          >
            NEXT STEP
          </div>
          <div style={{ fontSize: 12, fontWeight: 800, marginTop: 3 }}>
            Unassign “{placementStory.title}” for replanning
          </div>
        </div>
        <Chip tone="good">Review</Chip>
      </div>
      <div style={{ height: 1, background: line, margin: "22px 0 16px" }} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            color: "#a52b27",
            fontSize: 12,
            fontWeight: 750,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#dc2626",
              boxShadow: `0 0 0 ${interpolate(alertPulse, [0, 1], [0, 7])}px rgba(220,38,38,.12)`,
            }}
          />
          Conflict caught. Live programme protected.
        </div>
        <span style={{ color: muted, fontSize: 11, fontWeight: 700 }}>
          current conflict-policy revision
        </span>
      </div>
    </div>
  );
}

function AutoPlacementCard({ progress }: { progress: number }) {
  const subsetProgress = ease(local(progress, 0.36, 0.55));
  const applyProgress = ease(local(progress, 0.62, 0.8));
  const resultProgress = ease(local(progress, 0.8, 0.96));
  const proposals = [
    {
      title: placementStory.title,
      room: placementStory.placedRoom,
      time: placementStory.slot,
      selected: true,
    },
    {
      title: "Community and Connection",
      room: "Room 301A",
      time: "Thu 11:15",
      selected: false,
    },
  ];
  return (
    <div
      style={{
        width: 672,
        borderRadius: 24,
        padding: 25,
        color: ink,
        background: paper,
        border: `1px solid ${line}`,
        boxShadow: "0 32px 90px rgba(0,0,0,.26)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <div
            style={{ fontSize: 22, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Auto-place unscheduled sessions
          </div>
          <div style={{ color: muted, fontSize: 12, marginTop: 6 }}>
            Maya’s session is unscheduled; preview the current draft revision.
          </div>
        </div>
        <Chip tone="copper">2 proposals · 1 unplaced</Chip>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {proposals.map((proposal, index) => {
          const proposalProgress = ease(
            local(progress, 0.06 + index * 0.09, 0.24 + index * 0.09),
          );
          const selectedProgress = proposal.selected ? 1 : 1 - subsetProgress;
          return (
            <div
              key={proposal.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "13px 14px",
                borderRadius: 15,
                border: `1px solid ${interpolateColors(selectedProgress, [0, 1], [line, "rgba(143,191,154,.58)"])}`,
                background: interpolateColors(
                  selectedProgress,
                  [0, 1],
                  ["rgba(24,37,34,.025)", "rgba(143,191,154,.085)"],
                ),
                opacity: interpolate(proposalProgress, [0, 1], [0.34, 1]),
                transform: `translate3d(${interpolate(proposalProgress, [0, 1], [24, 0])}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  background: interpolateColors(
                    selectedProgress,
                    [0, 1],
                    [paper, sage],
                  ),
                  border: `1px solid ${interpolateColors(selectedProgress, [0, 1], ["rgba(24,37,34,.24)", sage])}`,
                  borderRadius: 6,
                  color: ink,
                  display: "flex",
                  fontSize: 12,
                  fontWeight: 950,
                  height: 22,
                  justifyContent: "center",
                  width: 22,
                }}
              >
                <span style={{ opacity: selectedProgress }}>✓</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>
                  {proposal.title}
                </div>
                <div style={{ color: muted, fontSize: 12, marginTop: 3 }}>
                  {proposal.room} · {proposal.time}
                </div>
              </div>
              <div
                style={{
                  color: interpolateColors(
                    selectedProgress,
                    [0, 1],
                    [muted, PALETTE.sageDeep],
                  ),
                  fontSize: 12,
                  fontWeight: 850,
                }}
              >
                {proposal.selected || subsetProgress < 0.5
                  ? "SELECTED"
                  : "DESELECTED"}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          alignItems: "center",
          background: "rgba(212,167,44,.08)",
          border: "1px solid rgba(212,167,44,.28)",
          borderRadius: 13,
          color: "#806315",
          display: "flex",
          gap: 11,
          marginTop: 10,
          opacity: ease(local(progress, 0.24, 0.42)),
          padding: "11px 13px",
          transform: `translate3d(${interpolate(ease(local(progress, 0.24, 0.42)), [0, 1], [14, 0])}px, 0, 0)`,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 950 }}>!</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 850 }}>
            Building Better Event Data · not placed
          </div>
          <div style={{ fontSize: 11, marginTop: 3 }}>
            No room satisfies capacity and speaker availability.
          </div>
        </div>
        <Chip tone="warn">unplaced</Chip>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 15,
        }}
      >
        <div style={{ color: muted, fontSize: 12, fontWeight: 700 }}>
          {resultProgress > 0.5
            ? "1 placement applied · 1 deselected · 1 unplaced · draft only"
            : "Preview bound to the current draft revision"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: muted, fontSize: 12, fontWeight: 750 }}>
            {resultProgress > 0.5
              ? "1 applied"
              : subsetProgress < 0.5
                ? "2 selected"
                : "1 selected"}
          </span>
          <div
            style={{
              padding: "12px 17px",
              borderRadius: 12,
              background: interpolateColors(
                applyProgress,
                [0, 1],
                [ink, copper],
              ),
              color: paper,
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.06em",
              boxShadow: `0 10px ${interpolate(applyProgress, [0, 1], [0, 24])}px rgba(190,98,66,.22)`,
              transform: `translateY(${interpolate(applyProgress, [0, 1], [2, -1])}px)`,
            }}
          >
            {resultProgress > 0.5
              ? "APPLIED TO DRAFT ✓"
              : subsetProgress < 0.5
                ? "APPLY 2 PLACEMENTS"
                : "APPLY 1 PLACEMENT"}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({ progress }: { progress: number }) {
  const actionProgress = ease(local(progress, 0.72, 0.9));
  return (
    <div
      style={{
        width: 652,
        borderRadius: 24,
        padding: 25,
        background: paper,
        color: ink,
        border: `1px solid ${interpolateColors(actionProgress, [0, 1], [line, "rgba(143,191,154,.52)"])}`,
        boxShadow: `0 32px ${interpolate(actionProgress, [0, 1], [90, 110])}px rgba(0,0,0,.26)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 19,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Check />
          <div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 850,
                letterSpacing: "-0.03em",
              }}
            >
              Content approval
            </div>
            <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
              Current revision ready for approval
            </div>
          </div>
        </div>
        <Chip tone="good">3 CHECKS</Chip>
      </div>
      <div
        style={{
          border: `1px solid ${line}`,
          borderRadius: 16,
          padding: 16,
          background: "#fff",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 13,
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <MiniAvatar initials="MC" color="#436b62" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>
              {placementStory.speaker}
            </div>
            <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
              {placementStory.title} · 25 min
            </div>
          </div>
          <div
            style={{ color: PALETTE.sageDeep, fontSize: 11, fontWeight: 850 }}
          >
            REVISION 4
          </div>
        </div>
        {[
          "Title and description",
          "Track, format and duration",
          "Exact revision selected",
        ].map((item, index) => {
          const checkProgress = ease(
            local(progress, 0.12 + index * 0.14, 0.34 + index * 0.14),
          );
          return (
            <div
              key={item}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "9px 0",
                borderTop: `1px solid ${line}`,
                color: interpolateColors(
                  checkProgress,
                  [0, 1],
                  ["#a9b1ad", muted],
                ),
                fontSize: 11,
                fontWeight: 700,
                opacity: interpolate(checkProgress, [0, 1], [0.25, 1]),
                transform: `translate3d(${interpolate(checkProgress, [0, 1], [16, 0])}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  opacity: checkProgress,
                  transform: `scale(${interpolate(checkProgress, [0, 1], [0.5, 1])})`,
                }}
              >
                <Check color={PALETTE.sageDeep} />
              </div>
              {item}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <MiniAvatar initials="JL" color={copper} />
          <span style={{ color: muted, fontSize: 11, fontWeight: 700 }}>
            Reviewer · Jordan Lee
          </span>
        </div>
        <div
          style={{
            padding: "11px 16px",
            borderRadius: 12,
            background: interpolateColors(
              actionProgress,
              [0, 1],
              ["rgba(143,191,154,.36)", sage],
            ),
            color: ink,
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: "0.05em",
            boxShadow: `0 10px ${interpolate(actionProgress, [0, 1], [0, 24])}px rgba(143,191,154,.24)`,
            transform: `scale(${interpolate(actionProgress, [0, 1], [0.98, 1.02])})`,
          }}
        >
          APPROVE CONTENT
        </div>
      </div>
    </div>
  );
}

function PublicationDiff({ progress }: { progress: number }) {
  const arrowProgress = ease(local(progress, 0.26, 0.5));
  const footerProgress = ease(local(progress, 0.72, 0.92));
  const cameraSettle = ease(local(progress, 0.04, 0.72));
  const sweepProgress = ease(local(progress, 0.14, 0.76));
  const sweepX = interpolate(sweepProgress, [0, 1], [-18, 116]);
  const before = [
    placementStory.title,
    placementStory.speaker,
    `${placementStory.conflictRoom} · ${placementStory.slot}`,
    placementStory.currentDescription,
  ];
  const after = [
    placementStory.title,
    placementStory.speaker,
    `${placementStory.placedRoom} · ${placementStory.slot}`,
    placementStory.draftDescription,
  ];
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        width: 1240,
        borderRadius: 25,
        padding: 30,
        background: paper,
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: `0 38px ${interpolate(cameraSettle, [0, 1], [118, 92])}px rgba(0,0,0,.34), 0 0 ${interpolate(sweepProgress, [0, 1], [0, 34])}px rgba(143,191,154,.08)`,
        transform: `perspective(1500px) rotateX(${interpolate(cameraSettle, [0, 1], [1.8, 0])}deg) rotateY(${interpolate(cameraSettle, [0, 1], [-1.4, 0])}deg)`,
        transformStyle: "preserve-3d",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -90,
          bottom: -90,
          left: `${sweepX}%`,
          width: 118,
          zIndex: 4,
          opacity: interpolate(
            sweepProgress,
            [0, 0.12, 0.86, 1],
            [0, 0.78, 0.46, 0],
          ),
          background:
            "linear-gradient(90deg, transparent, rgba(143,191,154,.13), rgba(255,255,255,.2), rgba(190,98,66,.08), transparent)",
          filter: "blur(2px)",
          transform: "skewX(-13deg)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <div
            style={{ fontSize: 22, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Publication diff
          </div>
          <div style={{ color: muted, fontSize: 12, marginTop: 5 }}>
            A readable summary of material schedule and session-content changes.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Chip tone="good">CONTENT REV 4 · APPROVED</Chip>
          <Chip tone="copper">4 CHANGES</Chip>
        </div>
      </div>
      <div
        style={{
          position: "relative",
          zIndex: 2,
          display: "grid",
          gridTemplateColumns: "1fr 64px 1fr",
          gap: 12,
          alignItems: "stretch",
          perspective: 1200,
        }}
      >
        <DiffColumn
          title="CURRENTLY PUBLISHED"
          rows={before}
          mutedRows={[2, 3]}
          progress={local(progress, 0.08, 0.66)}
        />
        <div
          style={{
            alignSelf: "start",
            display: "grid",
            height: 40,
            placeItems: "center",
            opacity: arrowProgress,
            transform: `scaleX(${arrowProgress})`,
            transformOrigin: "left center",
          }}
        >
          <Arrow color="#8d9691" />
        </div>
        <DiffColumn
          title="DRAFT TO PUBLISH"
          rows={after}
          highlight
          unchangedRows={[0, 1]}
          progress={local(progress, 0.28, 0.94)}
        />
      </div>
      <div
        style={{
          position: "relative",
          zIndex: 2,
          marginTop: 18,
          display: "flex",
          alignItems: "center",
          gap: 9,
          color: muted,
          fontSize: 11,
          fontWeight: 750,
          opacity: footerProgress,
          transform: `translateY(${interpolate(footerProgress, [0, 1], [8, 0])}px)`,
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: 2, background: sage }}
        />{" "}
        The current public programme remains unchanged until you confirm.
      </div>
    </div>
  );
}

function DiffColumn({
  title,
  rows,
  mutedRows = [],
  unchangedRows = [],
  highlight = false,
  progress,
}: {
  title: string;
  rows: string[];
  mutedRows?: number[];
  unchangedRows?: number[];
  highlight?: boolean;
  progress: number;
}) {
  const columnProgress = ease(local(progress, 0, 0.18));
  const highlightProgress = highlight ? ease(local(progress, 0.12, 0.82)) : 0;
  const depth = highlight
    ? interpolate(highlightProgress, [0, 1], [34, 4])
    : interpolate(columnProgress, [0, 1], [-12, 0]);
  const yaw = highlight
    ? interpolate(highlightProgress, [0, 1], [-3.8, 0])
    : interpolate(columnProgress, [0, 1], [2.4, 0]);
  return (
    <div
      style={{
        border: `1px solid ${interpolateColors(highlightProgress, [0, 1], [line, "rgba(143,191,154,.55)"])}`,
        borderRadius: 16,
        overflow: "hidden",
        background: interpolateColors(
          highlightProgress,
          [0, 1],
          ["#fbfbf8", "rgba(143,191,154,.07)"],
        ),
        opacity: interpolate(columnProgress, [0, 1], [0.32, 1]),
        boxShadow: highlight
          ? `0 18px ${interpolate(highlightProgress, [0, 1], [0, 34])}px rgba(72,111,81,.1)`
          : undefined,
        transform: `translate3d(${interpolate(columnProgress, [0, 1], [highlight ? 22 : -14, 0])}px, ${interpolate(columnProgress, [0, 1], [12, 0])}px, ${depth}px) rotateY(${yaw}deg)`,
        transformOrigin: highlight ? "left center" : "right center",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          color: highlight ? PALETTE.sageDeep : muted,
          background: highlight
            ? "rgba(143,191,154,.11)"
            : "rgba(24,37,34,.035)",
          borderBottom: `1px solid ${highlight ? "rgba(143,191,154,.35)" : line}`,
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: "0.11em",
        }}
      >
        {title}
      </div>
      {rows.map((row, index) => {
        const unchanged = unchangedRows.includes(index);
        const rowProgress = ease(
          local(progress, 0.08 + index * 0.16, 0.32 + index * 0.16),
        );
        return (
          <div
            key={row}
            style={{
              display: "flex",
              alignItems: "center",
              minHeight: 50,
              gap: 10,
              padding: "0 14px",
              borderBottom:
                index < rows.length - 1 ? `1px solid ${line}` : undefined,
              color: mutedRows.includes(index) ? "#a9b1ad" : ink,
              fontSize: 14,
              fontWeight: 700,
              textDecoration: mutedRows.includes(index)
                ? "line-through"
                : undefined,
              opacity: interpolate(rowProgress, [0, 1], [0.16, 1]),
              transform: `translate3d(${interpolate(rowProgress, [0, 1], [18, 0])}px, 0, 0)`,
            }}
          >
            <span
              style={{
                color: highlight && !unchanged ? PALETTE.sageDeep : muted,
                fontSize: 10,
                fontWeight: 900,
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            {row}
            <span
              style={{
                marginLeft: "auto",
                color: highlight && !unchanged ? PALETTE.sageDeep : "#b6beb9",
                fontSize: 14,
              }}
            >
              {highlight ? (unchanged ? "=" : "+") : "·"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ConfirmPublish({ progress }: { progress: number }) {
  const cursorTravel = ease(local(progress, 0.12, 0.58));
  const cursorOpacity =
    ease(local(progress, 0.08, 0.18)) * (1 - ease(local(progress, 0.86, 0.97)));
  const hoverProgress = ease(local(progress, 0.44, 0.62));
  const pressProgress = clamp(
    ease(local(progress, 0.64, 0.72)) - ease(local(progress, 0.72, 0.82)),
  );
  const completionProgress = ease(local(progress, 0.8, 0.96));
  const cardSettle = ease(local(progress, 0.04, 0.72));
  const lightSweep = ease(local(progress, 0.3, 0.78));
  const hoverBackground = interpolateColors(
    hoverProgress,
    [0, 1],
    [ink, copper],
  );
  return (
    <div
      style={{
        position: "relative",
        width: 600,
        transformStyle: "preserve-3d",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 10,
          borderRadius: 27,
          border: "1px solid rgba(143,191,154,.24)",
          background: "rgba(143,191,154,.08)",
          opacity: interpolate(cardSettle, [0, 1], [0.2, 0.85]),
          transform: `translate3d(${interpolate(cardSettle, [0, 1], [30, 18])}px, ${interpolate(cardSettle, [0, 1], [26, 16])}px, -28px) rotate(${interpolate(cardSettle, [0, 1], [2.2, 1])}deg)`,
          boxShadow: "0 30px 80px rgba(0,0,0,.2)",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 2,
          width: 600,
          overflow: "hidden",
          borderRadius: 25,
          padding: 30,
          background: paper,
          color: ink,
          border: `1px solid ${interpolateColors(completionProgress, [0, 1], [line, "rgba(143,191,154,.6)"])}`,
          boxShadow: `0 36px ${interpolate(cardSettle, [0, 1], [132, 104])}px rgba(0,0,0,.4), 0 0 ${interpolate(completionProgress, [0, 1], [0, 38])}px rgba(143,191,154,.14)`,
          transform: `perspective(1350px) translateZ(${interpolate(cardSettle, [0, 1], [18, 0])}px) rotateX(${interpolate(cardSettle, [0, 1], [1.8, 0])}deg) rotateY(${interpolate(cardSettle, [0, 1], [2.8, 0])}deg)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -70,
            bottom: -70,
            left: `${interpolate(lightSweep, [0, 1], [-24, 122])}%`,
            width: 96,
            zIndex: 5,
            opacity: interpolate(
              lightSweep,
              [0, 0.1, 0.9, 1],
              [0, 0.66, 0.42, 0],
            ),
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,.24), rgba(143,191,154,.1), transparent)",
            transform: "skewX(-14deg)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
          }}
        >
          <Chip tone="good">READY TO PUBLISH</Chip>
          <span style={{ color: muted, fontSize: 11, fontWeight: 800 }}>
            REVISION 4
          </span>
        </div>
        <div
          style={{
            fontSize: 31,
            fontWeight: 880,
            letterSpacing: "-0.055em",
            lineHeight: 1.05,
          }}
        >
          Publish this schedule
          <br />
          version?
        </div>
        <div
          style={{
            color: muted,
            fontSize: 13,
            lineHeight: 1.55,
            marginTop: 14,
            maxWidth: 460,
          }}
        >
          This approved schedule version is ready to become the new public
          programme.
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 18,
            padding: "12px 14px",
            borderRadius: 14,
            border: `1px solid ${line}`,
            background: "rgba(24,37,34,.025)",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 850 }}>
              {placementStory.title}
            </div>
            <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
              {placementStory.speaker} · {placementStory.placedRoom} ·{" "}
              {placementStory.slot}
            </div>
          </div>
          <Chip tone="good">CONTENT REV 4 APPROVED</Chip>
        </div>
        <div
          style={{
            display: "flex",
            gap: 9,
            alignItems: "center",
            marginTop: 23,
            padding: "12px 14px",
            borderRadius: 14,
            background: "rgba(143,191,154,.12)",
            border: "1px solid rgba(143,191,154,.3)",
            color: PALETTE.sageDeep,
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          <span style={{ fontSize: 15 }}>✓</span> One final check keeps
          conflicts, content, speakers and every public view aligned.
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            marginTop: 24,
          }}
        >
          <div style={{ color: muted, fontSize: 12, fontWeight: 750 }}>
            Cancel
          </div>
          <div
            style={{
              padding: "13px 20px",
              borderRadius: 12,
              background: interpolateColors(
                completionProgress,
                [0, 1],
                [hoverBackground, PALETTE.sageDeep],
              ),
              color: paper,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: "0.07em",
              boxShadow: `0 12px ${interpolate(hoverProgress, [0, 1], [0, 28])}px rgba(190,98,66,.28)`,
              transform: `scale(${1 - pressProgress * 0.035}) translateY(${interpolate(hoverProgress, [0, 1], [0, -2])}px)`,
            }}
          >
            CONFIRM &amp; PUBLISH ↗
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: interpolate(cursorTravel, [0, 1], [630, 522]),
            top: interpolate(cursorTravel, [0, 1], [250, 390]),
            zIndex: 6,
            opacity: cursorOpacity,
            transform: `translate3d(0, ${Math.sin(progress * Math.PI * 5) * 1.5}px, 0) rotate(-9deg) scale(${interpolate(pressProgress, [0, 1], [1, 0.88])})`,
            filter: "drop-shadow(0 3px 4px rgba(0,0,0,.28))",
          }}
        >
          <div
            style={{
              width: 20,
              height: 27,
              background: deep,
              clipPath: "polygon(0 0, 100% 67%, 60% 71%, 49% 100%)",
            }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 524,
            top: 393,
            width: 48,
            height: 48,
            borderRadius: "50%",
            border: "2px solid rgba(190,98,66,.58)",
            opacity: pressProgress,
            transform: `translate(-50%, -50%) scale(${interpolate(pressProgress, [0, 1], [0.4, 1.5])})`,
            boxShadow: "0 0 30px rgba(190,98,66,.2)",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}

function PublishedPages({ progress }: { progress: number }) {
  const heroSettle = ease(local(progress, 0.02, 0.56));
  const hold = ease(local(progress, 0.64, 0.82));
  const badgeFloat = Math.sin(progress * Math.PI * 2) * 3 * (1 - hold);
  const recordReveal = ease(local(progress, 0.02, 0.42));
  const mobileReveal = ease(local(progress, 0.12, 0.58));
  const sweep = ease(local(progress, 0.1, 0.62));
  return (
    <div
      style={{
        position: "relative",
        width: 1680,
        height: 650,
        transformStyle: "preserve-3d",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 360,
          right: -100,
          top: -110,
          bottom: -70,
          opacity: interpolate(heroSettle, [0, 1], [0.22, 1]),
          background:
            "radial-gradient(circle at 68% 46%, rgba(143,191,154,.18), transparent 38%), radial-gradient(circle at 82% 58%, rgba(190,98,66,.18), transparent 45%)",
          filter: `blur(${interpolate(heroSettle, [0, 1], [14, 0])}px)`,
          transform: `scale(${interpolate(heroSettle, [0, 1], [0.92, 1.04])})`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -80,
          bottom: -60,
          left: `${interpolate(sweep, [0, 1], [28, 102])}%`,
          width: 160,
          zIndex: 4,
          opacity: interpolate(sweep, [0, 0.08, 0.9, 1], [0, 0.58, 0.28, 0]),
          background:
            "linear-gradient(90deg, transparent, rgba(255,253,248,.11), rgba(143,191,154,.12), transparent)",
          filter: "blur(3px)",
          transform: "skewX(-12deg)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 72,
          width: 520,
          zIndex: 3,
          opacity: interpolate(heroSettle, [0, 1], [0.34, 1]),
          transform: `translate3d(${interpolate(heroSettle, [0, 1], [-24, 0])}px, ${interpolate(heroSettle, [0, 1], [18, 0])}px, 36px)`,
        }}
      >
        <Eyebrow tone="sage" dark>
          Published programme
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 42,
            lineHeight: 1.03,
            fontWeight: 860,
            letterSpacing: "-0.06em",
            marginTop: 18,
          }}
        >
          Publish once. Keep every
          <br />
          attendee view in step.
        </div>
        <div style={{ display: "flex", gap: 24, marginTop: 32 }}>
          <Metric dark value="1" label="schedule version" tone="sage" />
          <Metric dark value="APPROVED" label="public content" tone="copper" />
          <Metric dark value="LOGGED" label="publication event" />
        </div>
        <div
          style={{
            marginTop: 28,
            padding: "13px 15px",
            borderRadius: 14,
            border: "1px solid rgba(143,191,154,.28)",
            background: "rgba(143,191,154,.08)",
          }}
        >
          <div
            style={{
              color: sage,
              fontSize: 9,
              fontWeight: 900,
              letterSpacing: "0.12em",
            }}
          >
            SAME RECORD · PUBLIC READ
          </div>
          <div
            style={{
              color: paper,
              fontSize: 14,
              fontWeight: 850,
              marginTop: 6,
            }}
          >
            {placementStory.title}
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.58)",
              fontSize: 11,
              marginTop: 4,
            }}
          >
            {placementStory.speaker} · {placementStory.placedRoom} ·{" "}
            {placementStory.slot}
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 18,
          top: 0,
          zIndex: 2,
          width: 684,
          height: 470,
          transformOrigin: "top right",
          transform: `perspective(1600px) translate3d(${interpolate(heroSettle, [0, 1], [72, 0])}px, ${interpolate(heroSettle, [0, 1], [26, 0])}px, 0) rotateY(${interpolate(heroSettle, [0, 1], [-4.2, 0])}deg) scale(1.4)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 612,
            height: 424,
            overflow: "hidden",
            borderRadius: 22,
            border: "1px solid rgba(24,37,34,.2)",
            background: paper,
            boxShadow: "0 34px 90px rgba(0,0,0,.32)",
            opacity: interpolate(recordReveal, [0, 1], [0.38, 1]),
            transform: `translate3d(${interpolate(recordReveal, [0, 1], [24, -5])}px, ${interpolate(recordReveal, [0, 1], [12, -3])}px, 0) rotate(${interpolate(recordReveal, [0, 1], [1.5, 0.7])}deg)`,
          }}
        >
          <div
            style={{
              height: 39,
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 14px",
              borderBottom: `1px solid ${line}`,
              background: "#f4f1eb",
            }}
          >
            {["#ef8f78", "#e5b94a", "#83b98d"].map((color) => (
              <span
                key={color}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: color,
                }}
              />
            ))}
            <span
              style={{
                marginLeft: 7,
                color: muted,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.08em",
              }}
            >
              FUTURE OF EVENTS 2027 / PROGRAMME
            </span>
            <span
              style={{
                marginLeft: "auto",
                color: PALETTE.sageDeep,
                fontSize: 9,
                fontWeight: 900,
                letterSpacing: "0.08em",
              }}
            >
              PUBLISHED
            </span>
          </div>
          <div
            style={{
              padding: "17px 20px 16px",
              background: deep,
              color: paper,
            }}
          >
            <div
              style={{
                color: sage,
                fontSize: 9,
                fontWeight: 900,
                letterSpacing: "0.12em",
              }}
            >
              THURSDAY · 10:30 · {placementStory.placedRoom.toUpperCase()}
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: 27,
                fontWeight: 870,
                letterSpacing: "-0.045em",
              }}
            >
              {placementStory.title}
            </div>
          </div>
          <div style={{ padding: "18px 20px 18px 142px", color: ink }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <MiniAvatar initials="MC" color="#436b62" />
              <div>
                <div style={{ fontSize: 14, fontWeight: 850 }}>
                  {placementStory.speaker}
                </div>
                <div style={{ color: muted, fontSize: 10, marginTop: 2 }}>
                  Speaker · Cities &amp; communities
                </div>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <Chip tone="good">CONTENT REV 4</Chip>
              </div>
            </div>
            <div style={{ height: 1, background: line, margin: "15px 0" }} />
            <div
              style={{
                color: muted,
                fontSize: 9,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              SESSION DESCRIPTION
            </div>
            <div
              style={{
                marginTop: 7,
                color: ink,
                fontSize: 14,
                lineHeight: 1.45,
                fontWeight: 720,
              }}
            >
              Care at neighbourhood scale
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginTop: 17,
                color: muted,
                fontSize: 10,
                fontWeight: 750,
              }}
            >
              Published schedule snapshot
              <span style={{ marginLeft: "auto", color: PALETTE.sageDeep }}>
                VIEW SESSION ↗
              </span>
            </div>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: 184,
            height: 332,
            overflow: "hidden",
            borderRadius: 25,
            border: "5px solid #f7f3ec",
            background: paper,
            boxShadow: "0 26px 60px rgba(0,0,0,.34)",
            opacity: mobileReveal,
            transform: `translate3d(${interpolate(mobileReveal, [0, 1], [-24, 7])}px, ${interpolate(mobileReveal, [0, 1], [12, -5])}px, 0) rotate(${interpolate(mobileReveal, [0, 1], [-4.4, -2.4])}deg)`,
          }}
        >
          <div
            style={{
              height: 25,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#f4f1eb",
            }}
          >
            <span
              style={{
                width: 42,
                height: 4,
                borderRadius: 99,
                background: "rgba(24,37,34,.2)",
              }}
            />
          </div>
          <div style={{ padding: "15px 13px", background: deep, color: paper }}>
            <div style={{ color: sage, fontSize: 7, fontWeight: 900 }}>
              THU · 10:30
            </div>
            <div
              style={{
                marginTop: 7,
                fontSize: 19,
                lineHeight: 1.02,
                fontWeight: 860,
                letterSpacing: "-0.045em",
              }}
            >
              Future of
              <br />
              urban care
            </div>
          </div>
          <div style={{ padding: "14px 13px", color: ink }}>
            <div style={{ fontSize: 11, fontWeight: 850 }}>Maya Chen</div>
            <div style={{ color: muted, fontSize: 9, marginTop: 4 }}>
              Studio B · 25 min
            </div>
            <div style={{ height: 1, background: line, margin: "13px 0" }} />
            <div style={{ color: muted, fontSize: 8, lineHeight: 1.45 }}>
              Care at neighbourhood scale
            </div>
            <div
              style={{
                marginTop: 17,
                padding: "9px 10px",
                borderRadius: 9,
                background: sage,
                color: ink,
                textAlign: "center",
                fontSize: 8,
                fontWeight: 900,
                letterSpacing: "0.08em",
              }}
            >
              VIEW SESSION
            </div>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 22,
            bottom: 4,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "9px 12px",
            borderRadius: 999,
            color: ink,
            background: sage,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: "0.08em",
            boxShadow: "0 12px 26px rgba(0,0,0,.25)",
            transform: `translate3d(0, ${badgeFloat}px, 0)`,
          }}
        >
          <StatusDot /> PUBLISHED SNAPSHOT
        </div>
      </div>
    </div>
  );
}

function PlaceShotLayer({
  children,
  end,
  progress,
  start,
  zIndex,
}: {
  children: ReactNode;
  end: number;
  progress: number;
  start: number;
  zIndex: number;
}) {
  const active =
    progress >= Math.max(0, start - PLACE_TRANSITION_HALF) &&
    progress <= Math.min(1, end + PLACE_TRANSITION_HALF);
  if (!active) {
    return null;
  }

  const entrance =
    start === 0
      ? 1
      : Easing.inOut(Easing.cubic)(
          local(
            progress,
            start - PLACE_TRANSITION_HALF,
            start + PLACE_TRANSITION_HALF,
          ),
        );
  const departure =
    end === 1
      ? 0
      : Easing.inOut(Easing.cubic)(
          local(
            progress,
            end - PLACE_TRANSITION_HALF,
            end + PLACE_TRANSITION_HALF,
          ),
        );
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        zIndex,
        clipPath: `inset(0 ${(1 - entrance) * 100}% 0 ${departure * 100}%)`,
      }}
    >
      {children}
    </div>
  );
}

function PlaceCueSeam({ progress }: { progress: number }) {
  const boundaries = [0.13, 0.3, 0.47, 0.64, 0.8, 0.92];
  return (
    <>
      {boundaries.map((boundary) => {
        const start = boundary - PLACE_TRANSITION_HALF;
        const end = boundary + PLACE_TRANSITION_HALF;
        const active = progress >= start && progress <= end;
        const phase = Easing.inOut(Easing.cubic)(local(progress, start, end));
        const pulse = active ? Math.sin(phase * Math.PI) : 0;
        const x = interpolate(phase, [0, 1], [-3, 1923]);
        return (
          <div
            key={boundary}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 24,
              opacity: active ? 1 : 0,
              overflow: "hidden",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: x,
                top: 108,
                bottom: 38,
                width: 3,
                background: sage,
                boxShadow:
                  "-10px 0 28px rgba(11,20,19,.2), 10px 0 28px rgba(143,191,154,.3)",
                transform: "translateX(-50%)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: x,
                top: 531,
                width: 13,
                height: 13,
                borderRadius: "50%",
                border: "2px solid rgba(255,253,248,.86)",
                background: copper,
                boxShadow: `0 0 ${interpolate(pulse, [0, 1], [8, 24])}px rgba(190,98,66,.48)`,
                transform: "translateX(-50%)",
              }}
            />
          </div>
        );
      })}
    </>
  );
}

export function PlaceScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = frameProgress(frame, duration);
  const introProgress = local(progress, 0, 0.13);
  const conflictProgress = local(progress, 0.13, 0.3);
  const resolutionProgress = local(progress, 0.3, 0.47);
  const approvalProgress = local(progress, 0.47, 0.64);
  const diffProgress = local(progress, 0.64, 0.8);
  const confirmProgress = local(progress, 0.8, 0.92);
  const publishedProgress = local(progress, 0.92, 1);
  const diffCamera = ease(local(diffProgress, 0.02, 0.72));
  const confirmCamera = ease(local(confirmProgress, 0.02, 0.68));
  const publishedCamera = ease(local(publishedProgress, 0.02, 0.54));
  return (
    <AbsoluteFill
      style={{
        background: deep,
        overflow: "hidden",
        fontFamily: "Program Cue Inter, Inter, sans-serif",
      }}
    >
      <DotGrid opacity={0.3} />
      <div
        style={{
          position: "absolute",
          inset: -36,
          background:
            "radial-gradient(circle at 86% 48%, rgba(190,98,66,.22), transparent 31%), radial-gradient(circle at 5% 78%, rgba(143,191,154,.1), transparent 30%)",
          transform: `translate3d(${interpolate(progress, [0, 1], [-16, 18])}px, ${interpolate(progress, [0, 1], [8, -10])}px, 0) scale(1.035)`,
        }}
      />
      <SceneHeader
        chapter="PROGRAMME SCHEDULING"
        index="10 / 13 · PLACE"
        progress={progress}
      />
      <div
        style={{
          position: "absolute",
          left: 76,
          top: 108,
          zIndex: 41,
          padding: "8px 11px",
          border: "1px solid rgba(255,253,248,.18)",
          borderRadius: 999,
          background: "rgba(11,20,19,.72)",
          color: "rgba(255,253,248,.72)",
          fontSize: 9,
          fontWeight: 850,
          letterSpacing: "0.12em",
        }}
      >
        CONFLICT-AWARE AUTO-PLACEMENT
      </div>
      <PlaceShotLayer end={0.13} progress={progress} start={0} zIndex={6}>
        <Reveal
          amount={1}
          style={{
            position: "absolute",
            left: 118,
            top: 222,
            width: 650,
            zIndex: 6,
            transform: `translate3d(${interpolate(introProgress, [0, 1], [9, -13])}px, ${interpolate(introProgress, [0, 1], [8, -6])}px, 0) scale(${interpolate(introProgress, [0, 1], [1.012, 1.028])})`,
          }}
        >
          <Eyebrow dark>Place</Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 84,
              lineHeight: 0.96,
              fontWeight: 880,
              letterSpacing: "-0.075em",
              marginTop: 20,
            }}
          >
            Build a schedule
            <br />
            <span style={{ color: copper }}>that works.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 17,
              lineHeight: 1.5,
              maxWidth: 450,
              marginTop: 25,
            }}
          >
            Catch conflicts, preview valid placements and publish one confident
            schedule.
          </div>
        </Reveal>
        <Reveal
          amount={1}
          x={40}
          y={35}
          style={{
            position: "absolute",
            right: 111,
            top: 184,
            zIndex: 4,
            transform: `translate3d(${interpolate(introProgress, [0, 1], [20, -12])}px, ${interpolate(introProgress, [0, 1], [12, -8])}px, 0) rotate(${interpolate(introProgress, [0, 1], [2.3, 1.5])}deg) scale(${interpolate(introProgress, [0, 1], [1.035, 1.012])})`,
          }}
        >
          <AssetWindow
            src={ASSETS.schedulePlanner}
            label="SCHEDULE PLANNER"
            caption="draft workspace"
            width={770}
            height={560}
            objectPosition="center top"
            dark
          />
          <div
            style={{
              position: "absolute",
              left: -40,
              bottom: 30,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 14px",
              border: "1px solid rgba(255,255,255,.16)",
              borderRadius: 13,
              background: "rgba(11,20,19,.82)",
              color: paper,
              fontSize: 11,
              fontWeight: 800,
              backdropFilter: "blur(14px)",
              transform: `translate3d(0, ${Math.sin(introProgress * Math.PI * 2) * 3}px, 0)`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: copper,
                boxShadow: `0 0 0 5px ${copper}22`,
              }}
            />{" "}
            01 / detect conflicts
          </div>
        </Reveal>
      </PlaceShotLayer>
      <PlaceShotLayer end={0.3} progress={progress} start={0.13} zIndex={10}>
        <div
          style={{
            position: "absolute",
            left: 116,
            top: 165,
            width: 420,
            transform: `translate3d(${interpolate(conflictProgress, [0, 1], [8, -12])}px, ${interpolate(conflictProgress, [0, 1], [4, -7])}px, 0)`,
          }}
        >
          <Eyebrow tone="copper" dark>
            01 · Detect
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 52,
              fontWeight: 860,
              lineHeight: 1,
              letterSpacing: "-0.06em",
              marginTop: 16,
            }}
          >
            Catch collisions
            <br />
            before attendees
            <br />
            do.
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 340,
            }}
          >
            See the rule, affected sessions and next best action in one clear
            view.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 116,
            top: 174,
            transform: `translate3d(${interpolate(conflictProgress, [0, 1], [18, -9])}px, ${interpolate(conflictProgress, [0, 1], [9, -5])}px, 0) scale(${interpolate(conflictProgress, [0, 1], [1.018, 1.032])})`,
          }}
        >
          <PlaceConflictCard progress={conflictProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceShotLayer end={0.47} progress={progress} start={0.3} zIndex={12}>
        <div
          style={{
            position: "absolute",
            right: 116,
            top: 170,
            width: 430,
            transform: `translate3d(${interpolate(resolutionProgress, [0, 1], [10, -11])}px, ${interpolate(resolutionProgress, [0, 1], [5, -6])}px, 0)`,
          }}
        >
          <Eyebrow tone="copper" dark>
            02 · Auto-place
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 52,
              fontWeight: 860,
              lineHeight: 1,
              letterSpacing: "-0.06em",
              marginTop: 16,
            }}
          >
            Turn constraints
            <br />
            into valid options.
            <br />
            <span style={{ color: sage }}>You choose the move.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 350,
            }}
          >
            The planner checks room, speaker, resource, track and capacity rules
            before you apply selected placements to the draft.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 28,
              color: sage,
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.1em",
            }}
          >
            <Check /> VALID OPTIONS · YOU CHOOSE
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 116,
            top: 190,
            transform: `translate3d(${interpolate(resolutionProgress, [0, 1], [20, -10])}px, ${interpolate(resolutionProgress, [0, 1], [8, -6])}px, 0) scale(${interpolate(resolutionProgress, [0, 1], [1.02, 1.034])})`,
          }}
        >
          <AutoPlacementCard progress={resolutionProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceShotLayer end={0.64} progress={progress} start={0.47} zIndex={14}>
        <div
          style={{
            position: "absolute",
            left: 116,
            top: 182,
            width: 410,
            transform: `translate3d(${interpolate(approvalProgress, [0, 1], [8, -12])}px, ${interpolate(approvalProgress, [0, 1], [5, -7])}px, 0)`,
          }}
        >
          <Eyebrow tone="sage" dark>
            03 · Approve
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 52,
              fontWeight: 860,
              lineHeight: 1,
              letterSpacing: "-0.06em",
              marginTop: 16,
            }}
          >
            Bring every public
            <br />
            <span style={{ color: sage }}>detail together.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 350,
            }}
          >
            Shape the public content while speaker readiness and conflicts stay
            visible.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 116,
            top: 184,
            transform: `translate3d(${interpolate(approvalProgress, [0, 1], [17, -9])}px, ${interpolate(approvalProgress, [0, 1], [8, -5])}px, 0) scale(${interpolate(approvalProgress, [0, 1], [1.018, 1.032])})`,
          }}
        >
          <ApprovalCard progress={approvalProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceShotLayer end={0.8} progress={progress} start={0.64} zIndex={16}>
        <div
          style={{
            position: "absolute",
            left: 220,
            right: 220,
            top: 142,
            textAlign: "center",
            transform: `translate3d(0, ${interpolate(diffCamera, [0, 1], [16, 0])}px, 0) scale(${interpolate(diffCamera, [0, 1], [0.972, 1])})`,
          }}
        >
          <Eyebrow tone="copper" dark>
            04 · Compare
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 62,
              fontWeight: 860,
              lineHeight: 1,
              letterSpacing: "-0.06em",
              marginTop: 16,
            }}
          >
            See exactly <span style={{ color: copper }}>what will change.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 15,
              lineHeight: 1.45,
              marginTop: 18,
              marginLeft: "auto",
              marginRight: "auto",
              maxWidth: 680,
            }}
          >
            Compare additions, removals, moves, visibility and content changes
            before going live.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 310,
            top: 382,
            transformOrigin: "center top",
            transform: `perspective(1500px) translate3d(${interpolate(diffCamera, [0, 1], [46, 0])}px, ${interpolate(diffCamera, [0, 1], [30, 0])}px, 0) rotateX(${interpolate(diffCamera, [0, 1], [2.4, 0])}deg) rotateY(${interpolate(diffCamera, [0, 1], [-3.2, 0])}deg) scale(${interpolate(diffCamera, [0, 1], [0.93, 1])})`,
          }}
        >
          <PublicationDiff progress={diffProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceShotLayer end={0.92} progress={progress} start={0.8} zIndex={18}>
        <div
          style={{
            position: "absolute",
            left: 116,
            top: 210,
            width: 430,
            transform: `translate3d(${interpolate(confirmCamera, [0, 1], [-28, 0])}px, ${interpolate(confirmCamera, [0, 1], [14, 0])}px, 0)`,
          }}
        >
          <Eyebrow tone="copper" dark>
            05 · Confirm
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 54,
              fontWeight: 860,
              lineHeight: 0.98,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Publish with
            <br />
            <span style={{ color: copper }}>confidence.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.58)",
              fontSize: 15,
              lineHeight: 1.48,
              marginTop: 20,
              maxWidth: 340,
            }}
          >
            One final check revalidates every dependency before the schedule
            goes live.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 200,
            top: 206,
            transformOrigin: "center center",
            transform: `perspective(1400px) translate3d(${interpolate(confirmCamera, [0, 1], [58, 0])}px, ${interpolate(confirmCamera, [0, 1], [24, 0])}px, 0) rotateY(${interpolate(confirmCamera, [0, 1], [-4.5, 0])}deg) scale(${interpolate(confirmCamera, [0, 1], [0.92, 1])})`,
          }}
        >
          <ConfirmPublish progress={confirmProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceShotLayer end={1} progress={progress} start={0.92} zIndex={20}>
        <div
          style={{
            position: "absolute",
            left: 84,
            top: 158,
            transform: `translate3d(${interpolate(publishedCamera, [0, 1], [34, 0])}px, ${interpolate(publishedCamera, [0, 1], [18, 0])}px, 0) scale(${interpolate(publishedCamera, [0, 1], [0.965, 1])})`,
          }}
        >
          <PublishedPages progress={publishedProgress} />
        </div>
      </PlaceShotLayer>
      <PlaceCueSeam progress={progress} />
      <FooterRail
        activationPoints={[0.13, 0.3, 0.47, 0.64, 0.8]}
        progress={progress}
        items={["detect", "auto-place", "approve", "compare", "confirm"]}
      />
    </AbsoluteFill>
  );
}

function SurfaceBadge({
  children,
  activity = 0,
}: {
  children: ReactNode;
  activity?: number;
}) {
  const active = clamp(activity);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderRadius: 11,
        border: `1px solid ${interpolateColors(active, [0, 1], ["rgba(24,37,34,.13)", "rgba(190,98,66,.38)"])}`,
        background: interpolateColors(
          active,
          [0, 1],
          ["rgba(255,255,255,.7)", "rgba(190,98,66,.1)"],
        ),
        color: interpolateColors(active, [0, 1], [muted, copperText]),
        fontSize: 10,
        fontWeight: 850,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        transform: `translate3d(0, ${interpolate(active, [0, 1], [0, -2])}px, 0)`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 2,
          background: interpolateColors(active, [0, 1], ["#a9b2ae", copper]),
        }}
      />
      {children}
    </div>
  );
}

function PublishScrollRail({
  progress,
  height,
  dark = false,
}: {
  progress: number;
  height: number;
  dark?: boolean;
}) {
  const thumbTravel = Math.max(0, height - 56);
  return (
    <div
      style={{
        position: "absolute",
        right: 13,
        top: 62,
        width: 18,
        height,
        zIndex: 6,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 1,
          top: 0,
          bottom: 0,
          width: 3,
          borderRadius: 99,
          background: dark ? "rgba(255,253,248,.2)" : "rgba(24,37,34,.14)",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: 5,
          height: 56,
          borderRadius: 99,
          background: dark ? sage : copper,
          boxShadow: dark
            ? "0 6px 18px rgba(143,191,154,.42)"
            : "0 6px 18px rgba(190,98,66,.3)",
          transform: `translate3d(0, ${interpolate(progress, [0, 1], [0, thumbTravel])}px, 0)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 8,
          bottom: 0,
          color: dark ? "rgba(255,253,248,.58)" : muted,
          fontSize: 7,
          fontWeight: 900,
          letterSpacing: "0.12em",
          writingMode: "vertical-rl",
        }}
      >
        PUBLIC VIEW
      </div>
    </div>
  );
}

function PublishSurfaceLayer({
  active,
  children,
  left,
  maskDirection = "incoming",
  maskProgress,
  progress,
  top,
  zIndex,
}: {
  active: boolean;
  children: ReactNode;
  left: number;
  maskDirection?: "incoming" | "outgoing";
  maskProgress?: number;
  progress: number;
  top: number;
  zIndex: number;
}) {
  if (!active) {
    return null;
  }

  const entrance = ease(local(progress, 0, 0.075));
  const mask = maskProgress === undefined ? undefined : clamp(maskProgress);
  const maskStarted = mask !== undefined && mask > 0.001;
  const maskSettled = mask !== undefined && mask >= 0.999;
  const maskInFlight = maskStarted && !maskSettled;
  const maskHidden =
    mask !== undefined &&
    ((maskDirection === "incoming" && !maskStarted) ||
      (maskDirection === "outgoing" && maskSettled));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        zIndex,
        opacity: maskHidden ? 0 : 1,
        clipPath:
          !maskInFlight || mask === undefined
            ? undefined
            : maskDirection === "incoming"
              ? `inset(0 ${interpolate(mask, [0, 1], [100, 0])}% 0 0)`
              : `inset(0 0 0 ${interpolate(mask, [0, 1], [0, 100])}%)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left,
          top,
          opacity: interpolate(entrance, [0, 1], [0.84, 1]),
          transform: `translate3d(${interpolate(entrance, [0, 1], [12, 0])}px, ${interpolate(entrance, [0, 1], [5, 0])}px, 0)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function PublishMap({ progress }: { progress: number }) {
  const surfacePosition = interpolate(progress, [0, 1], [0, 6]);
  const surfaces = [
    "Programme",
    "Timetable",
    "Day by day",
    "Speakers",
    "Itinerary",
    "Embeds",
    "Event site",
  ];
  return (
    <div
      style={{
        width: 590,
        padding: 25,
        borderRadius: 24,
        background: "rgba(255,253,248,.97)",
        border: `1px solid ${line}`,
        color: ink,
        boxShadow: "0 28px 90px rgba(0,0,0,.24)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 19,
        }}
      >
        <div>
          <div
            style={{ fontSize: 21, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Published programme data
          </div>
          <div style={{ color: muted, fontSize: 11, marginTop: 4 }}>
            Seven public views draw on the published programme; the event site
            adds separately published content.
          </div>
        </div>
        <Chip tone="good">7 PUBLIC VIEWS</Chip>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
        {surfaces.map((surface, index) => (
          <SurfaceBadge
            key={surface}
            activity={clamp(1 - Math.abs(index - surfacePosition))}
          >
            {surface}
          </SurfaceBadge>
        ))}
      </div>
      <div
        style={{
          position: "relative",
          height: 195,
          marginTop: 22,
          borderRadius: 16,
          background: "#f1f2ec",
          overflow: "hidden",
          border: `1px solid ${line}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 38,
            right: 38,
            top: 98,
            height: 1,
            background: "rgba(24,37,34,.2)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 38,
            width: "calc(100% - 76px)",
            top: 97,
            height: 3,
            borderRadius: 99,
            background:
              "linear-gradient(90deg, rgba(190,98,66,.88), rgba(143,191,154,.9))",
            transform: `scaleX(${progress})`,
            transformOrigin: "left center",
          }}
        />
        {["01", "02", "03", "04", "05", "06", "07"].map((item, index) => (
          <div key={item}>
            <div
              style={{
                position: "absolute",
                left: `${9 + index * 13.7}%`,
                top: 83,
                display: "grid",
                placeItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 31,
                  height: 31,
                  borderRadius: 10,
                  display: "grid",
                  placeItems: "center",
                  background: interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [paper, copper],
                  ),
                  color: interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [ink, paper],
                  ),
                  border: `1px solid ${interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [line, copper],
                  )}`,
                  fontSize: 10,
                  fontWeight: 900,
                  boxShadow: "0 7px 14px rgba(24,37,34,.1)",
                  transform: `translate3d(0, ${interpolate(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [0, -5],
                  )}px, 0)`,
                }}
              >
                {item}
              </div>
            </div>
          </div>
        ))}
        <div
          style={{
            position: "absolute",
            top: 25,
            left: 38,
            color: muted,
            fontSize: 9,
            fontWeight: 850,
            letterSpacing: "0.12em",
          }}
        >
          PUBLISHED PROGRAMME DATA
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 24,
            right: 38,
            color: PALETTE.sageDeep,
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          PUBLIC VIEWS FROM PUBLISHED DATA ↗
        </div>
      </div>
    </div>
  );
}

function PublishHero({ progress }: { progress: number }) {
  const adminDrift = interpolate(progress, [0, 1], [-10, 12]);
  const mapDrift = interpolate(progress, [0, 1], [7, -9]);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 80, width: 1540 }}
    >
      <div style={{ width: 700 }}>
        <Eyebrow tone="copper">Publish</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 84,
            lineHeight: 0.96,
            fontWeight: 880,
            letterSpacing: "-0.08em",
            marginTop: 20,
          }}
        >
          One programme.
          <br />
          <span style={{ color: copper }}>Every public view.</span>
        </div>
        <div
          style={{
            color: muted,
            fontSize: 17,
            lineHeight: 1.5,
            maxWidth: 500,
            marginTop: 25,
          }}
        >
          Programme, timetable, speakers, itineraries and embeds share one
          connected published source.
        </div>
        <div style={{ display: "flex", gap: 28, marginTop: 34 }}>
          <Metric value="07" label="surfaces shown" tone="copper" />
          <Metric value="01" label="published revision" />
          <Metric value="VERSIONED" label="public views" tone="sage" />
        </div>
      </div>
      <div
        style={{
          position: "relative",
          transform: `translate3d(${adminDrift}px, ${interpolate(progress, [0, 1], [-4, 5])}px, 0)`,
        }}
      >
        <div
          style={{
            transform: `scale(${interpolate(progress, [0, 1], [1.008, 1.022])})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.programmeAdmin}
            label="PROGRAMME ADMIN"
            caption="programme data"
            width={710}
            height={520}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 9])}%`}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: -28,
            bottom: -22,
            transform: `translate3d(${-adminDrift * 0.35}px, ${mapDrift}px, 0)`,
          }}
        >
          <PublishMap progress={progress} />
        </div>
      </div>
    </div>
  );
}

function ProgrammeSurface({ progress }: { progress: number }) {
  const viewportDrift = interpolate(progress, [0, 1], [8, -10]);
  const scrollPosition = interpolate(progress, [0, 1], [0, 12]);
  return (
    <div
      style={{ width: 1640, display: "flex", alignItems: "center", gap: 34 }}
    >
      <div style={{ width: 366 }}>
        <Eyebrow tone="copper">01 · Programme + timetable</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 52,
            lineHeight: 1,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Help attendees find
          <br />
          the right session,
          <br />
          fast.
        </div>
        <div
          style={{ color: muted, fontSize: 14, lineHeight: 1.5, marginTop: 19 }}
        >
          The public programme supports session discovery and provides direct
          timetable access.
        </div>
        <div
          style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 23 }}
        >
          <Chip tone="good">responsive</Chip>
          <Chip tone="neutral">searchable</Chip>
          <Chip tone="neutral">accessibility-tested</Chip>
        </div>
      </div>
      <div
        style={{
          width: 1240,
          height: 650,
          position: "relative",
          transform: `translate3d(0, ${viewportDrift}px, 0) scale(${interpolate(
            progress,
            [0, 1],
            [1.004, 1.014],
          )})`,
          transformOrigin: "center center",
        }}
      >
        <AssetWindow
          src={ASSETS.publicProgramme}
          label="PUBLIC PROGRAMME"
          caption="/programme"
          width={1240}
          height={650}
          objectPosition={`center ${scrollPosition}%`}
        />
        <PublishScrollRail progress={progress} height={556} />
      </div>
    </div>
  );
}

function DayByDaySurface({ progress }: { progress: number }) {
  const days = ["THU 20", "FRI 21", "SAT 22"];
  const dayPosition = interpolate(progress, [0, 1], [0, days.length - 1]);
  return (
    <div
      style={{
        width: 1480,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 70,
      }}
    >
      <div style={{ position: "relative", width: 710, height: 670 }}>
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 48,
            width: 274,
            height: 560,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [13, -11])}px, 0) rotate(-5deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="MOBILE · DAY VIEW"
            caption="day view"
            width={274}
            height={560}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 22])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: 4,
            top: 0,
            width: 274,
            height: 600,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-10, 14])}px, 0) rotate(4deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="MOBILE · SCHEDULE"
            caption="schedule view"
            width={274}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [18, 42])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 226,
            bottom: 22,
            padding: "11px 15px",
            borderRadius: 13,
            background: ink,
            color: paper,
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.08em",
            boxShadow: "0 15px 34px rgba(24,37,34,.28)",
          }}
        >
          DAY-BY-DAY SCHEDULE
        </div>
      </div>
      <div style={{ width: 545 }}>
        <Eyebrow tone="sage">02 · Day by day</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 59,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Browse sessions
          <br />
          <span style={{ color: PALETTE.sageDeep }}>by day.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          The day view filters the published programme by date while retaining
          the full timetable.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 26 }}>
          {days.map((day, index) => (
            <div
              key={day}
              style={{
                padding: "10px 11px",
                borderRadius: 10,
                border: `1px solid ${interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [line, "rgba(190,98,66,.42)"],
                )}`,
                background: interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [paper, "rgba(190,98,66,.08)"],
                ),
                color: interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [muted, copper],
                ),
                fontSize: 9,
                fontWeight: 850,
                letterSpacing: "0.08em",
                transform: `translate3d(0, ${interpolate(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [0, -3],
                )}px, 0)`,
              }}
            >
              {day}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SpeakersSurface({ progress }: { progress: number }) {
  return (
    <div
      style={{ width: 1380, display: "flex", alignItems: "center", gap: 100 }}
    >
      <div style={{ width: 505 }}>
        <Eyebrow tone="copper">03 · Speakers</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 59,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Publish searchable
          <br />
          <span style={{ color: copper }}>speaker profiles.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          Speaker profiles link biographies and published sessions.
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginTop: 27,
          }}
        >
          <div
            style={{
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [3, -4])}px, 0)`,
            }}
          >
            <MiniAvatar initials="PS" color="#436b62" />
          </div>
          <div
            style={{
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [-3, 4])}px, 0)`,
            }}
          >
            <MiniAvatar initials="AM" color={copper} />
          </div>
          <span style={{ color: muted, fontSize: 11, fontWeight: 750 }}>
            Linked speaker profiles
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 248,
            top: 300,
            width: 72,
            height: 3,
            zIndex: 0,
            borderRadius: 99,
            background:
              "linear-gradient(90deg, rgba(190,98,66,.14), rgba(190,98,66,.86), rgba(143,191,154,.82))",
            transform: `scaleX(${progress})`,
            transformOrigin: "left center",
          }}
        />
        <div
          style={{
            position: "relative",
            zIndex: 1,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [12, -13])}px, 0) rotate(${interpolate(progress, [0, 1], [-1.2, 0.8])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.speakerGalleryMobile}
            label="SPEAKER GALLERY"
            caption="/speakers"
            width={270}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 100])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "relative",
            zIndex: 1,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-12, 13])}px, 0) rotate(${interpolate(progress, [0, 1], [1, -0.9])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="SESSION LINK"
            caption="linked"
            width={270}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [46, 66])}%`}
            radius={24}
          />
        </div>
      </div>
    </div>
  );
}

function ItinerarySurface({ progress }: { progress: number }) {
  const rows = [
    "Opening keynote",
    "Future of urban care",
    "Lunch + community tables",
    "Closing provocation",
  ];
  return (
    <div
      style={{
        width: 1430,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 90,
      }}
    >
      <div style={{ width: 590 }}>
        <Eyebrow tone="sage">04 · Itinerary</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 63,
            lineHeight: 0.97,
            fontWeight: 860,
            letterSpacing: "-0.075em",
            marginTop: 17,
          }}
        >
          Build a personal
          <br />
          <span style={{ color: PALETTE.sageDeep }}>itinerary.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 22 }}
        >
          Attendees can save, share and revisit selected sessions.
        </div>
      </div>
      <div
        style={{
          width: 610,
          padding: 26,
          borderRadius: 24,
          background: paper,
          border: `1px solid ${line}`,
          boxShadow: "0 26px 75px rgba(24,37,34,.14)",
          transform: `translate3d(${interpolate(progress, [0, 1], [11, -9])}px, ${interpolate(progress, [0, 1], [7, -6])}px, 0)`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: 18,
            borderBottom: `1px solid ${line}`,
          }}
        >
          <div>
            <div
              style={{
                color: muted,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              MY ITINERARY
            </div>
            <div
              style={{
                color: ink,
                fontSize: 22,
                fontWeight: 850,
                letterSpacing: "-0.04em",
                marginTop: 7,
              }}
            >
              Friday · 21 May 2027
            </div>
          </div>
          <Chip tone="copper">4 SESSIONS SAVED</Chip>
        </div>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: 47,
              top: 14,
              bottom: 14,
              width: 2,
              zIndex: 0,
              background: "rgba(24,37,34,.12)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 46,
              top: 14,
              bottom: 14,
              width: 4,
              zIndex: 1,
              borderRadius: 99,
              background:
                "linear-gradient(180deg, rgba(143,191,154,.92), rgba(190,98,66,.9))",
              transform: `scaleY(${progress})`,
              transformOrigin: "center top",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 43,
              top: 10,
              width: 12,
              height: 12,
              zIndex: 3,
              borderRadius: "50%",
              background: copper,
              border: `3px solid ${paper}`,
              boxSizing: "border-box",
              boxShadow: "0 4px 12px rgba(190,98,66,.36)",
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [0, 171])}px, 0)`,
            }}
          />
          {rows.map((row, index) => (
            <div
              key={row}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "15px 0",
                borderBottom:
                  index < rows.length - 1 ? `1px solid ${line}` : undefined,
                position: "relative",
                zIndex: 2,
                transform: `translate3d(${interpolate(
                  ease(local(progress, index * 0.11, 0.36 + index * 0.11)),
                  [0, 1],
                  [10, 0],
                )}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  color: muted,
                  width: 42,
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {["09:30", "10:30", "12:15", "16:40"][index]}
              </div>
              <div
                style={{ flex: 1, color: ink, fontSize: 13, fontWeight: 800 }}
              >
                {row}
              </div>
              <div
                style={{
                  width: 19,
                  height: 19,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: index === 1 ? copper : "rgba(143,191,154,.25)",
                  color: index === 1 ? paper : PALETTE.sageDeep,
                  fontSize: 11,
                }}
              >
                {index === 1 ? "✓" : "•"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmbedsSurface({ progress }: { progress: number }) {
  const scanPosition = interpolate(progress, [0, 1], [-210, 1190]);
  return (
    <div
      style={{ width: 1560, display: "flex", alignItems: "center", gap: 42 }}
    >
      <div style={{ width: 360 }}>
        <Eyebrow tone="copper">05 · Embeds</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 56,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Keep partner sites
          <br />
          <span style={{ color: copper }}>in step.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          Managed embeds display the current published programme without manual
          exports.
        </div>
        <div
          style={{
            marginTop: 25,
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: PALETTE.sageDeep,
            fontSize: 11,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          <Check color={PALETTE.sageDeep} /> VERSIONED &amp; TRACEABLE
        </div>
      </div>
      <div style={{ height: 668, position: "relative", width: 1158 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 30,
            background:
              "radial-gradient(circle at 18% 22%, rgba(190,98,66,.18), transparent 26%), radial-gradient(circle at 88% 72%, rgba(143,191,154,.18), transparent 34%), linear-gradient(135deg, rgba(24,37,34,.08), rgba(24,37,34,0))",
            transform: `translate3d(${interpolate(progress, [0, 1], [14, 30])}px, ${interpolate(progress, [0, 1], [30, 17])}px, 0)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 38,
            top: 32,
            zIndex: 4,
            display: "flex",
            gap: 10,
          }}
        >
          <Chip tone="copper">Published programme</Chip>
          <Chip tone="good">One published source</Chip>
        </div>
        <div
          style={{
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [5, -5])}px, 0) scale(${interpolate(progress, [0, 1], [1.002, 1.012])})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgramme}
            label="PUBLISHED PROGRAMME"
            caption="source view"
            width={1158}
            height={668}
            objectPosition={`center ${interpolate(progress, [0, 1], [14, 29])}%`}
            radius={30}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 52,
            bottom: 18,
            width: 180,
            zIndex: 2,
            pointerEvents: "none",
            background:
              "linear-gradient(90deg, transparent, rgba(143,191,154,.06), rgba(255,253,248,.24), rgba(190,98,66,.08), transparent)",
            transform: `translate3d(${scanPosition}px, 0, 0) skewX(-7deg)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 34,
            top: 96,
            width: 460,
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 18,
            pointerEvents: "none",
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-7, 7])}px, 0)`,
          }}
        >
          <div
            style={{
              padding: "14px 17px",
              borderRadius: 16,
              background: "rgba(255,253,248,.88)",
              border: `1px solid rgba(24,37,34,.12)`,
              boxShadow: "0 14px 34px rgba(24,37,34,.1)",
            }}
          >
            <div
              style={{
                color: muted,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              PUBLISHED SOURCE SNAPSHOT
            </div>
            <div
              style={{
                color: ink,
                fontSize: 21,
                fontWeight: 850,
                letterSpacing: "-0.05em",
                marginTop: 7,
              }}
            >
              Future of Events 2027
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
                marginTop: 9,
                color: muted,
                fontSize: 11,
                fontWeight: 750,
              }}
            >
              <span>published programme</span>
              <span>linked profiles</span>
              <span>managed embed</span>
            </div>
          </div>
          <div
            style={{
              justifySelf: "end",
              alignSelf: "start",
              padding: "13px 15px",
              borderRadius: 16,
              background: "rgba(11,20,19,.76)",
              border: "1px solid rgba(255,255,255,.14)",
              boxShadow: "0 14px 34px rgba(0,0,0,.16)",
              color: paper,
              minWidth: 228,
            }}
          >
            <div
              style={{
                color: sage,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              PUBLISHED SOURCE
            </div>
            <div
              style={{
                marginTop: 8,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <Metric value="1" label="schedule revision" dark />
              <Metric value="1" label="published source" tone="copper" dark />
            </div>
          </div>
        </div>
        <div
          style={{
            background: "rgba(255,253,248,.9)",
            border: "1px solid rgba(24,37,34,.13)",
            borderRadius: 15,
            bottom: 24,
            boxShadow: "0 14px 34px rgba(24,37,34,.14)",
            color: paper,
            left: "auto",
            padding: "12px 15px 13px",
            position: "absolute",
            right: 62,
            width: 500,
            zIndex: 5,
          }}
        >
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.13em",
            }}
          >
            PUBLISHED PROGRAMME EMBED
          </div>
          <div
            style={{
              color: "rgba(24,37,34,.62)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.35,
              marginTop: 7,
              letterSpacing: 0,
            }}
          >
            The preview references the published programme source.
          </div>
        </div>
      </div>
    </div>
  );
}

function EventSiteSurface({ progress }: { progress: number }) {
  const sections = [
    "About the event",
    "Venue + access",
    "Sponsors",
    "Code of conduct",
    "FAQ",
  ];
  const navPosition = interpolate(progress, [0, 1], [0, sections.length - 1]);
  return (
    <div
      style={{ width: 1500, display: "flex", alignItems: "center", gap: 74 }}
    >
      <div style={{ width: 520 }}>
        <Eyebrow tone="sage">06 · Event site</Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 62,
            lineHeight: 0.97,
            fontWeight: 860,
            letterSpacing: "-0.075em",
            marginTop: 17,
          }}
        >
          Bring the whole event
          <br />
          <span style={{ color: sage }}>story together.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.58)",
            fontSize: 15,
            lineHeight: 1.5,
            marginTop: 21,
          }}
        >
          Use fixed sections for About, Venue, Sponsors, Code of conduct and
          FAQ.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 27,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -13,
              top: 0,
              width: 3,
              height: 22,
              borderRadius: 99,
              background: sage,
              boxShadow: "0 5px 16px rgba(143,191,154,.4)",
              transform: `translate3d(0, ${navPosition * 32}px, 0)`,
            }}
          />
          {sections.map((section, index) => (
            <div
              key={section}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: interpolateColors(
                  clamp(1 - Math.abs(index - navPosition)),
                  [0, 1],
                  ["rgba(255,253,248,.6)", paper],
                ),
                fontSize: 12,
                fontWeight: 750,
                transform: `translate3d(${interpolate(
                  clamp(1 - Math.abs(index - navPosition)),
                  [0, 1],
                  [0, 7],
                )}px, 0, 0)`,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 7,
                  background: interpolateColors(
                    clamp(1 - Math.abs(index - navPosition)),
                    [0, 1],
                    ["rgba(255,255,255,.1)", copper],
                  ),
                  color: interpolateColors(
                    clamp(1 - Math.abs(index - navPosition)),
                    [0, 1],
                    ["rgba(255,255,255,.55)", paper],
                  ),
                  fontSize: 10,
                  fontWeight: 900,
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              {section}
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: "relative", width: 840, height: 650 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 94,
            width: 410,
            height: 350,
            transform: `translate3d(${interpolate(progress, [0, 1], [-9, 7])}px, ${interpolate(progress, [0, 1], [9, -7])}px, 0) rotate(-3deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSite}
            label="EVENT SITE · LIGHT"
            caption="fixed shell"
            width={410}
            height={350}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 76])}%`}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 126,
            top: 10,
            width: 570,
            height: 560,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-8, 8])}px, 0) rotate(${interpolate(progress, [0, 1], [0.5, 1.5])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSiteDark}
            label="EVENT SITE · DARK"
            caption="fixed shell"
            width={570}
            height={560}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 84])}%`}
            dark
          />
          <PublishScrollRail progress={progress} height={466} dark />
        </div>
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 212,
            height: 420,
            transform: `translate3d(${interpolate(progress, [0, 1], [7, -8])}px, ${interpolate(progress, [0, 1], [-10, 10])}px, 0) rotate(-4deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSiteMobile}
            label="EVENT SITE · MOBILE"
            caption="responsive"
            width={212}
            height={420}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 16])}%`}
            radius={22}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: 236,
            bottom: 36,
            padding: "10px 13px",
            borderRadius: 999,
            background: sage,
            color: ink,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: "0.08em",
            boxShadow: "0 14px 30px rgba(0,0,0,.3)",
          }}
        >
          PUBLISHED SITE
        </div>
      </div>
    </div>
  );
}

function PublishedOutcomeMoment({ progress }: { progress: number }) {
  const eased = ease(progress);
  const scale = interpolate(eased, [0, 1], [1.04, 1.075]);
  const imageShift = interpolate(eased, [0, 1], [-10, 10]);
  const thread = interpolate(eased, [0, 1], [0, 1]);
  return (
    <div
      style={{
        width: 1480,
        height: 710,
        position: "relative",
        overflow: "hidden",
        borderRadius: 30,
        border: "1px solid rgba(255,255,255,.13)",
        boxShadow: "0 40px 110px rgba(0,0,0,.38)",
      }}
    >
      <Img
        src={staticFile("video/illustrative-event-moment.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center center",
          transform: `translate3d(${imageShift}px, 0, 0) scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(7,15,14,.86) 0%, rgba(7,15,14,.5) 38%, rgba(7,15,14,.13) 66%, rgba(7,15,14,.68) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 62,
          top: 58,
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <Chip tone="copper" dark>
          Published programme
        </Chip>
        <Chip tone="good" dark>
          Ready for attendees
        </Chip>
      </div>
      <div style={{ position: "absolute", left: 66, top: 138, width: 500 }}>
        <Eyebrow tone="sage" dark>
          Published revision
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 56,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 18,
          }}
        >
          Put the programme
          <br />
          in attendees’ hands
          <br />
          <span style={{ color: sage }}>before doors open.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.66)",
            fontSize: 15,
            lineHeight: 1.5,
            marginTop: 20,
            maxWidth: 430,
          }}
        >
          Give attendees, speakers and organisers one current schedule wherever
          they look.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          right: 82,
          top: 348,
          height: 2,
          background:
            "linear-gradient(90deg, rgba(143,191,154,.05), rgba(143,191,154,.88), rgba(246,197,169,.74), rgba(255,253,248,.05))",
          transform: `scaleX(${thread})`,
          transformOrigin: "left center",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 72,
          bottom: 58,
          display: "grid",
          gridTemplateColumns: "repeat(3, 178px)",
          gap: 12,
        }}
      >
        {[
          ["ATTENDEE", "published time and room"],
          ["SPEAKER", "published session slot"],
          ["OPS", "revision and changes recorded"],
        ].map(([role, outcome], index) => (
          <div
            key={role}
            style={{
              padding: "16px 15px",
              borderRadius: 15,
              background: "rgba(255,253,248,.9)",
              border: "1px solid rgba(255,255,255,.16)",
              opacity: ease(
                local(progress, 0.18 + index * 0.14, 0.4 + index * 0.14),
              ),
            }}
          >
            <div
              style={{
                color: index === 2 ? copperText : PALETTE.sageDeep,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.12em",
              }}
            >
              {role}
            </div>
            <div
              style={{
                color: ink,
                fontSize: 17,
                lineHeight: 1.15,
                fontWeight: 850,
                letterSpacing: "-0.035em",
                marginTop: 10,
              }}
            >
              {outcome}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PublishScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = frameProgress(frame, duration);
  const hero = cut(progress, 0, 0.14);
  const programme = cut(progress, 0.14, 0.28);
  const day = cut(progress, 0.28, 0.42);
  const speakers = cut(progress, 0.42, 0.56);
  const itinerary = cut(progress, 0.56, 0.69);
  const embeds = after(progress, 0.69);
  const site = cut(progress, 0.82, 0.91);
  const outcome = after(progress, 0.91);
  const heroProgress = local(progress, 0, 0.14);
  const programmeProgress = local(progress, 0.14, 0.28);
  const dayProgress = local(progress, 0.28, 0.42);
  const speakersProgress = local(progress, 0.42, 0.56);
  const itineraryProgress = local(progress, 0.56, 0.69);
  const embedsProgress = local(progress, 0.69, 0.82);
  const siteProgress = local(progress, 0.82, 0.91);
  const outcomeProgress = local(progress, 0.91, 1);
  const siteTransition = Easing.inOut(Easing.cubic)(
    local(progress, 0.82, 0.842),
  );
  const siteTransitionStarted = siteTransition > 0.001;
  const siteTransitionSettled = siteTransition >= 0.999;
  const theme = siteTransition;
  const background = interpolateColors(theme, [0, 1], [canvas, deep]);
  const lightFieldX = interpolate(progress, [0, 1], [-20, 24]);
  const darkFieldX = interpolate(progress, [0, 1], [18, -22]);
  return (
    <AbsoluteFill
      style={{
        background,
        overflow: "hidden",
        fontFamily: "Program Cue Inter, Inter, sans-serif",
      }}
    >
      <DotGrid opacity={(1 - theme) * 0.22} dark={false} />
      <DotGrid opacity={theme * 0.3} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 89% 17%, rgba(190,98,66,.1), transparent 29%), radial-gradient(circle at 7% 80%, rgba(143,191,154,.12), transparent 32%)",
          opacity: 1 - theme,
          transform: `translate3d(${lightFieldX}px, ${interpolate(progress, [0, 1], [-12, 14])}px, 0) scale(1.025)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 78% 50%, rgba(143,191,154,.13), transparent 33%), radial-gradient(circle at 10% 12%, rgba(190,98,66,.13), transparent 29%)",
          opacity: theme,
          transform: `translate3d(${darkFieldX}px, ${interpolate(progress, [0, 1], [12, -14])}px, 0) scale(1.025)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 40,
          opacity: 1 - theme,
          pointerEvents: "none",
        }}
      >
        <SceneHeader
          chapter="PUBLISHED PROGRAMME"
          index="11 / 13 · PUBLISH"
          progress={progress}
          dark={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 40,
          opacity: theme,
          pointerEvents: "none",
        }}
      >
        <SceneHeader
          chapter="PUBLISHED PROGRAMME"
          index="11 / 13 · PUBLISH"
          progress={progress}
        />
      </div>
      <PublishSurfaceLayer
        active={hero === 1}
        left={184}
        progress={heroProgress}
        top={188}
        zIndex={5}
      >
        <PublishHero progress={heroProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={programme === 1}
        left={140}
        progress={programmeProgress}
        top={140}
        zIndex={8}
      >
        <ProgrammeSurface progress={programmeProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={day === 1}
        left={220}
        progress={dayProgress}
        top={154}
        zIndex={10}
      >
        <DayByDaySurface progress={dayProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={speakers === 1}
        left={250}
        progress={speakersProgress}
        top={154}
        zIndex={12}
      >
        <SpeakersSurface progress={speakersProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={itinerary === 1}
        left={245}
        progress={itineraryProgress}
        top={168}
        zIndex={14}
      >
        <ItinerarySurface progress={itineraryProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={embeds === 1}
        left={214}
        maskDirection="outgoing"
        maskProgress={siteTransition}
        progress={embedsProgress}
        top={168}
        zIndex={16}
      >
        <EmbedsSurface progress={embedsProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(13,25,23,.98) 0%, rgba(13,25,23,.96) 45%, rgba(13,25,23,.7) 64%, rgba(13,25,23,0) 100%)",
          clipPath:
            siteTransitionStarted && !siteTransitionSettled
              ? `inset(0 ${interpolate(siteTransition, [0, 1], [100, 0])}% 0 0)`
              : undefined,
          opacity: siteTransitionStarted ? 1 : 0,
          pointerEvents: "none",
          zIndex: 17,
        }}
      />
      <PublishSurfaceLayer
        active={site === 1}
        left={196}
        maskProgress={siteTransition}
        progress={siteProgress}
        top={142}
        zIndex={18}
      >
        <EventSiteSurface progress={siteProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          left: interpolate(siteTransition, [0, 1], [-8, 1928]),
          top: 0,
          bottom: 0,
          width: 3,
          zIndex: 19,
          opacity: Math.sin(siteTransition * Math.PI),
          background: sage,
          boxShadow:
            "0 0 22px rgba(143,191,154,.56), -12px 0 42px rgba(11,20,19,.34)",
          pointerEvents: "none",
        }}
      />
      <PublishSurfaceLayer
        active={outcome === 1}
        left={220}
        progress={outcomeProgress}
        top={150}
        zIndex={20}
      >
        <PublishedOutcomeMoment progress={outcomeProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 30,
          opacity: 1 - theme,
          pointerEvents: "none",
        }}
      >
        <FooterRail
          progress={progress}
          items={["source", "schedule", "people", "path", "embed", "site"]}
          dark={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 30,
          opacity: theme,
          pointerEvents: "none",
        }}
      >
        <FooterRail
          progress={progress}
          items={["source", "schedule", "people", "path", "embed", "site"]}
        />
      </div>
    </AbsoluteFill>
  );
}

function CodeLine({
  children,
  dim = false,
  focus = 0,
  number,
  cursor = 0,
}: {
  children: ReactNode;
  dim?: boolean;
  focus?: number;
  number: string;
  cursor?: number;
}) {
  const focusAmount = clamp(focus);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        minHeight: 28,
        alignItems: "center",
        padding: "0 17px",
        background: `rgba(143,191,154,${focusAmount * 0.11})`,
        borderLeft: `2px solid rgba(143,191,154,${focusAmount})`,
        color: dim ? "rgba(255,253,248,.36)" : "rgba(255,253,248,.83)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        transform: `translate3d(${interpolate(focusAmount, [0, 1], [0, 3])}px, 0, 0)`,
        whiteSpace: "pre",
      }}
    >
      <span
        style={{
          width: 29,
          color: "rgba(255,253,248,.25)",
          fontSize: 10,
          userSelect: "none",
        }}
      >
        {number}
      </span>
      <span>{children}</span>
      <span
        style={{
          width: 6,
          height: 15,
          marginLeft: 4,
          borderRadius: 1,
          background: sage,
          boxShadow: "0 0 12px rgba(143,191,154,.52)",
          opacity: focusAmount * cursor,
        }}
      />
    </div>
  );
}

function Syntax({
  children,
  color = "#d6a8ff",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <span style={{ color }}>{children}</span>;
}

function ApiConsole({ progress }: { progress: number }) {
  const endpoints = [
    ["GET", "/api/v1/public/events/{slug}/programme"],
    ["POST", "/api/v1/events/{eventId}/schedule/publish"],
    ["GET", "/api/v1/events/{eventId}/operations"],
    ["POST", "/api/webhooks/file-scanner"],
  ];
  const focusLine = interpolate(
    progress,
    [0, 0.14, 0.28, 0.45, 0.61, 0.76, 0.9, 1],
    [1, 1, 3, 5, 6, 7, 8, 8],
  );
  const codeScroll = interpolate(progress, [0, 1], [4, -72]);
  const cursor = interpolate(
    Math.sin(progress * Math.PI * 18),
    [-1, 1],
    [0.2, 1],
  );
  const scanY = interpolate(progress, [0, 1], [-60, 236]);
  const endpointFocus = interpolate(
    ease(local(progress, 0.54, 1)),
    [0, 1],
    [1, 2],
  );
  const lineFocus = (index: number) => clamp(1 - Math.abs(focusLine - index));
  return (
    <div
      style={{
        width: 760,
        borderRadius: 22,
        overflow: "hidden",
        background: "#111d1b",
        border: "1px solid rgba(255,255,255,.16)",
        boxShadow: "0 28px 90px rgba(0,0,0,.4)",
      }}
    >
      <div
        style={{
          height: 47,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 17px",
          borderBottom: "1px solid rgba(255,255,255,.12)",
          background: "rgba(255,255,255,.045)",
        }}
      >
        <span style={{ display: "flex", gap: 5 }}>
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#ff766a",
            }}
          />
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: PALETTE.gold,
            }}
          />
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: sage,
            }}
          />
        </span>
        <span
          style={{
            color: "rgba(255,253,248,.62)",
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          PROGRAM CUE API / DOCUMENTED CONTRACT
        </span>
        <Chip tone="good" dark>
          OpenAPI
        </Chip>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginLeft: "auto",
            color: "rgba(255,253,248,.46)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: sage,
              boxShadow: "0 0 12px rgba(143,191,154,.6)",
              opacity: interpolate(cursor, [0.2, 1], [0.48, 1]),
            }}
          />
          CONTRACT / INSPECT
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 196,
          overflow: "hidden",
          borderBottom: "1px solid rgba(255,255,255,.11)",
        }}
      >
        <div
          style={{
            padding: "17px 0 14px",
            transform: `translate3d(0, ${codeScroll}px, 0)`,
          }}
        >
          <CodeLine dim focus={lineFocus(0)} cursor={cursor} number="01">
            {"// inspect the schedule publication contract"}
          </CodeLine>
          <CodeLine focus={lineFocus(1)} cursor={cursor} number="02">
            <Syntax color="#8fbf9a">POST</Syntax> /api/v1/events/{`{eventId}`}
            /schedule/publish
          </CodeLine>
          <CodeLine dim focus={lineFocus(2)} cursor={cursor} number="03">
            {"// required API key scope: "}
            <Syntax color="#f5ca8e">schedule:publish</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(3)} cursor={cursor} number="04">
            Idempotency-Key:{" "}
            <Syntax color="#f6c5a9">publish-schedule-001</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(4)} cursor={cursor} number="05">
            {`{`}
          </CodeLine>
          <CodeLine focus={lineFocus(5)} cursor={cursor} number="06">
            {"  "}"scheduleVersionId":{" "}
            <Syntax color="#f6c5a9">"&lt;draft-schedule-version-id&gt;"</Syntax>
            ,
          </CodeLine>
          <CodeLine focus={lineFocus(6)} cursor={cursor} number="07">
            {"  "}"scheduleRevision": <Syntax color="#f5ca8e">1</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(7)} cursor={cursor} number="08">
            {`}`}
          </CodeLine>
          <CodeLine dim focus={lineFocus(8)} cursor={cursor} number="09">
            {"// blocking conflicts recalculated before commit"}
          </CodeLine>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: scanY,
            height: 60,
            background:
              "linear-gradient(180deg, transparent, rgba(143,191,154,.085), transparent)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 11,
            padding: "5px 8px",
            borderRadius: 999,
            background: "rgba(11,20,19,.88)",
            border: "1px solid rgba(212,167,44,.28)",
            color: "#f5ca8e",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 8,
            fontWeight: 850,
            letterSpacing: "0.08em",
          }}
        >
          CONTRACT PREVIEW
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 7,
          padding: "15px 17px 19px",
        }}
      >
        {endpoints.map(([method, path], index) => (
          <div
            key={path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "rgba(255,253,248,.62)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              opacity: interpolate(
                clamp(1 - Math.abs(endpointFocus - index)),
                [0, 1],
                [0.56, 1],
              ),
              transform: `translate3d(${interpolate(
                clamp(1 - Math.abs(endpointFocus - index)),
                [0, 1],
                [0, 4],
              )}px, 0, 0)`,
            }}
          >
            <span
              style={{
                width: 48,
                color:
                  method === "GET"
                    ? sage
                    : method === "POST"
                      ? copper
                      : PALETTE.gold,
                fontWeight: 900,
              }}
            >
              {method}
            </span>
            <span>{path}</span>
            <span
              style={{ marginLeft: "auto", color: "rgba(255,253,248,.32)" }}
            >
              {index === 3 ? "webhook" : "REST"}
            </span>
          </div>
        ))}
        <div
          style={{
            marginTop: 7,
            color: "rgba(255,253,248,.4)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          + 29 more entries · 33 documented API paths
        </div>
      </div>
    </div>
  );
}

function TrailStatus({
  from,
  progress,
  to,
  tone,
}: {
  from: string;
  progress: number;
  to: string;
  tone: string;
}) {
  const swap = ease(local(progress, 0.38, 0.86));
  return (
    <div
      style={{
        position: "relative",
        width: 112,
        height: 27,
        overflow: "hidden",
        borderRadius: 999,
        border: `1px solid ${interpolateColors(swap, [0, 1], [line, tone])}`,
        background: interpolateColors(
          swap,
          [0, 1],
          ["rgba(24,37,34,.04)", `${tone}18`],
        ),
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: "0.08em",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          color: muted,
          opacity: 1 - swap,
          transform: `translate3d(0, ${interpolate(swap, [0, 1], [0, -8])}px, 0)`,
        }}
      >
        {from}
      </span>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          color: tone,
          opacity: swap,
          transform: `translate3d(0, ${interpolate(swap, [0, 1], [8, 0])}px, 0)`,
        }}
      >
        {to}
      </span>
    </div>
  );
}

function OperationCentreProgress({ progress }: { progress: number }) {
  const rows = [
    {
      id: "STEP 01",
      operation: "Assistant reminder",
      from: "APPROVED",
      to: "QUEUED",
      detail: "1 recipient · approval recorded",
      tone: sage,
      window: [0.02, 0.2],
    },
    {
      id: "STEP 02",
      operation: "Reminder delivery",
      from: "QUEUED",
      to: "RUNNING",
      detail: "delivery attempt started",
      tone: copper,
      window: [0.16, 0.36],
    },
    {
      id: "STEP 03",
      operation: "Recipient result",
      from: "RUNNING",
      to: "FAILED",
      detail: "delivery attempt failed",
      tone: PALETTE.gold,
      window: [0.3, 0.5],
    },
    {
      id: "STEP 04",
      operation: "Operation recovery",
      from: "FAILED",
      to: "READY",
      detail: "original audience preserved",
      tone: sage,
      window: [0.44, 0.62],
    },
  ] as const;
  const evidenceProgress = local(progress, 0.02, 0.72);
  const evidenceSweepX = interpolate(progress, [0, 1], [-5, 86]);
  const recordedCount = rows.filter(
    (row) => ease(local(progress, row.window[0], row.window[1])) >= 0.74,
  ).length;
  return (
    <div
      style={{
        position: "relative",
        width: 670,
        overflow: "hidden",
        borderRadius: 22,
        padding: 23,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 28px 90px rgba(0,0,0,.25)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -80,
          bottom: -80,
          left: `${evidenceSweepX}%`,
          width: 130,
          background:
            "linear-gradient(90deg, transparent, rgba(190,98,66,.09), transparent)",
          transform: "skewX(-12deg)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{ fontSize: 21, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Unified Operation Centre
          </div>
          <div style={{ color: muted, fontSize: 13, marginTop: 4 }}>
            One reminder, tracked from approval to recorded result.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 7,
          }}
        >
          <Chip tone="copper">OPERATION RECOVERY</Chip>
          <div
            style={{
              color: muted,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 9,
              fontWeight: 900,
              letterSpacing: "0.1em",
            }}
          >
            PROGRESS {String(recordedCount).padStart(2, "0")} / 04
          </div>
        </div>
      </div>
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 29,
            bottom: 29,
            width: 2,
            borderRadius: 999,
            background: line,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 29,
            bottom: 29,
            width: 2,
            borderRadius: 999,
            background: `linear-gradient(180deg, ${sage}, ${copper})`,
            boxShadow: "0 0 14px rgba(143,191,154,.35)",
            transform: `scaleY(${evidenceProgress})`,
            transformOrigin: "top center",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 9,
            top: interpolate(evidenceProgress, [0, 1], [29, 205]),
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: interpolateColors(
              evidenceProgress,
              [0, 1],
              [sage, copper],
            ),
            boxShadow: "0 0 0 5px rgba(143,191,154,.12)",
            opacity: interpolate(evidenceProgress, [0, 0.04, 1], [0, 1, 1]),
            transform: "translateY(-50%)",
          }}
        />
        {rows.map((row, index) => {
          const rowProgress = ease(
            local(progress, row.window[0], row.window[1]),
          );
          const nodePulse = interpolate(
            Math.sin(rowProgress * Math.PI),
            [0, 1],
            [1, 1.14],
          );
          return (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns: "30px 82px minmax(0, 1fr) 112px",
                minHeight: 59,
                alignItems: "center",
                gap: 10,
                borderTop: `1px solid ${line}`,
                opacity: interpolate(rowProgress, [0, 1], [0.28, 1]),
                transform: `translate3d(${interpolate(
                  rowProgress,
                  [0, 1],
                  [10, 0],
                )}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  position: "relative",
                  zIndex: 2,
                  width: 27,
                  height: 27,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  border: `1px solid ${interpolateColors(
                    rowProgress,
                    [0, 1],
                    [line, row.tone],
                  )}`,
                  background: paper,
                  color: row.tone,
                  fontSize: 10,
                  fontWeight: 900,
                  transform: `scale(${nodePulse})`,
                }}
              >
                {rowProgress >= 0.74 ? "✓" : String(index + 1)}
              </div>
              <div
                style={{
                  color: muted,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                }}
              >
                {row.id}
              </div>
              <div>
                <div style={{ color: ink, fontSize: 14, fontWeight: 800 }}>
                  {row.operation}
                </div>
                <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
                  {row.detail}
                </div>
              </div>
              <TrailStatus
                from={row.from}
                progress={rowProgress}
                to={row.to}
                tone={row.tone}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "relative",
          height: 3,
          marginTop: 12,
          overflow: "hidden",
          borderRadius: 999,
          background: "rgba(24,37,34,.08)",
        }}
      >
        <div
          style={{
            width: `${evidenceProgress * 100}%`,
            height: "100%",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${sage}, ${copper})`,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${line}`,
          color: muted,
          fontSize: 12,
          fontWeight: 750,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: sage,
            boxShadow: `0 0 ${interpolate(evidenceProgress, [0, 1], [0, 12])}px rgba(143,191,154,.42)`,
          }}
        />{" "}
        Queued → Running → Failed · ready to retry
      </div>
    </div>
  );
}

function OperationCentreDetail({ progress }: { progress: number }) {
  const steps = [
    {
      label: "QUEUED",
      detail: "Speaker task reminder",
      boundary: "APPROVED · 1 RECIPIENT",
      tone: sage,
      icon: "01",
    },
    {
      label: "FAILED",
      detail: "1 delivery needs attention",
      boundary: "FAILED · RESULT RECORDED",
      tone: PALETTE.gold,
      icon: "02",
    },
    {
      label: "RETRY",
      detail: "Retry failed operation",
      boundary: "ORIGINAL AUDIENCE PRESERVED",
      tone: copper,
      icon: "03",
    },
  ];
  const flowPosition = interpolate(
    ease(local(progress, 0.06, 0.72)),
    [0, 1],
    [0, 1.94],
  );
  const connectorProgress = [
    ease(local(progress, 0.2, 0.42)),
    ease(local(progress, 0.46, 0.68)),
  ];
  const boundaryFocus = ease(local(progress, 0.56, 0.74));
  const retryFocus = ease(local(progress, 0.5, 0.7));
  const retryCursor = ease(local(progress, 0.48, 0.72));
  const retryPress = clamp(
    ease(local(progress, 0.72, 0.78)) - ease(local(progress, 0.78, 0.84)),
  );
  const cursorOpacity =
    ease(local(progress, 0.42, 0.5)) * (1 - ease(local(progress, 0.84, 0.91)));
  return (
    <div
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: 1280,
        padding: 32,
        borderRadius: 24,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 32px 100px rgba(0,0,0,.28)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 23,
        }}
      >
        <div>
          <div
            style={{ fontSize: 22, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Assistant reminder recovery
          </div>
          <div style={{ color: muted, fontSize: 13, marginTop: 4 }}>
            The one-recipient operation is ready to retry with its original
            audience.
          </div>
        </div>
        <Chip tone="copper">OPERATION RECOVERY</Chip>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 14 }}>
        {steps.map((step, index) => {
          const stepFocus = clamp(1 - Math.abs(flowPosition - index));
          return (
            <div
              key={step.label}
              style={{
                display: "flex",
                alignItems: "center",
                flex: 1,
                gap: 14,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minHeight: 138,
                  padding: 20,
                  borderRadius: 16,
                  border: `1px solid ${interpolateColors(
                    stepFocus,
                    [0, 1],
                    [line, step.tone],
                  )}`,
                  background: interpolateColors(
                    stepFocus,
                    [0, 1],
                    ["rgba(24,37,34,.025)", `${step.tone}12`],
                  ),
                  boxShadow:
                    index === 2
                      ? `0 18px ${interpolate(
                          retryFocus,
                          [0, 1],
                          [0, 38],
                        )}px rgba(190,98,66,.14), inset 0 0 ${interpolate(
                          boundaryFocus,
                          [0, 1],
                          [0, 26],
                        )}px rgba(212,167,44,.08)`
                      : undefined,
                  transform: `translate3d(0, ${interpolate(
                    stepFocus,
                    [0, 1],
                    [0, index === 2 ? -7 : -3],
                  )}px, ${index === 2 ? interpolate(retryFocus, [0, 1], [0, 12]) : 0}px)`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 9,
                      display: "grid",
                      placeItems: "center",
                      background: step.tone,
                      color: step.tone === PALETTE.gold ? ink : paper,
                      fontSize: 11,
                      fontWeight: 900,
                      boxShadow: `0 0 0 ${interpolate(
                        stepFocus,
                        [0, 1],
                        [0, 5],
                      )}px ${step.tone}18`,
                    }}
                  >
                    {step.icon}
                  </span>
                  <span
                    style={{
                      color:
                        step.tone === PALETTE.gold
                          ? "#806315"
                          : step.tone === copper
                            ? copperText
                            : step.tone,
                      fontSize: 11,
                      fontWeight: 900,
                      letterSpacing: "0.12em",
                    }}
                  >
                    {step.label}
                  </span>
                </div>
                <div
                  style={{
                    color: ink,
                    fontSize: 17,
                    fontWeight: 800,
                    marginTop: 22,
                  }}
                >
                  {step.detail}
                </div>
                <div
                  style={{
                    color:
                      step.tone === PALETTE.gold
                        ? "#806315"
                        : step.tone === copper
                          ? copperText
                          : step.tone,
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: "0.11em",
                    marginTop: 9,
                  }}
                >
                  {step.boundary}
                </div>
              </div>
              {index < steps.length - 1 ? (
                <div
                  style={{
                    width: 92,
                    flexShrink: 0,
                    overflow: "hidden",
                    clipPath: `inset(0 ${100 - connectorProgress[index] * 100}% 0 0)`,
                  }}
                >
                  <Arrow color={step.tone} long />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginTop: 20,
          padding: "12px 14px",
          borderRadius: 13,
          background: interpolateColors(
            boundaryFocus,
            [0, 1],
            ["rgba(24,37,34,.045)", "rgba(212,167,44,.075)"],
          ),
          color: muted,
          fontSize: 13,
          fontWeight: 750,
        }}
      >
        <span style={{ color: copperText, fontWeight: 900 }}>
          ONE RECIPIENT · FAILED OPERATION
        </span>
        <span
          style={{
            marginLeft: "auto",
            padding: "8px 11px",
            borderRadius: 10,
            border: `1px solid ${interpolateColors(retryFocus, [0, 1], ["rgba(190,98,66,.08)", "rgba(190,98,66,.42)"])}`,
            background: interpolateColors(
              retryFocus,
              [0, 1],
              ["rgba(190,98,66,0)", "rgba(190,98,66,.12)"],
            ),
            color: copperText,
            fontWeight: 900,
            boxShadow: `0 10px ${interpolate(retryFocus, [0, 1], [0, 28])}px rgba(190,98,66,.16)`,
            transform: `translate3d(0, ${interpolate(retryFocus, [0, 1], [2, -2])}px, 0)`,
          }}
        >
          RETRY OPERATION · OPEN AUDIT ↗
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: interpolate(retryCursor, [0, 1], [1308, 1182]),
          top: interpolate(retryCursor, [0, 1], [188, 286]),
          zIndex: 8,
          opacity: cursorOpacity,
          transform: `rotate(-10deg) scale(${interpolate(retryPress, [0, 1], [1, 0.86])})`,
          filter: "drop-shadow(0 4px 6px rgba(0,0,0,.28))",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: 22,
            height: 30,
            background: deep,
            clipPath: "polygon(0 0, 100% 67%, 60% 71%, 49% 100%)",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 1186,
          top: 290,
          width: 52,
          height: 52,
          zIndex: 7,
          borderRadius: "50%",
          border: "2px solid rgba(190,98,66,.62)",
          opacity: retryPress,
          boxShadow: "0 0 34px rgba(190,98,66,.22)",
          transform: `translate(-50%, -50%) scale(${interpolate(retryPress, [0, 1], [0.38, 1.48])})`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function ProviderPreview({ progress }: { progress: number }) {
  const steps = [
    {
      label: "Programme",
      status: "CHECKED",
      tone: muted,
    },
    {
      label: "Speakers & rooms",
      status: "INCLUDED",
      tone: copper,
    },
    {
      label: "Export package",
      status: "READY",
      tone: sage,
    },
  ];
  const previewProgress = interpolate(
    ease(local(progress, 0.04, 0.94)),
    [0, 1],
    [0, 0.64],
  );
  const activeStep = interpolate(
    ease(local(progress, 0.06, 0.9)),
    [0, 1],
    [0, 2],
  );
  const boundaryPulse = interpolate(
    Math.sin(progress * Math.PI * 8),
    [-1, 1],
    [0, 1],
  );
  const scanX = interpolate(progress, [0, 1], [-38, 138]);
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: 1340,
        borderRadius: 28,
        padding: 38,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 32px 100px rgba(0,0,0,.32)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              background: "#183d59",
              color: paper,
              fontSize: 22,
              fontWeight: 900,
            }}
          >
            a
          </div>
          <div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 850,
                letterSpacing: "-0.04em",
              }}
            >
              Accelevents export preview
            </div>
            <div style={{ color: muted, fontSize: 13, marginTop: 5 }}>
              Published programme fields mapped in one place
            </div>
          </div>
        </div>
        <Chip tone="good">READY TO EXPORT</Chip>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.08fr .92fr",
          gap: 16,
        }}
      >
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            padding: 26,
            borderRadius: 18,
            border: `1px solid ${line}`,
            background: "#fff",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -40,
              bottom: -40,
              left: `${scanX}%`,
              width: 72,
              background:
                "linear-gradient(90deg, transparent, rgba(143,191,154,.09), transparent)",
              transform: "skewX(-12deg)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "relative",
              color: muted,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.11em",
            }}
          >
            PROGRAMME PAYLOAD
          </div>
          <div
            style={{
              position: "relative",
              color: ink,
              fontSize: 21,
              fontWeight: 800,
              marginTop: 14,
            }}
          >
            Programme payload
          </div>
          <div
            style={{
              position: "relative",
              color: muted,
              fontSize: 14,
              marginTop: 7,
            }}
          >
            Sessions, speakers, tracks and room fields
          </div>
          <div
            style={{
              position: "relative",
              height: 3,
              marginTop: 18,
              overflow: "hidden",
              borderRadius: 999,
              background: "rgba(24,37,34,.08)",
            }}
          >
            <div
              style={{
                width: `${previewProgress * 100}%`,
                height: "100%",
                borderRadius: 999,
                background: `linear-gradient(90deg, ${sage}, ${copper}, ${PALETTE.gold})`,
              }}
            />
          </div>
          <div
            style={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 10,
              marginTop: 15,
            }}
          >
            {steps.map((step, index) => {
              const stepFocus = clamp(1 - Math.abs(activeStep - index));
              return (
                <div
                  key={step.label}
                  style={{
                    padding: "12px 12px",
                    borderRadius: 14,
                    border: `1px solid ${interpolateColors(
                      stepFocus,
                      [0, 1],
                      [line, step.tone],
                    )}`,
                    background: interpolateColors(
                      stepFocus,
                      [0, 1],
                      ["rgba(24,37,34,.025)", `${step.tone}12`],
                    ),
                    opacity: interpolate(stepFocus, [0, 1], [0.62, 1]),
                    transform: `translate3d(0, ${interpolate(
                      stepFocus,
                      [0, 1],
                      [2, -2],
                    )}px, 0)`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      color: step.tone === copper ? copperText : step.tone,
                      fontSize: 9,
                      fontWeight: 900,
                      letterSpacing: "0.09em",
                    }}
                  >
                    <span>STEP 0{index + 1}</span>
                    <span>{step.status}</span>
                  </div>
                  <div
                    style={{
                      color: ink,
                      fontSize: 13,
                      fontWeight: 800,
                      marginTop: 8,
                    }}
                  >
                    {step.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div
          style={{
            padding: 26,
            borderRadius: 18,
            border: `1px solid rgba(143,191,154,${0.3 + boundaryPulse * 0.18})`,
            background: "rgba(143,191,154,.09)",
            boxShadow: `inset 0 0 ${interpolate(
              boundaryPulse,
              [0, 1],
              [0, 22],
            )}px rgba(143,191,154,.09)`,
          }}
        >
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.11em",
            }}
          >
            EXPORT STATUS
          </div>
          <div
            style={{ color: ink, fontSize: 21, fontWeight: 800, marginTop: 14 }}
          >
            <span
              style={{
                display: "inline-block",
                width: 9,
                height: 9,
                marginRight: 9,
                borderRadius: "50%",
                background: PALETTE.sageDeep,
                boxShadow: `0 0 0 ${interpolate(
                  boundaryPulse,
                  [0, 1],
                  [2, 7],
                )}px rgba(143,191,154,.14)`,
              }}
            />
            Ready to export
          </div>
          <div style={{ color: muted, fontSize: 14, marginTop: 7 }}>
            Mappings complete
          </div>
          <div
            style={{
              marginTop: 20,
              padding: "16px 18px",
              borderRadius: 15,
              background: "rgba(255,253,248,.72)",
              border: "1px solid rgba(143,191,154,.28)",
              color: PALETTE.sageDeep,
              fontSize: 12,
              fontWeight: 800,
              lineHeight: 1.45,
            }}
          >
            Review once, then confirm the export
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 20,
          padding: "18px 20px",
          borderRadius: 13,
          background: "rgba(143,191,154,.08)",
          border: "1px solid rgba(143,191,154,.26)",
          color: PALETTE.sageDeep,
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        <Check color={PALETTE.sageDeep} /> Speakers · tracks · sessions · room
        fields included
      </div>
    </div>
  );
}

export function OperateScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = frameProgress(frame, duration);
  const hero = cut(progress, 0, 0.16);
  const api = cut(progress, 0.16, 0.39);
  const trail = cut(progress, 0.39, 0.6);
  const detail = cut(progress, 0.6, 0.78);
  const provider = after(progress, 0.78);
  const heroLocal = local(progress, 0, 0.16);
  const apiLocal = local(progress, 0.16, 0.39);
  const trailLocal = local(progress, 0.39, 0.6);
  const detailLocal = local(progress, 0.6, 0.78);
  const providerLocal = local(progress, 0.78, 1);
  const heroWindowX = interpolate(ease(heroLocal), [0, 1], [10, -10]);
  const heroWindowY = interpolate(
    Math.sin(heroLocal * Math.PI),
    [0, 1],
    [0, -5],
  );
  const heroWindowScale = interpolate(ease(heroLocal), [0, 1], [1.018, 1.032]);
  const apiCardY = interpolate(apiLocal, [0, 1], [-5, 5]);
  const trailCardY = interpolate(trailLocal, [0, 1], [-8, 8]);
  const detailSettle = ease(local(detailLocal, 0.02, 0.72));
  const detailDrift = interpolate(detailSettle, [0, 1], [-9, 0]);
  const detailScale = interpolate(detailSettle, [0, 1], [0.982, 1]);
  const providerCardY = interpolate(
    Math.sin(providerLocal * Math.PI * 2),
    [-1, 1],
    [-3, 3],
  );
  return (
    <AbsoluteFill
      style={{
        background: deep,
        overflow: "hidden",
        fontFamily: "Program Cue Inter, Inter, sans-serif",
      }}
    >
      <DotGrid opacity={0.3} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 12% 28%, rgba(143,191,154,.12), transparent 30%), radial-gradient(circle at 90% 77%, rgba(190,98,66,.2), transparent 32%)",
        }}
      />
      <SceneHeader
        chapter="EVENT OPERATIONS"
        index="12 / 13 · OPERATE"
        progress={progress}
      />
      <Reveal
        amount={hero}
        style={{ position: "absolute", left: 120, top: 210, zIndex: 5 }}
      >
        <Eyebrow tone="sage" dark>
          Operate
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 84,
            lineHeight: 0.96,
            fontWeight: 880,
            letterSpacing: "-0.08em",
            marginTop: 20,
          }}
        >
          Stay in control
          <br />
          <span style={{ color: sage }}>after publish.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.6)",
            fontSize: 17,
            lineHeight: 1.5,
            maxWidth: 460,
            marginTop: 25,
          }}
        >
          From API call to recipient result, see what happened—and act on what
          comes next.
        </div>
        <div style={{ display: "flex", gap: 30, marginTop: 34 }}>
          <Metric dark value="33" label="documented API paths" tone="sage" />
          <Metric dark value="01" label="operation centre" tone="copper" />
        </div>
      </Reveal>
      <Reveal
        amount={hero}
        x={50}
        y={35}
        style={{ position: "absolute", right: 110, top: 185, zIndex: 4 }}
      >
        <div
          style={{
            transform: `translate3d(${heroWindowX}px, ${heroWindowY}px, 0) scale(${heroWindowScale})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.programmeAdmin}
            label="PROGRAMME PUBLISHING"
            caption="programme operations"
            width={750}
            height={560}
            objectPosition="center top"
            dark
          />
        </div>
      </Reveal>
      <Reveal
        amount={api}
        style={{ position: "absolute", inset: 0, zIndex: 10 }}
      >
        <div style={{ position: "absolute", left: 114, top: 180, width: 470 }}>
          <Eyebrow tone="sage" dark>
            01 · Connect
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 54,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Make Program Cue
            <br />
            part of your
            <br />
            <span style={{ color: sage }}>event stack.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              maxWidth: 380,
            }}
          >
            Use documented REST paths and webhooks to connect programme
            operations with the tools around them.
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 28 }}>
            <Chip tone="good" dark>
              33 documented paths
            </Chip>
            <Chip tone="copper" dark>
              scoped API keys
            </Chip>
            <Chip dark>webhook events</Chip>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 112,
            top: 180,
            transform: `translate3d(0, ${apiCardY}px, 0)`,
          }}
        >
          <ApiConsole progress={apiLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={trail}
        style={{ position: "absolute", inset: 0, zIndex: 12 }}
      >
        <div style={{ position: "absolute", left: 114, top: 192, width: 430 }}>
          <Eyebrow tone="copper" dark>
            02 · Operation Centre
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 54,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            One reminder.
            <br />
            <span style={{ color: copper }}>Every step visible.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              maxWidth: 350,
            }}
          >
            Track approval, queue progress and the recipient result in one
            place.
          </div>
          <div
            style={{
              marginTop: 28,
              display: "flex",
              alignItems: "center",
              gap: 11,
              color: sage,
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.1em",
            }}
          >
            <Check /> ONE CENTRE · RECIPIENT RESULT
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 112,
            top: 175,
            transform: `translate3d(0, ${trailCardY}px, 0)`,
          }}
        >
          <OperationCentreProgress progress={trailLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={detail}
        style={{ position: "absolute", inset: 0, zIndex: 14 }}
      >
        <div
          style={{
            position: "absolute",
            left: 220,
            right: 220,
            top: 148,
            textAlign: "center",
          }}
        >
          <Eyebrow tone="sage" dark>
            03 · Results
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 64,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Recover the
            <br />
            <span style={{ color: sage }}>failed operation.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              marginLeft: "auto",
              marginRight: "auto",
              maxWidth: 580,
            }}
          >
            Keep the original audience, inspect the recorded result and restart
            the failed operation.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 240 + detailDrift,
            top: 382,
            transform: `scale(${detailScale})`,
            transformOrigin: "top center",
          }}
        >
          <OperationCentreDetail progress={detailLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={provider}
        style={{ position: "absolute", inset: 0, zIndex: 16 }}
      >
        <div
          style={{
            position: "absolute",
            left: 180,
            right: 180,
            top: 142,
            textAlign: "center",
          }}
        >
          <Eyebrow tone="copper" dark>
            04 · Accelevents export
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 60,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Your programme,
            <br />
            <span style={{ color: copper }}>mapped for Accelevents.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              marginLeft: "auto",
              marginRight: "auto",
              maxWidth: 710,
            }}
          >
            Bring published programme, speaker, track, session and room fields
            together in one export-ready package.
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 11,
              marginTop: 17,
              padding: "12px 15px",
              borderRadius: 999,
              background: "rgba(143,191,154,.1)",
              border: "1px solid rgba(143,191,154,.3)",
              color: "#b8e7bf",
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.08em",
            }}
          >
            <Check color="#b8e7bf" /> EXPORT PACKAGE READY
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 25,
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 13,
                border: "1px solid rgba(212,167,44,.3)",
                background: "rgba(212,167,44,.08)",
                color: "#f7d56b",
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              SESSIONS · SPEAKERS · TRACKS · ROOM FIELDS
            </div>
            <div
              style={{
                background: "rgba(143,191,154,.08)",
                border: "1px solid rgba(143,191,154,.28)",
                borderRadius: 13,
                color: sage,
                fontSize: 10,
                fontWeight: 800,
                padding: "10px 13px",
              }}
            >
              ONE CONNECTED EXPORT
            </div>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 292,
            top: 508,
            transform: `translate3d(0, ${providerCardY}px, 0) scale(.88)`,
            transformOrigin: "top center",
          }}
        >
          <ProviderPreview progress={providerLocal} />
        </div>
      </Reveal>
      <FooterRail
        progress={progress}
        items={["contract", "queue", "recovery", "export"]}
      />
    </AbsoluteFill>
  );
}
