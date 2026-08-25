import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  interpolateColors,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE, VIDEO } from "../constants";

type SceneProps = {
  duration: number;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const motion = (
  frame: number,
  input: readonly [number, number],
  output: readonly [number, number],
  easing: (value: number) => number = Easing.inOut(Easing.cubic),
) =>
  interpolate(frame, input, output, {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const fadeIn = (frame: number, start: number, end: number) =>
  motion(frame, [start, end], [0, 1], Easing.out(Easing.quad));

const fadeOut = (frame: number, start: number, end: number) =>
  motion(frame, [start, end], [1, 0], Easing.in(Easing.quad));

const mono: CSSProperties = {
  fontFamily:
    '"SFMono-Regular", "Roboto Mono", "Liberation Mono", ui-monospace, monospace',
  letterSpacing: "0.16em",
  textTransform: "uppercase",
};

const sans: CSSProperties = {
  fontFamily:
    '"Program Cue Inter", Inter, ui-sans-serif, system-ui, sans-serif',
};

function CornerFrame({
  color = PALETTE.copper,
  opacity = 0.36,
  inset = 68,
}: {
  color?: string;
  opacity?: number;
  inset?: number;
}) {
  const stroke = { stroke: color, strokeWidth: 1, fill: "none" };
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${VIDEO.width} ${VIDEO.height}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity,
      }}
    >
      <path
        d={`M${inset} ${inset + 28}V${inset}h28 M${VIDEO.width - inset - 28} ${inset}h28v28`}
        {...stroke}
      />
      <path
        d={`M${inset} ${VIDEO.height - inset - 28}v28h28 M${VIDEO.width - inset - 28} ${VIDEO.height - inset}h28v-28`}
        {...stroke}
      />
      <path
        d={`M${inset + 9} ${inset + 27}V${VIDEO.height - inset - 27} M${VIDEO.width - inset - 9} ${inset + 27}V${VIDEO.height - inset - 27}`}
        stroke={color}
        strokeWidth={0.5}
        strokeDasharray="1 14"
        opacity={0.45}
      />
    </svg>
  );
}

function FilmGrain({
  tone = "light",
  opacity = 0.12,
}: {
  tone?: "light" | "dark";
  opacity?: number;
}) {
  const dots = Array.from({ length: 48 }, (_, index) => {
    const x = (index * 47 + 11) % 100;
    const y = (index * 71 + 19) % 100;
    const size = 1 + ((index * 13) % 3);
    return { x, y, size, delay: (index * 7) % 30 };
  });
  const color = tone === "dark" ? PALETTE.inkDeep : PALETTE.paper;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        mixBlendMode: "soft-light",
        pointerEvents: "none",
      }}
    >
      {dots.map((dot) => (
        <span
          key={`${dot.x}-${dot.y}`}
          style={{
            position: "absolute",
            left: `${dot.x}%`,
            top: `${dot.y}%`,
            width: dot.size,
            height: dot.size,
            borderRadius: "50%",
            background: color,
            opacity: 0.22 + (dot.delay % 5) / 20,
          }}
        />
      ))}
    </div>
  );
}

function GridField({
  frame,
  color = PALETTE.copper,
  opacity = 0.13,
  horizon = 0.66,
}: {
  frame: number;
  color?: string;
  opacity?: number;
  horizon?: number;
}) {
  const drift = (frame * 0.22) % 56;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: `${(1 - horizon) * 100}%`,
        opacity,
        overflow: "hidden",
        maskImage:
          "linear-gradient(to bottom, transparent, black 14%, black 72%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, black 14%, black 72%, transparent)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -56,
          transform: `translateY(${drift}px)`,
          backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
          backgroundSize: "56px 56px",
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(11,20,19,0.96), transparent 24%, transparent 72%, rgba(11,20,19,0.95))",
        }}
      />
    </div>
  );
}

function AccentRule({
  frame,
  width = 180,
  color = PALETTE.copper,
  delay = 0,
  direction = "left",
}: {
  frame: number;
  width?: number;
  color?: string;
  delay?: number;
  direction?: "left" | "right";
}) {
  const progress = fadeIn(frame, delay, delay + 30);
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height: 2,
        background: color,
        transformOrigin: direction === "left" ? "left center" : "right center",
        transform: `scaleX(${progress})`,
        opacity: progress,
      }}
    />
  );
}

function Kicker({
  children,
  color = PALETTE.copper,
  opacity = 1,
}: {
  children: ReactNode;
  color?: string;
  opacity?: number;
}) {
  return (
    <div
      style={{
        ...mono,
        fontSize: 17,
        lineHeight: 1.4,
        color,
        opacity,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function Wordmark({
  frame,
  dark = false,
  size = 34,
  delay = 0,
}: {
  frame: number;
  dark?: boolean;
  size?: number;
  delay?: number;
}) {
  const opacity = fadeIn(frame, delay, delay + 36);
  const translate = motion(
    frame,
    [delay, delay + 40],
    [10, 0],
    Easing.out(Easing.cubic),
  );
  const color = dark ? PALETTE.ink : PALETTE.paper;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        color,
        opacity,
        transform: `translateX(${translate}px)`,
      }}
    >
      <ProgramCueMark size={size} accent={PALETTE.copper} ink={color} />
      <span
        style={{
          ...sans,
          fontSize: size * 0.56,
          letterSpacing: "-0.055em",
          fontWeight: 750,
          whiteSpace: "nowrap",
        }}
      >
        Program Cue
      </span>
    </div>
  );
}

function OrbitalMark({
  frame,
  size,
  dark = false,
  delay = 0,
  opacity = 1,
}: {
  frame: number;
  size: number;
  dark?: boolean;
  delay?: number;
  opacity?: number;
}) {
  const markOpacity = fadeIn(frame, delay, delay + 44) * opacity;
  const turn = motion(
    frame,
    [delay, delay + 300],
    [-7, 10],
    Easing.inOut(Easing.cubic),
  );
  const scale = motion(
    frame,
    [delay, delay + 70],
    [0.86, 1],
    Easing.out(Easing.back(1.1)),
  );
  const line = dark ? PALETTE.ink : PALETTE.paper;
  const glow = dark ? "rgba(190,98,66,0.08)" : "rgba(246,197,169,0.12)";
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: size,
        height: size,
        opacity: markOpacity,
        transform: `scale(${scale}) rotate(${turn}deg)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -size * 0.38,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${glow}, transparent 66%)`,
        }}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke={line}
          strokeOpacity={0.22}
          strokeWidth="0.7"
          strokeDasharray="1 5"
        />
        <circle
          cx="50"
          cy="50"
          r="37"
          fill="none"
          stroke={PALETTE.copper}
          strokeOpacity={0.35}
          strokeWidth="0.65"
          strokeDasharray="22 19"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: size * 0.2,
          display: "grid",
          placeItems: "center",
        }}
      >
        <ProgramCueMark size={size * 0.62} accent={PALETTE.copper} ink={line} />
      </div>
    </div>
  );
}

function TraceField({
  frame,
  dark = true,
  opacity = 1,
}: {
  frame: number;
  dark?: boolean;
  opacity?: number;
}) {
  const line = dark ? PALETTE.paper : PALETTE.ink;
  const draw = motion(frame, [0, 120], [1, 0.1], Easing.out(Easing.cubic));
  const drift = frame * 0.08;
  const traces = [
    {
      d: "M80 228H320L398 306H724",
      width: 1.5,
      dash: "220 760",
      offset: -frame * 5.4,
    },
    {
      d: "M1420 208H1690L1796 314V544",
      width: 1,
      dash: "320 700",
      offset: frame * 4.2,
    },
    {
      d: "M180 844H484L576 752H940",
      width: 1,
      dash: "440 940",
      offset: -frame * 3.6,
    },
    {
      d: "M1110 846H1394L1536 704H1842",
      width: 1.25,
      dash: "380 900",
      offset: frame * 3.1,
    },
    {
      d: "M960 76V198L1040 278V430",
      width: 0.8,
      dash: "220 700",
      offset: frame * 2.5,
    },
  ];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: opacity * draw,
        transform: `translateX(${drift}px)`,
      }}
    >
      {traces.map((trace, index) => (
        <g key={trace.d}>
          <path
            d={trace.d}
            fill="none"
            stroke={line}
            strokeOpacity={0.12}
            strokeWidth={trace.width * 3}
          />
          <path
            d={trace.d}
            fill="none"
            stroke={index % 3 === 0 ? PALETTE.copper : line}
            strokeOpacity={index % 2 === 0 ? 0.5 : 0.28}
            strokeWidth={trace.width}
            strokeDasharray={trace.dash}
            strokeDashoffset={trace.offset}
          />
          <circle
            cx={[398, 1796, 576, 1536, 1040][index]}
            cy={[306, 314, 752, 704, 278][index]}
            r={index % 2 ? 3 : 4}
            fill={index % 3 === 0 ? PALETTE.copper : line}
            fillOpacity={0.7}
          />
        </g>
      ))}
    </svg>
  );
}

function Scanline({
  frame,
  color = PALETTE.copper,
  start = 0,
  opacity = 0.65,
}: {
  frame: number;
  color?: string;
  start?: number;
  opacity?: number;
}) {
  const x = motion(
    frame,
    [start, start + 100],
    [-10, 110],
    Easing.inOut(Easing.cubic),
  );
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${x}%`,
        width: 1,
        opacity,
        background: `linear-gradient(to bottom, transparent, ${color}, transparent)`,
        boxShadow: `0 0 24px ${color}`,
      }}
    />
  );
}

function OpeningPressure({ frame }: { frame: number }) {
  const opacity = fadeOut(frame, 122, 162);
  const productSweep = motion(
    frame,
    [18, 150],
    [-18, 14],
    Easing.out(Easing.cubic),
  );
  const cards = [
    {
      label: "COMMAND CENTRE",
      title: "Know what needs attention",
      detail: "Readiness, owners and next actions in one view.",
      status: "2 ACTIONS",
      color: PALETTE.copperSoft,
      asset: ASSETS.commandCentre,
      position: "center top",
    },
    {
      label: "SCHEDULE PLANNER",
      title: "Resolve schedule changes with confidence",
      detail: "Conflicts and next moves stay visible.",
      status: "IN MOTION",
      color: PALETTE.gold,
      asset: ASSETS.schedulePlanner,
      position: "center top",
    },
    {
      label: "PUBLIC PROGRAMME",
      title: "One programme, every public view",
      detail: "Approved programme details power the attendee experience.",
      status: "LIVE",
      color: PALETTE.sage,
      asset: ASSETS.publicProgramme,
      position: "center top",
    },
  ];
  return (
    <div
      style={{
        left: "8.8%",
        opacity,
        position: "absolute",
        right: "8.8%",
        top: "18.5%",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <Kicker color={PALETTE.copperSoft}>
            PROGRAM CUE / WORKFLOW PREVIEW
          </Kicker>
          <div
            style={{
              ...sans,
              color: PALETTE.paper,
              fontSize: 72,
              fontWeight: 720,
              letterSpacing: "-0.07em",
              lineHeight: 0.98,
              marginTop: 18,
            }}
          >
            Your whole programme.
            <br />
            <span style={{ color: PALETTE.copperSoft }}>Moving as one.</span>
          </div>
        </div>
        <div
          style={{
            ...mono,
            alignSelf: "flex-end",
            color: "rgba(255,253,248,.54)",
            fontSize: 12,
            marginBottom: 8,
            textAlign: "right",
          }}
        >
          ONE CONNECTED WORKSPACE
          <br />
          <span style={{ color: PALETTE.sage }}>EVERY WORKFLOW IN VIEW</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 36 }}>
        {cards.map((card, index) => {
          const earlyPresence = index === 0 ? 0.92 : index === 1 ? 0.74 : 0.58;
          const cardIn =
            earlyPresence +
            (1 - earlyPresence) * fadeIn(frame, index * 4, 18 + index * 6);
          return (
            <div
              key={card.label}
              style={{
                background: "rgba(255,253,248,.075)",
                border: "1px solid rgba(255,253,248,.15)",
                borderRadius: 16,
                flex: 1,
                opacity: cardIn,
                overflow: "hidden",
                padding: 0,
                transform: `translateY(${(1 - cardIn) * 20}px)`,
              }}
            >
              <div
                style={{
                  height: 114,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <Img
                  alt={`${card.label.toLowerCase()} Program Cue interface`}
                  src={card.asset}
                  style={{
                    display: "block",
                    height: "142%",
                    objectFit: "cover",
                    objectPosition: card.position,
                    transform: `translateX(${productSweep * (index % 2 === 0 ? 1 : -1)}px) translateY(-8px) scale(1.02)`,
                    width: "112%",
                  }}
                />
                <div
                  aria-hidden="true"
                  style={{
                    background:
                      "linear-gradient(to bottom, transparent 38%, rgba(11,20,19,.84))",
                    inset: 0,
                    position: "absolute",
                  }}
                />
              </div>
              <div style={{ padding: "17px 19px 18px" }}>
                <div
                  style={{
                    ...mono,
                    color: card.color,
                    display: "flex",
                    fontSize: 10,
                    justifyContent: "space-between",
                  }}
                >
                  <span>{card.label}</span>
                  <span>{card.status}</span>
                </div>
                <div
                  style={{
                    ...sans,
                    color: PALETTE.paper,
                    fontSize: 20,
                    fontWeight: 740,
                    letterSpacing: "-0.035em",
                    marginTop: 18,
                  }}
                >
                  {card.title}
                </div>
                <div
                  style={{
                    ...sans,
                    color: "rgba(255,253,248,.58)",
                    fontSize: 13,
                    marginTop: 8,
                  }}
                >
                  {card.detail}
                </div>
                <div
                  style={{
                    background: card.color,
                    height: 2,
                    marginTop: 20,
                    transform: `scaleX(${cardIn})`,
                    transformOrigin: "left",
                    width: `${42 + index * 16}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OpeningTitle({ frame }: { frame: number }) {
  const intro = fadeIn(frame, 154, 208);
  const y = motion(frame, [154, 220], [32, 0], Easing.out(Easing.cubic));
  const settle = fadeOut(frame, 430, 500);
  return (
    <div
      style={{
        opacity: intro * settle,
        transform: `translateY(${y}px)`,
        maxWidth: 910,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          marginBottom: 28,
        }}
      >
        <AccentRule frame={frame} width={184} delay={28} />
        <Kicker>CONFERENCE PROGRAMME OPERATIONS</Kicker>
      </div>
      <h1
        style={{
          ...sans,
          margin: 0,
          color: PALETTE.paper,
          fontSize: 108,
          lineHeight: 0.99,
          letterSpacing: "-0.075em",
          fontWeight: 690,
        }}
      >
        Run the programme,
        <br />
        <span style={{ color: PALETTE.copperSoft }}>not the spreadsheet.</span>
      </h1>
      <p
        style={{
          ...sans,
          margin: "38px 0 0",
          width: 580,
          color: "rgba(255,253,248,0.66)",
          fontSize: 24,
          lineHeight: 1.42,
          letterSpacing: "-0.02em",
        }}
      >
        Keep submissions, reviews, speakers, scheduling and publication
        connected from the first proposal to the live programme.
      </p>
    </div>
  );
}

function OpeningProductProof({ frame }: { frame: number }) {
  const opacity = fadeIn(frame, 278, 320) * fadeOut(frame, 478, 516);
  const lift = motion(frame, [278, 344], [24, 0], Easing.out(Easing.cubic));
  const scale = motion(frame, [278, 344], [0.97, 1], Easing.out(Easing.cubic));
  return (
    <div
      style={{
        bottom: "10.3%",
        opacity,
        position: "absolute",
        right: "8.2%",
        transform: `translateY(${lift}px) scale(${scale})`,
        transformOrigin: "right bottom",
        width: 650,
        zIndex: 5,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <Kicker color={PALETTE.copperSoft}>COMMAND CENTRE IN ACTION</Kicker>
        <span
          style={{
            ...mono,
            color: PALETTE.sage,
            fontSize: 11,
          }}
        >
          READINESS · PUBLICATION · SHARE
        </span>
      </div>
      <div
        style={{
          background: PALETTE.paper,
          border: "1px solid rgba(246,197,169,.34)",
          borderRadius: 16,
          boxShadow:
            "0 28px 70px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "rgba(19,32,31,.98)",
            borderBottom: "1px solid rgba(255,253,248,.12)",
            color: "rgba(255,253,248,.76)",
            display: "flex",
            fontSize: 11,
            gap: 11,
            height: 32,
            letterSpacing: "0.02em",
            padding: "0 13px",
          }}
        >
          <span style={{ display: "flex", gap: 5 }} aria-hidden="true">
            {["#f27a60", "#f3c761", "#77ba85"].map((color) => (
              <span
                key={color}
                style={{
                  background: color,
                  borderRadius: "50%",
                  height: 7,
                  width: 7,
                }}
              />
            ))}
          </span>
          <span>app.programcue.com / Command Centre</span>
          <span
            style={{
              ...mono,
              color: PALETTE.sage,
              fontSize: 9,
              marginLeft: "auto",
            }}
          >
            COMMAND CENTRE
          </span>
        </div>
        <div style={{ height: 284, overflow: "hidden" }}>
          <Img
            alt="Program Cue command centre capture"
            src={ASSETS.commandCentre}
            style={{
              display: "block",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center top",
              width: "100%",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function OpeningIndex({ frame }: { frame: number }) {
  const opacity = fadeIn(frame, 116, 160) * fadeOut(frame, 448, 520);
  const progress = motion(frame, [118, 522], [0, 1], Easing.linear);
  return (
    <div style={{ opacity, display: "flex", alignItems: "center", gap: 20 }}>
      <span
        style={{ ...mono, color: PALETTE.paper, fontSize: 15, opacity: 0.55 }}
      >
        01
      </span>
      <div
        style={{
          width: 284,
          height: 1,
          background: "rgba(255,253,248,0.22)",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "0 auto 0 0",
            width: `${progress * 100}%`,
            background: PALETTE.copper,
          }}
        />
      </div>
      <span
        style={{ ...mono, color: PALETTE.paper, fontSize: 15, opacity: 0.55 }}
      >
        13
      </span>
    </div>
  );
}

export function OpeningScene({ duration }: SceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 540;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const { width, height } = useVideoConfig();
  const safeScale = Math.min(width / VIDEO.width, height / VIDEO.height);
  const progress = clamp(frame / sourceDuration);
  const wash = 1;
  const closing = fadeOut(
    frame,
    Math.max(0, sourceDuration - 18),
    sourceDuration,
  );
  const mark = 0.76 + 0.24 * fadeIn(frame, 0, 42);
  const titleScale = motion(
    frame,
    [0, 390],
    [1.04, 1],
    Easing.out(Easing.cubic),
  );
  const side = motion(
    frame,
    [0, sourceDuration],
    [-32, 18],
    Easing.inOut(Easing.cubic),
  );

  return (
    <AbsoluteFill
      style={{
        ...sans,
        background: `radial-gradient(circle at 52% 42%, #1f302c 0%, ${PALETTE.inkDeep} 56%, #070c0c 100%)`,
        color: PALETTE.paper,
        overflow: "hidden",
        opacity: wash * closing,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(115deg, rgba(190,98,66,0.10), transparent 34%, rgba(143,191,154,0.06) 72%, transparent)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10%",
          top: "-38%",
          width: "68%",
          height: "120%",
          borderRadius: "50%",
          border: "1px solid rgba(246,197,169,0.09)",
          transform: `rotate(${side}deg)`,
          boxShadow: "0 0 80px rgba(190,98,66,0.05)",
        }}
      />
      <GridField frame={frame} />
      <TraceField frame={frame} />
      <Scanline frame={frame} start={24} opacity={0.35} />
      <CornerFrame
        color={PALETTE.copperSoft}
        opacity={0.42 * mark}
        inset={78}
      />
      <FilmGrain tone="light" opacity={0.1} />

      <div
        style={{
          position: "absolute",
          left: "8.2%",
          top: "7.5%",
          right: "8.2%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          opacity: mark,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <ProgramCueMark
            size={38}
            accent={PALETTE.copper}
            ink={PALETTE.paper}
          />
          <div>
            <div
              style={{
                ...sans,
                fontWeight: 760,
                fontSize: 21,
                letterSpacing: "-0.04em",
              }}
            >
              Program Cue
            </div>
            <div
              style={{
                ...mono,
                marginTop: 7,
                fontSize: 12,
                color: PALETTE.copperSoft,
                opacity: 0.8,
              }}
            >
              PRODUCT FILM / 01
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ ...mono, fontSize: 14, color: PALETTE.copperSoft }}>
            THE COMPLETE PROGRAMME JOURNEY
          </div>
          <div
            style={{
              ...sans,
              marginTop: 8,
              fontSize: 16,
              color: "rgba(255,253,248,0.52)",
            }}
          >
            Program Cue · 2026
          </div>
        </div>
      </div>

      <OpeningPressure frame={frame} />

      <div
        style={{
          position: "absolute",
          left: "14.6%",
          top: "26.8%",
          transform: `scale(${titleScale})`,
          transformOrigin: "left top",
        }}
      >
        <OpeningTitle frame={frame} />
      </div>

      <div
        style={{
          position: "absolute",
          left: "8.2%",
          bottom: "8.2%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          width: "83.6%",
        }}
      >
        <OpeningIndex frame={frame} />
        <div
          style={{
            textAlign: "right",
            opacity: fadeIn(frame, 170, 220) * fadeOut(frame, 455, 515),
          }}
        >
          <div
            style={{
              ...mono,
              color: PALETTE.paper,
              fontSize: 14,
              opacity: 0.52,
            }}
          >
            FROM FIRST PROPOSAL
          </div>
          <div
            style={{
              ...mono,
              color: PALETTE.copperSoft,
              fontSize: 14,
              marginTop: 9,
            }}
          >
            TO PUBLISHED PROGRAMME
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: "14.7%",
          top: "38%",
          opacity: fadeIn(frame, 180, 250) * fadeOut(frame, 460, 515),
        }}
      >
        <OrbitalMark frame={frame} size={168 * safeScale} delay={176} />
      </div>
      <div
        style={{
          position: "absolute",
          right: "14.8%",
          top: "59.5%",
          display: "flex",
          gap: 14,
          alignItems: "center",
          opacity:
            fadeIn(frame, 236, 280) *
            fadeOut(frame, 252, 292) *
            fadeOut(frame, 465, 515),
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: PALETTE.sage,
          }}
        />
        <span
          style={{ ...mono, fontSize: 12, color: "rgba(255,253,248,0.64)" }}
        >
          ONE PROGRAMME OPERATIONS WORKSPACE
        </span>
      </div>

      <OpeningProductProof frame={frame} />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          opacity: progress * 0.08,
          background:
            "radial-gradient(circle at 50% 44%, transparent 0 26%, rgba(246,197,169,0.38) 26.2%, transparent 26.4%)",
        }}
      />
    </AbsoluteFill>
  );
}

function RevealArchitecture({ frame }: { frame: number }) {
  const opacity =
    frame >= 404 ? 0 : fadeIn(frame, 92, 140) * fadeOut(frame, 338, 404);
  const lift = motion(frame, [90, 190], [40, 0], Easing.out(Easing.cubic));
  const cards = [
    { label: "SHAPE", text: "Brief → call → collect", accent: PALETTE.copper },
    {
      label: "DECIDE",
      text: "Review → prepare",
      accent: PALETTE.sageDeep,
    },
    {
      label: "SHARE",
      text: "Communicate → place → publish",
      accent: PALETTE.gold,
    },
  ];
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${lift}px)`,
        display: "flex",
        gap: 16,
      }}
    >
      {cards.map((card, index) => {
        const cardIn = fadeIn(frame, 125 + index * 18, 165 + index * 18);
        return (
          <div
            key={card.label}
            style={{
              width: 245,
              minHeight: 120,
              padding: "20px 20px 18px",
              background: "rgba(255,253,248,0.74)",
              border: "1px solid rgba(24,37,34,0.12)",
              boxShadow: "0 18px 38px rgba(24,37,34,0.08)",
              opacity: cardIn,
              transform: `translateY(${(1 - cardIn) * 18}px)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 15,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: card.accent,
                }}
              />
              <span
                style={{
                  ...mono,
                  color: PALETTE.muted,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {card.label}
              </span>
            </div>
            <div
              style={{
                ...sans,
                color: PALETTE.ink,
                fontSize: 17,
                lineHeight: 1.25,
                letterSpacing: "-0.025em",
                fontWeight: 620,
              }}
            >
              {card.text}
            </div>
            <div
              style={{
                height: 2,
                width: `${54 + index * 21}%`,
                background: card.accent,
                marginTop: 18,
                opacity: 0.8,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function RevealHandoff({ frame }: { frame: number }) {
  const opacity = fadeIn(frame, 368, 428) * fadeOut(frame, 562, 596);
  const lift = motion(frame, [368, 448], [34, 0], Easing.out(Easing.cubic));
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 54,
        opacity,
        transform: `translateY(${lift}px)`,
        width: 1540,
      }}
    >
      <div style={{ width: 430 }}>
        <Kicker color={PALETTE.copperDeep}>
          COMMAND CENTRE / PROGRAMME PULSE
        </Kicker>
        <div
          style={{
            ...sans,
            color: PALETTE.ink,
            fontSize: 60,
            fontWeight: 720,
            letterSpacing: "-0.07em",
            lineHeight: 0.98,
            marginTop: 20,
          }}
        >
          Know where the
          <br />
          <span style={{ color: PALETTE.copper }}>programme stands.</span>
        </div>
        <p
          style={{
            ...sans,
            color: PALETTE.muted,
            fontSize: 18,
            lineHeight: 1.45,
            margin: "24px 0 0",
          }}
        >
          Readiness, priorities, owners and next actions stay connected to the
          work.
        </p>
        <div
          style={{
            ...mono,
            color: PALETTE.sageDeep,
            fontSize: 10,
            marginTop: 28,
          }}
        >
          READINESS AT A GLANCE
        </div>
      </div>
      <div
        style={{
          background: PALETTE.paper,
          border: "1px solid rgba(24,37,34,.16)",
          borderRadius: 24,
          boxShadow: "0 34px 90px rgba(24,37,34,.18)",
          height: 560,
          overflow: "hidden",
          position: "relative",
          width: 1000,
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "rgba(255,255,255,.94)",
            borderBottom: "1px solid rgba(24,37,34,.11)",
            color: PALETTE.muted,
            display: "flex",
            fontSize: 10,
            fontWeight: 800,
            height: 42,
            justifyContent: "space-between",
            left: 0,
            letterSpacing: "0.1em",
            padding: "0 16px",
            position: "absolute",
            right: 0,
            top: 0,
            zIndex: 2,
          }}
        >
          <span>PROGRAM CUE / COMMAND CENTRE</span>
          <span>WORKFLOW SIGNALS</span>
        </div>
        <Img
          src={ASSETS.commandCentre}
          style={{
            boxSizing: "border-box",
            display: "block",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center top",
            paddingTop: 42,
            width: "100%",
          }}
        />
      </div>
    </div>
  );
}

function RevealTitle({ frame }: { frame: number }) {
  const opacity = fadeIn(frame, 24, 75) * fadeOut(frame, 332, 398);
  const lift = motion(frame, [24, 95], [32, 0], Easing.out(Easing.cubic));
  return (
    <div style={{ opacity, transform: `translateY(${lift}px)`, maxWidth: 620 }}>
      <Kicker color={PALETTE.copperDeep}>THE PRODUCT, IN ONE VIEW</Kicker>
      <h2
        style={{
          ...sans,
          color: PALETTE.ink,
          margin: "22px 0 0",
          fontSize: 68,
          lineHeight: 1.03,
          letterSpacing: "-0.07em",
          fontWeight: 690,
        }}
      >
        One workspace for
        <br />
        <span style={{ color: PALETTE.copper }}>the programme lifecycle.</span>
      </h2>
      <p
        style={{
          ...sans,
          color: PALETTE.muted,
          margin: "27px 0 0",
          fontSize: 21,
          lineHeight: 1.42,
          letterSpacing: "-0.018em",
          maxWidth: 500,
        }}
      >
        Program Cue connects event setup, submissions, review, scheduling and
        publication.
      </p>
    </div>
  );
}

export function RevealScene({ duration }: SceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 600;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const progress = clamp(frame / sourceDuration);
  const background = interpolateColors(
    frame,
    [0, 92, sourceDuration],
    [PALETTE.inkDeep, PALETTE.editorial, PALETTE.editorial],
  );
  const reveal = fadeIn(frame, 0, 36);
  const exit = fadeOut(frame, Math.max(0, sourceDuration - 18), sourceDuration);
  const sweep = motion(
    frame,
    [0, sourceDuration],
    [-20, 28],
    Easing.inOut(Easing.cubic),
  );
  return (
    <AbsoluteFill
      style={{
        ...sans,
        color: PALETTE.ink,
        background,
        overflow: "hidden",
        opacity: reveal * exit,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 72% 38%, rgba(190,98,66,${0.16 - progress * 0.08}), transparent 35%), linear-gradient(120deg, rgba(255,255,255,0.5), transparent 42%)`,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          width: "82vw",
          height: "82vw",
          right: "-24vw",
          top: "-38vw",
          border: "1px solid rgba(190,98,66,0.14)",
          borderRadius: "50%",
          transform: `rotate(${sweep}deg)`,
        }}
      />
      <GridField
        frame={frame}
        color={PALETTE.ink}
        opacity={0.065}
        horizon={0.44}
      />
      <TraceField frame={frame} dark={false} opacity={0.35} />
      <Scanline frame={frame} color={PALETTE.copper} start={8} opacity={0.18} />
      <CornerFrame color={PALETTE.ink} opacity={0.23 * reveal} inset={78} />
      <FilmGrain tone="dark" opacity={0.08} />

      <div
        style={{
          position: "absolute",
          left: "8.2%",
          right: "8.2%",
          top: "7.4%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Wordmark frame={frame} dark size={35} delay={36} />
        <div
          style={{
            ...mono,
            color: PALETTE.muted,
            fontSize: 13,
            textAlign: "right",
            opacity: fadeIn(frame, 88, 130),
          }}
        >
          <span style={{ color: PALETTE.copperDeep }}>02 / 13</span>
          <span style={{ marginLeft: 20, opacity: 0.7 }}>WORKFLOW</span>
        </div>
      </div>

      <div style={{ position: "absolute", left: "12.5%", top: "24.8%" }}>
        <RevealTitle frame={frame} />
      </div>

      <div
        style={{
          position: "absolute",
          right: "13.1%",
          top: "21.3%",
          width: 410,
          height: 410,
          display: "grid",
          placeItems: "center",
          opacity: fadeOut(frame, 338, 414),
        }}
      >
        <OrbitalMark frame={frame} size={258} dark delay={28} />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "1px solid rgba(24,37,34,0.13)",
            transform: `rotate(${sweep * -1.7}deg)`,
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 35,
            borderRadius: "50%",
            border: "1px solid rgba(190,98,66,0.24)",
            borderLeftColor: "transparent",
            borderBottomColor: "transparent",
            transform: `rotate(${frame * 0.35}deg)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: -12,
            top: 72,
            ...mono,
            color: PALETTE.copperDeep,
            fontSize: 11,
            opacity: fadeIn(frame, 180, 225),
          }}
        >
          SHARED STATUS
        </div>
      </div>

      <div style={{ position: "absolute", left: "12.5%", bottom: "16.5%" }}>
        <RevealArchitecture frame={frame} />
      </div>

      <div style={{ left: "9.9%", position: "absolute", top: "19.3%" }}>
        <RevealHandoff frame={frame} />
      </div>

      <div
        style={{
          position: "absolute",
          left: "8.2%",
          right: "8.2%",
          bottom: "7.7%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          opacity: fadeIn(frame, 148, 205) * fadeOut(frame, 538, 592),
        }}
      >
        <div style={{ ...mono, color: PALETTE.muted, fontSize: 12 }}>
          FROM FIRST PROPOSAL TO PUBLISHED PROGRAMME
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div
            style={{
              width: 220,
              height: 1,
              background: "rgba(24,37,34,0.16)",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: "0 auto 0 0",
                width: `${Math.min(100, progress * 116)}%`,
                background: PALETTE.copper,
              }}
            />
          </div>
          <span style={{ ...mono, color: PALETTE.copperDeep, fontSize: 12 }}>
            PROGRAMME / 01
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ClosingRails({
  frame,
  duration,
}: {
  frame: number;
  duration: number;
}) {
  const progress = clamp(frame / Math.max(duration, 1));
  const line = fadeIn(frame, 42, 105);
  const path = "M0 0H180L248 68H570L644 0H948L1020 72H1260L1336 0H1920";
  const second = "M0 96H360L408 48H780L824 96H1124L1180 40H1590L1648 96H1920";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1920 160"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "21%",
        width: "100%",
        height: 160,
        opacity: line,
      }}
    >
      <path
        d={path}
        fill="none"
        stroke={PALETTE.paper}
        strokeOpacity={0.12}
        strokeWidth="1"
      />
      <path
        d={path}
        fill="none"
        stroke={PALETTE.copperSoft}
        strokeOpacity={0.72}
        strokeWidth="2"
        strokeDasharray="260 820"
        strokeDashoffset={-frame * 7}
      />
      <path
        d={second}
        fill="none"
        stroke={PALETTE.paper}
        strokeOpacity={0.08}
        strokeWidth="1"
        strokeDasharray="1 11"
      />
      <circle
        cx={progress * 1920}
        cy="0"
        r="5"
        fill={PALETTE.copperSoft}
        opacity={0.9}
      />
      <circle
        cx={progress * 1920}
        cy="0"
        r="15"
        fill="none"
        stroke={PALETTE.copperSoft}
        strokeOpacity={0.24}
      />
    </svg>
  );
}

function ClosingTitle({
  frame,
  duration,
}: {
  frame: number;
  duration: number;
}) {
  const opacity = fadeIn(frame, 12, 66);
  const lift = motion(frame, [12, 82], [42, 0], Easing.out(Easing.cubic));
  const settle = fadeOut(frame, duration - 294, duration - 246);
  return (
    <div
      style={{
        opacity: opacity * settle,
        transform: `translateY(${lift}px)`,
        maxWidth: 980,
      }}
    >
      <Kicker color={PALETTE.copperSoft}>PROGRAMME OPERATIONS</Kicker>
      <h2
        style={{
          ...sans,
          margin: "25px 0 0",
          fontSize: 102,
          lineHeight: 0.98,
          letterSpacing: "-0.08em",
          fontWeight: 690,
          color: PALETTE.paper,
        }}
      >
        From first proposal
        <br />
        <span style={{ color: PALETTE.copperSoft, fontSize: 88 }}>
          to published programme.
        </span>
      </h2>
      <p
        style={{
          ...sans,
          margin: "31px 0 0",
          fontSize: 25,
          lineHeight: 1.42,
          maxWidth: 620,
          color: "rgba(255,253,248,0.63)",
          letterSpacing: "-0.02em",
        }}
      >
        Program Cue links submissions, decisions, speaker work, schedule changes
        and operations in one event workspace.
      </p>
    </div>
  );
}

function ClosingDetails({
  frame,
  duration,
}: {
  frame: number;
  duration: number;
}) {
  const opacity =
    fadeIn(frame, 165, 230) * fadeOut(frame, duration - 306, duration - 258);
  return (
    <div
      style={{
        borderTop: `1px solid ${PALETTE.copperSoft}`,
        opacity,
        paddingTop: 18,
        width: 680,
      }}
    >
      <div style={{ ...mono, color: PALETTE.copperSoft, fontSize: 12 }}>
        WORKFLOW CONTROL
      </div>
      <div
        style={{
          ...sans,
          color: "rgba(255,253,248,0.9)",
          fontSize: 25,
          letterSpacing: "-0.035em",
          lineHeight: 1.22,
          marginTop: 13,
        }}
      >
        One programme. Every workflow. Fully connected.
      </div>
    </div>
  );
}

function ClosingCta({ frame, duration }: { frame: number; duration: number }) {
  const opacity = fadeIn(frame, duration - 246, duration - 186);
  const lift = motion(
    frame,
    [duration - 246, duration - 180],
    [26, 0],
    Easing.out(Easing.cubic),
  );
  const charge = motion(
    frame,
    [duration - 236, duration - 180],
    [-46, 38],
    Easing.out(Easing.cubic),
  );
  const urlScale = motion(
    frame,
    [duration - 240, duration - 180],
    [0.94, 1],
    Easing.out(Easing.back(1.35)),
  );
  return (
    <div
      style={{
        display: "grid",
        inset: 0,
        opacity,
        placeItems: "center",
        position: "absolute",
        textAlign: "center",
        transform: `translateY(${lift}px)`,
        zIndex: 20,
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(112deg, #fffdf8 0%, #fff5ed 56%, #f4d7c2 100%)",
          border: "1px solid rgba(246,197,169,.78)",
          borderRadius: 22,
          boxShadow:
            "0 42px 110px rgba(0,0,0,.42), 0 10px 28px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.9)",
          color: PALETTE.ink,
          display: "grid",
          gap: 32,
          gridTemplateColumns: "1fr 274px",
          minHeight: 372,
          overflow: "hidden",
          padding: "34px 38px 32px",
          position: "relative",
          width: 1048,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            background: PALETTE.copper,
            height: 4,
            left: 0,
            position: "absolute",
            right: 0,
            top: 0,
          }}
        />
        <div
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(190,98,66,.2), transparent)",
            height: 180,
            left: -220,
            position: "absolute",
            top: 104,
            transform: `translateX(${charge * 9}px) rotate(-10deg)`,
            width: 620,
          }}
        />
        <div style={{ alignContent: "center", display: "grid" }}>
          <div style={{ alignItems: "center", display: "flex", gap: 14 }}>
            <ProgramCueMark
              accent={PALETTE.copper}
              ink={PALETTE.ink}
              size={54}
            />
            <div>
              <div
                style={{
                  ...mono,
                  color: PALETTE.copperDeep,
                  fontSize: 11,
                }}
              >
                CONFERENCE OPERATIONS
              </div>
              <div
                style={{
                  ...sans,
                  color: PALETTE.ink,
                  fontSize: 29,
                  fontWeight: 760,
                  letterSpacing: "-0.06em",
                  marginTop: 5,
                }}
              >
                Program Cue
              </div>
            </div>
          </div>
          <div
            style={{
              ...mono,
              color: PALETTE.copperDeep,
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: "0.22em",
              marginTop: 30,
            }}
          >
            SEE HOW IT WORKS
          </div>
          <div
            style={{
              background: PALETTE.inkDeep,
              border: `2px solid ${PALETTE.copper}`,
              borderRadius: 16,
              boxShadow:
                "0 20px 44px rgba(24,37,34,.24), inset 0 0 0 1px rgba(255,253,248,.08)",
              color: PALETTE.paper,
              marginTop: 11,
              overflow: "hidden",
              padding: "20px 24px 22px",
              position: "relative",
              transform: `scale(${urlScale})`,
              transformOrigin: "left center",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                background:
                  "linear-gradient(90deg, rgba(246,197,169,.18), transparent 62%)",
                inset: 0,
                position: "absolute",
                transform: `translateX(${charge}px)`,
              }}
            />
            <div
              style={{
                ...sans,
                fontSize: 64,
                fontWeight: 840,
                letterSpacing: "-0.065em",
                lineHeight: 0.94,
                position: "relative",
              }}
            >
              PROGRAMCUE.COM
            </div>
          </div>
          <div
            style={{
              ...sans,
              color: PALETTE.muted,
              fontSize: 18,
              letterSpacing: "-0.02em",
              marginTop: 15,
            }}
          >
            One connected workspace for conference programme operations.
          </div>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 16,
              marginTop: 26,
            }}
          >
            <span style={{ ...mono, color: PALETTE.muted, fontSize: 11 }}>
              From first proposal to published programme
            </span>
          </div>
        </div>
        <div style={{ alignSelf: "center" }}>
          <div
            style={{
              ...mono,
              color: PALETTE.copperDeep,
              fontSize: 10,
              marginBottom: 10,
            }}
          >
            COMMAND CENTRE
          </div>
          <div
            style={{
              border: "1px solid rgba(24,37,34,.18)",
              borderRadius: 13,
              boxShadow: "0 12px 24px rgba(24,37,34,.12)",
              height: 184,
              overflow: "hidden",
              position: "relative",
              width: 282,
            }}
          >
            <Img
              alt="Program Cue command centre snapshot"
              src={ASSETS.commandCentre}
              style={{
                display: "block",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
                width: "100%",
              }}
            />
            <div
              aria-hidden="true"
              style={{
                background: `linear-gradient(90deg, transparent, ${PALETTE.copperSoft}, transparent)`,
                bottom: 0,
                height: 3,
                left: 0,
                position: "absolute",
                transform: `translateX(${charge * 2.2}px)`,
                width: "55%",
              }}
            />
          </div>
          <div
            style={{
              display: "grid",
              gap: 7,
              gridTemplateColumns: "1fr 1fr",
              marginTop: 11,
            }}
          >
            {[ASSETS.schedulePlanner, ASSETS.publicProgramme].map(
              (asset, index) => (
                <div
                  key={index === 0 ? "schedule" : "public"}
                  style={{
                    border: "1px solid rgba(24,37,34,.14)",
                    borderRadius: 9,
                    height: 54,
                    overflow: "hidden",
                  }}
                >
                  <Img
                    alt={
                      index === 0
                        ? "Program Cue schedule planner snapshot"
                        : "Program Cue public programme snapshot"
                    }
                    src={asset}
                    style={{
                      display: "block",
                      height: "100%",
                      objectFit: "cover",
                      objectPosition: "center top",
                      width: "100%",
                    }}
                  />
                </div>
              ),
            )}
          </div>
          <div
            style={{
              ...mono,
              color: PALETTE.muted,
              fontSize: 10,
              lineHeight: 1.4,
              marginTop: 10,
            }}
          >
            READINESS 75% · 2 CONDITIONS
          </div>
        </div>
      </div>
    </div>
  );
}

export function ClosingScene({ duration }: SceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 780;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const { width, height } = useVideoConfig();
  const scale = Math.min(width / VIDEO.width, height / VIDEO.height);
  const reveal = fadeIn(frame, 0, 18);
  const exit = fadeOut(frame, sourceDuration - 28, sourceDuration - 1);
  const progress = clamp(frame / sourceDuration);
  const orb = motion(
    frame,
    [0, sourceDuration],
    [-12, 8],
    Easing.inOut(Easing.cubic),
  );
  const warm = interpolateColors(
    frame,
    [0, 280, sourceDuration],
    [PALETTE.inkDeep, PALETTE.nav, PALETTE.inkDeep],
  );
  return (
    <AbsoluteFill
      style={{
        ...sans,
        background: warm,
        color: PALETTE.paper,
        overflow: "hidden",
        opacity: reveal * exit,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 79% 33%, rgba(190,98,66,0.18), transparent 34%), radial-gradient(circle at 18% 85%, rgba(143,191,154,0.10), transparent 36%)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 1020 * scale,
          height: 1020 * scale,
          right: -310 * scale,
          top: -360 * scale,
          borderRadius: "50%",
          border: "1px solid rgba(246,197,169,0.14)",
          transform: `rotate(${orb}deg)`,
          boxShadow: "0 0 100px rgba(190,98,66,0.05)",
        }}
      />
      <GridField frame={frame} opacity={0.09} horizon={0.42} />
      <TraceField frame={frame} opacity={0.54} />
      <Scanline
        frame={frame}
        color={PALETTE.copperSoft}
        start={74}
        opacity={0.24}
      />
      <ClosingRails frame={frame} duration={sourceDuration} />
      <CornerFrame
        color={PALETTE.copperSoft}
        opacity={0.38 * reveal}
        inset={78}
      />
      <FilmGrain tone="light" opacity={0.1} />

      <div
        style={{
          position: "absolute",
          left: "8.2%",
          right: "8.2%",
          top: "7.4%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          opacity: fadeIn(frame, 35, 88),
        }}
      >
        <Wordmark frame={frame} size={35} delay={36} />
        <div
          style={{
            ...mono,
            color: PALETTE.copperSoft,
            fontSize: 13,
            textAlign: "right",
          }}
        >
          <span>13 / 13</span>
          <span style={{ marginLeft: 20, color: "rgba(255,253,248,0.5)" }}>
            PRODUCT FILM
          </span>
        </div>
      </div>

      <div style={{ position: "absolute", left: "12.5%", top: "24.5%" }}>
        <ClosingTitle frame={frame} duration={duration} />
      </div>

      <div
        style={{
          position: "absolute",
          right: "14.5%",
          top: "29%",
          display: "grid",
          placeItems: "center",
        }}
      >
        <OrbitalMark frame={frame} size={240 * scale} delay={108} />
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 26px)",
            left: "50%",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            ...mono,
            color: PALETTE.copperSoft,
            fontSize: 12,
            opacity: fadeIn(frame, 195, 248),
          }}
        >
          PROGRAMME / WORKFLOW
        </div>
      </div>

      <div style={{ position: "absolute", left: "12.5%", bottom: "9.7%" }}>
        <ClosingDetails frame={frame} duration={duration} />
      </div>

      <div
        style={{
          position: "absolute",
          right: "8.2%",
          bottom: "8.2%",
          textAlign: "right",
          opacity:
            fadeIn(frame, 240, 300) *
            fadeOut(frame, duration - 294, duration - 246),
        }}
      >
        <div style={{ ...mono, color: PALETTE.copperSoft, fontSize: 13 }}>
          PROGRAM CUE
        </div>
        <div
          style={{
            ...sans,
            color: "rgba(255,253,248,0.56)",
            fontSize: 16,
            marginTop: 9,
          }}
        >
          Built for conference programme operations.
        </div>
      </div>

      <ClosingCta frame={frame} duration={duration} />

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 1,
          height: "20%",
          transform: "translate(-50%, -50%)",
          background: `linear-gradient(to bottom, transparent, ${PALETTE.copperSoft}, transparent)`,
          opacity: progress * 0.12,
        }}
      />
    </AbsoluteFill>
  );
}
