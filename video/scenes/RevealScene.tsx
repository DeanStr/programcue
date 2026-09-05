import {
  AbsoluteFill,
  Easing,
  Img,
  interpolateColors,
  useCurrentFrame,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
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
          COMMAND CENTRE / PROGRAM PULSE
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
          <span style={{ color: PALETTE.copper }}>program stands.</span>
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
        <span style={{ color: PALETTE.copper }}>the program lifecycle.</span>
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
          FROM FIRST PROPOSAL TO PUBLISHED PROGRAM
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
            PROGRAM / 01
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
