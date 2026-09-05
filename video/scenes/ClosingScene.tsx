import { AbsoluteFill, Easing, Img, useCurrentFrame } from "remotion";

import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";
import {
  CornerFrame,
  FilmGrain,
  fadeIn,
  fadeOut,
  motion,
  type SceneProps,
  sans,
} from "./BrandSceneShared";

function JourneyResolve({ frame }: { frame: number }) {
  const enter = fadeIn(frame, 8, 54);
  const exit = fadeOut(frame, 170, 234);
  const titleLift = motion(frame, [8, 68], [30, 0], Easing.out(Easing.cubic));
  const productIn = fadeIn(frame, 46, 110);
  const productLift = motion(
    frame,
    [46, 122],
    [44, 0],
    Easing.out(Easing.cubic),
  );
  const imagePan = motion(
    frame,
    [94, 250],
    [0, 3.2],
    Easing.inOut(Easing.cubic),
  );

  return (
    <AbsoluteFill style={{ opacity: enter * exit }}>
      <div
        style={{
          left: 240,
          position: "absolute",
          right: 240,
          textAlign: "center",
          top: 126,
          transform: `translateY(${titleLift}px)`,
        }}
      >
        <div
          style={{
            ...sans,
            color: PALETTE.copperSoft,
            fontSize: 17,
            fontWeight: 650,
            letterSpacing: "0.01em",
          }}
        >
          One program, fully connected
        </div>
        <h2
          style={{
            ...sans,
            color: PALETTE.paper,
            fontFeatureSettings: '"cv05", "cv11"',
            fontSize: 84,
            fontWeight: 700,
            letterSpacing: "-0.067em",
            lineHeight: 0.96,
            margin: "24px 0 0",
          }}
        >
          From first proposal
          <br />
          <span style={{ color: PALETTE.copperSoft }}>
            to published program.
          </span>
        </h2>
      </div>

      <div
        style={{
          left: 440,
          opacity: productIn,
          position: "absolute",
          top: 494,
          transform: `translateY(${productLift}px)`,
          width: 1040,
        }}
      >
        <div
          style={{
            background: PALETTE.paper,
            border: "1px solid rgba(246,197,169,.3)",
            borderRadius: 16,
            boxShadow:
              "0 38px 92px rgba(0,0,0,.34), 0 8px 24px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.72)",
            height: 394,
            overflow: "hidden",
          }}
        >
          <Img
            alt="Published Future of Events 2027 program"
            src={ASSETS.publicProgramme}
            style={{
              display: "block",
              height: "100%",
              objectFit: "cover",
              objectPosition: `center ${imagePan}%`,
              width: "100%",
            }}
          />
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "center",
            marginTop: 16,
          }}
        >
          <span
            style={{
              ...sans,
              color: "rgba(255,253,248,.76)",
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            Published program · attendee view
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function FinalLockup({ frame }: { frame: number }) {
  const enter = fadeIn(frame, 238, 304);
  const lift = motion(frame, [238, 318], [32, 0], Easing.out(Easing.cubic));
  const markScale = motion(
    frame,
    [238, 310],
    [0.94, 1],
    Easing.out(Easing.cubic),
  );
  const line = fadeIn(frame, 270, 344);
  const ambientScale = motion(frame, [260, 539], [0.94, 1.12], Easing.linear);
  const ambientDrift = motion(frame, [260, 539], [-18, 18], Easing.linear);
  const closingLight = motion(
    frame,
    [300, 510],
    [-680, 2_200],
    Easing.inOut(Easing.cubic),
  );

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        opacity: enter,
        textAlign: "center",
        transform: `translateY(${lift}px)`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(circle, rgba(190,98,66,.16) 0%, rgba(190,98,66,.055) 30%, transparent 68%)",
          height: 860,
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: `translate(calc(-50% + ${ambientDrift}px), -50%) scale(${ambientScale})`,
          width: 1120,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(246,197,169,.085), transparent)",
          filter: "blur(68px)",
          height: 980,
          left: 0,
          mixBlendMode: "screen",
          pointerEvents: "none",
          position: "absolute",
          top: 50,
          transform: `translateX(${closingLight}px) skewX(-10deg)`,
          width: 440,
        }}
      />
      <div style={{ position: "relative", width: 1560 }}>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "center",
            transform: `scale(${markScale})`,
          }}
        >
          <ProgramCueMark
            accent={PALETTE.copperSoft}
            ink={PALETTE.paper}
            size={64}
          />
          <span
            style={{
              ...sans,
              color: PALETTE.paper,
              fontSize: 31,
              fontWeight: 730,
              letterSpacing: "-0.05em",
              marginLeft: 18,
            }}
          >
            Program Cue
          </span>
        </div>

        <h2
          style={{
            ...sans,
            color: PALETTE.paper,
            fontFeatureSettings: '"cv05", "cv11"',
            fontSize: 92,
            fontWeight: 710,
            letterSpacing: "-0.071em",
            lineHeight: 0.98,
            margin: "58px 0 0",
          }}
        >
          Make the program happen.
        </h2>
        <p
          style={{
            ...sans,
            color: "rgba(255,253,248,.67)",
            fontSize: 24,
            letterSpacing: "-0.022em",
            lineHeight: 1.4,
            margin: "29px auto 0",
          }}
        >
          One connected workspace for conference program operations.
        </p>

        <div
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(246,197,169,.72), transparent)",
            height: 1,
            margin: "51px auto 0",
            opacity: line,
            transform: `scaleX(${line})`,
            width: 420,
          }}
        />
        <div
          style={{
            ...sans,
            color: PALETTE.copperSoft,
            fontSize: 30,
            fontWeight: 620,
            letterSpacing: "-0.025em",
            marginTop: 29,
          }}
        >
          programcue.com
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function ClosingScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const reveal = fadeIn(frame, 0, 20);
  const exit = fadeOut(frame, duration - 22, duration - 1);

  return (
    <AbsoluteFill
      style={{
        ...sans,
        background: `radial-gradient(circle at 50% 42%, #22332f 0%, ${PALETTE.inkDeep} 58%, #070c0b 100%)`,
        color: PALETTE.paper,
        fontFeatureSettings: '"cv05", "cv11"',
        opacity: reveal * exit,
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(116deg, rgba(190,98,66,.065), transparent 34%, rgba(143,191,154,.035) 72%, transparent)",
          inset: 0,
          position: "absolute",
        }}
      />
      <JourneyResolve frame={frame} />
      <FinalLockup frame={frame} />
      <CornerFrame color={PALETTE.copperSoft} inset={78} opacity={0.18} />
      <FilmGrain tone="light" opacity={0.025} />
    </AbsoluteFill>
  );
}
