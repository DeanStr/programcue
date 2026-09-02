import {
  AbsoluteFill,
  Easing,
  Img,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE, VIDEO } from "../constants";
import {
  CornerFrame,
  clamp,
  FilmGrain,
  fadeIn,
  fadeOut,
  GridField,
  Kicker,
  mono,
  motion,
  OrbitalMark,
  Scanline,
  type SceneProps,
  sans,
  TraceField,
} from "./BrandSceneShared";

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
