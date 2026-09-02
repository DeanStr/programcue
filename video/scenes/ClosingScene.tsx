import {
  AbsoluteFill,
  Easing,
  Img,
  interpolateColors,
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
  Wordmark,
} from "./BrandSceneShared";

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
