import {
  AbsoluteFill,
  Easing,
  Img,
  staticFile,
  useCurrentFrame,
} from "remotion";

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

const wordmark = (opacity: number) => (
  <div
    style={{
      alignItems: "center",
      display: "flex",
      gap: 14,
      opacity,
    }}
  >
    <ProgramCueMark size={38} accent={PALETTE.copperSoft} />
    <span
      style={{
        ...sans,
        color: PALETTE.paper,
        fontSize: 22,
        fontWeight: 730,
        letterSpacing: "-0.045em",
      }}
    >
      Program Cue
    </span>
  </div>
);

function HumanColdOpen({ frame }: { frame: number }) {
  const exit = fadeOut(frame, 124, 178);
  const copyIn = fadeIn(frame, 10, 48);
  const copyLift = motion(frame, [10, 58], [26, 0], Easing.out(Easing.cubic));
  const imageScale = motion(
    frame,
    [0, 184],
    [1.015, 1.055],
    Easing.inOut(Easing.cubic),
  );

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <Img
        alt="A conference speaker facing the audience from the stage"
        src={staticFile("video/editorial-stage-moment.png")}
        style={{
          height: "100%",
          objectFit: "cover",
          objectPosition: "center center",
          transform: `scale(${imageScale})`,
          width: "100%",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(90deg, rgba(7,13,12,.98) 0%, rgba(10,19,18,.91) 30%, rgba(10,19,18,.52) 53%, rgba(7,13,12,.08) 78%), linear-gradient(0deg, rgba(7,13,12,.58), transparent 42%)",
          inset: 0,
          position: "absolute",
        }}
      />
      <div style={{ left: 142, position: "absolute", top: 78 }}>
        {wordmark(fadeIn(frame, 0, 30))}
      </div>
      <div
        style={{
          left: 142,
          maxWidth: 850,
          opacity: copyIn,
          position: "absolute",
          top: 306,
          transform: `translateY(${copyLift}px)`,
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
          Conference program operations
        </div>
        <div
          aria-hidden="true"
          style={{
            background: PALETTE.copperSoft,
            height: 2,
            marginTop: 20,
            transform: `scaleX(${fadeIn(frame, 22, 60)})`,
            transformOrigin: "left center",
            width: 108,
          }}
        />
        <h1
          style={{
            ...sans,
            color: PALETTE.paper,
            fontFeatureSettings: '"cv05", "cv11"',
            fontSize: 78,
            fontWeight: 690,
            letterSpacing: "-0.062em",
            lineHeight: 0.98,
            margin: "30px 0 0",
          }}
        >
          This moment starts
          <br />
          long before the stage.
        </h1>
        <p
          style={{
            ...sans,
            color: "rgba(255,253,248,.76)",
            fontSize: 25,
            letterSpacing: "-0.024em",
            lineHeight: 1.38,
            margin: "31px 0 0",
            maxWidth: 730,
          }}
        >
          Every proposal, decision, speaker detail and schedule change has to
          arrive together.
        </p>
      </div>
    </AbsoluteFill>
  );
}

function ProductPromise({ frame, duration }: SceneProps & { frame: number }) {
  const sceneIn = fadeIn(frame, 166, 214);
  const end = fadeOut(frame, duration - 20, duration - 1);
  const stageStripIn = fadeIn(frame, 178, 230) * fadeOut(frame, 430, 450);
  const titleLift = motion(
    frame,
    [172, 228],
    [34, 0],
    Easing.out(Easing.cubic),
  );
  const productIn = fadeIn(frame, 196, 252);
  const productLift = motion(
    frame,
    [196, 264],
    [42, 0],
    Easing.out(Easing.cubic),
  );
  const productScale = motion(
    frame,
    [196, 276],
    [0.965, 1],
    Easing.out(Easing.cubic),
  );
  const productPan = motion(
    frame,
    [230, duration],
    [0, -8],
    Easing.inOut(Easing.cubic),
  );
  const sweep = motion(frame, [230, 350], [-280, 1080], Easing.linear);

  return (
    <AbsoluteFill style={{ opacity: sceneIn * end }}>
      <div
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(circle at 83% 42%, rgba(190,98,66,.18), transparent 35%), radial-gradient(circle at 12% 100%, rgba(143,191,154,.08), transparent 38%)",
          inset: 0,
          position: "absolute",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          bottom: 0,
          height: 340,
          left: 0,
          maskImage:
            "linear-gradient(180deg, transparent 0%, rgba(0,0,0,.92) 27%, #000 100%)",
          opacity: stageStripIn * 0.58,
          overflow: "hidden",
          position: "absolute",
          right: 0,
        }}
      >
        <Img
          alt=""
          src={staticFile("video/editorial-stage-moment.png")}
          style={{
            filter: "saturate(.84) contrast(1.06)",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 34%",
            width: "100%",
          }}
        />
        <div
          style={{
            background:
              "linear-gradient(90deg, rgba(7,13,12,.7) 0%, rgba(7,13,12,.2) 38%, rgba(7,13,12,.08) 70%, rgba(190,98,66,.16) 100%), linear-gradient(0deg, rgba(7,13,12,.28), transparent 64%)",
            inset: 0,
            position: "absolute",
          }}
        />
      </div>
      <div style={{ left: 142, position: "absolute", top: 78 }}>
        {wordmark(fadeIn(frame, 174, 210))}
      </div>
      <div
        style={{
          left: 142,
          maxWidth: 750,
          opacity: fadeIn(frame, 174, 220),
          position: "absolute",
          top: 286,
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
          One connected workspace
        </div>
        <div
          aria-hidden="true"
          style={{
            background: PALETTE.copper,
            height: 2,
            marginTop: 20,
            transform: `scaleX(${fadeIn(frame, 188, 230)})`,
            transformOrigin: "left center",
            width: 108,
          }}
        />
        <h2
          style={{
            ...sans,
            color: PALETTE.paper,
            fontFeatureSettings: '"cv05", "cv11"',
            fontSize: 86,
            fontWeight: 710,
            letterSpacing: "-0.071em",
            lineHeight: 0.94,
            margin: "30px 0 0",
          }}
        >
          Run the program.
          <br />
          <span style={{ color: PALETTE.copperSoft }}>
            Not the spreadsheet.
          </span>
        </h2>
        <p
          style={{
            ...sans,
            color: "rgba(255,253,248,.67)",
            fontSize: 24,
            letterSpacing: "-0.022em",
            lineHeight: 1.42,
            margin: "33px 0 0",
            maxWidth: 680,
          }}
        >
          Keep submissions, review, speakers, scheduling and publication in one
          event workspace.
        </p>
      </div>

      <div
        style={{
          opacity: productIn,
          position: "absolute",
          right: 80,
          top: 218,
          transform: `translateY(${productLift}px) scale(${productScale})`,
          transformOrigin: "right center",
          width: 925,
        }}
      >
        <div
          style={{
            background: PALETTE.paper,
            border: "1px solid rgba(246,197,169,.34)",
            borderRadius: 16,
            boxShadow:
              "0 46px 108px rgba(0,0,0,.38), 0 10px 30px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.7)",
            height: 518,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <Img
            alt="Program Cue command centre"
            src={ASSETS.commandCentre}
            style={{
              display: "block",
              height: "108%",
              objectFit: "cover",
              objectPosition: "center top",
              transform: `translateY(${productPan}px)`,
              width: "100%",
            }}
          />
          <div
            aria-hidden="true"
            style={{
              background:
                "linear-gradient(100deg, transparent 0%, rgba(255,255,255,.15) 48%, transparent 55%)",
              bottom: 0,
              left: sweep,
              position: "absolute",
              top: 0,
              transform: "skewX(-14deg)",
              width: 190,
            }}
          />
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            marginTop: 16,
          }}
        >
          <span
            style={{
              ...sans,
              color: "rgba(255,253,248,.74)",
              fontSize: 15,
              fontWeight: 620,
              letterSpacing: "-0.01em",
            }}
          >
            Command Centre
          </span>
          <span
            style={{
              ...sans,
              color: PALETTE.copperSoft,
              fontSize: 15,
              letterSpacing: "-0.01em",
            }}
          >
            Program readiness
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function OpeningScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const exit = fadeOut(frame, duration - 18, duration - 1);
  const darkReveal = motion(
    frame,
    [126, 204],
    [0, 100],
    Easing.inOut(Easing.cubic),
  );

  return (
    <AbsoluteFill
      style={{
        ...sans,
        background: PALETTE.inkDeep,
        color: PALETTE.paper,
        fontFeatureSettings: '"cv05", "cv11"',
        opacity: exit,
        overflow: "hidden",
      }}
    >
      <HumanColdOpen frame={frame} />

      <div
        aria-hidden="true"
        style={{
          background: `linear-gradient(112deg, ${PALETTE.inkDeep}, ${PALETTE.nav} 66%, #0a1211)`,
          clipPath: `inset(0 ${100 - darkReveal}% 0 0)`,
          inset: 0,
          position: "absolute",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(180deg, transparent, rgba(246,197,169,.92), transparent)",
          bottom: 0,
          left: `${darkReveal}%`,
          opacity: fadeIn(frame, 126, 142) * fadeOut(frame, 184, 206),
          position: "absolute",
          top: 0,
          transform: "translateX(-1px)",
          width: 2,
        }}
      />

      <ProductPromise duration={duration} frame={frame} />
      <CornerFrame color={PALETTE.copperSoft} inset={78} opacity={0.18} />
      <FilmGrain tone="light" opacity={0.025} />
    </AbsoluteFill>
  );
}
