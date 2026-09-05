import type { ReactNode } from "react";

import {
  AbsoluteFill,
  Easing,
  interpolate,
  interpolateColors,
  useCurrentFrame,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  Arrow,
  AssetWindow,
  Check,
  Chip,
  clamp,
  copper,
  DotGrid,
  deep,
  Eyebrow,
  ease,
  FooterRail,
  frameProgress,
  ink,
  line,
  local,
  MiniAvatar,
  muted,
  paper,
  Reveal,
  SceneHeader,
  type SceneProps,
  sage,
} from "./PlacePublishOperateSceneShared";

const placementStory = {
  title: "Future of urban care",
  speaker: "Maya Chen",
  conflictRoom: "Main Hall",
  placedRoom: "Studio B",
  slot: "Thu 10:30",
  currentDescription: "Description · “Care at city scale”",
  draftDescription: "Description · “Care at neighbourhood scale”",
} as const;

const PLACE_TRANSITION_HALF = 0.0065;

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
          Conflict caught. Live program protected.
        </div>
        <span style={{ color: muted, fontSize: 11, fontWeight: 700 }}>
          current conflict-policy revision
        </span>
      </div>
    </div>
  );
}

function AutoPlacementCard({ progress }: { progress: number }) {
  const nameProgress = ease(local(progress, 0.03, 0.18));
  const subsetProgress = ease(local(progress, 0.14, 0.3));
  const saveProgress = ease(local(progress, 0.3, 0.48));
  const applyProgress = ease(local(progress, 0.6, 0.73));
  const scenarioSaving = progress >= 0.32;
  const scenarioSaved = progress >= 0.48;
  const scenarioApplying = progress >= 0.6;
  const scenarioApplied = progress >= 0.77;
  const scenarioName = "Thursday capacity option";
  const visibleScenarioName = scenarioName.slice(
    0,
    Math.round(interpolate(nameProgress, [0, 1], [0, scenarioName.length])),
  );
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
        width: 960,
        borderRadius: 24,
        padding: 22,
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
          gap: 18,
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              color: PALETTE.copperDeep,
              fontSize: 16,
              fontWeight: 900,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            Scenario Lab
          </div>
          <div
            style={{
              fontSize: 30,
              fontWeight: 850,
              letterSpacing: "-0.04em",
              marginTop: 5,
            }}
          >
            Compare before changing the draft
          </div>
        </div>
        <Chip
          tone={scenarioApplied ? "warn" : scenarioSaved ? "good" : "copper"}
        >
          {scenarioApplied
            ? "PRIVATE · NEEDS REFRESH"
            : scenarioSaved
              ? "PRIVATE · READY TO COMPARE"
              : "PRIVATE ALTERNATIVE"}
        </Chip>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 340px",
          gap: 10,
          marginBottom: 11,
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#fff",
            border: `1px solid ${interpolateColors(nameProgress, [0, 1], [line, "rgba(190,98,66,.42)"])}`,
            borderRadius: 13,
            display: "flex",
            minHeight: 76,
            padding: "0 13px",
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              style={{
                color: muted,
                fontSize: 14,
                fontWeight: 900,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              Scenario name
            </div>
            <div style={{ fontSize: 24, fontWeight: 820, marginTop: 4 }}>
              {visibleScenarioName}
              <span
                style={{
                  color: copper,
                  opacity: nameProgress < 1 ? 1 : 0,
                }}
              >
                |
              </span>
            </div>
          </div>
          <span style={{ color: muted, fontSize: 16, fontWeight: 800 }}>
            DRAFT REV 12
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            overflow: "hidden",
            border: `1px solid ${line}`,
            borderRadius: 13,
            background: "rgba(24,37,34,.025)",
          }}
        >
          {[
            ["Selected moves", "1"],
            ["Warnings", "0"],
            ["Unplaced", "1"],
          ].map(([label, value], index) => (
            <div
              key={label}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "8px 9px",
                borderLeft: index ? `1px solid ${line}` : undefined,
              }}
            >
              <div style={{ fontSize: 26, fontWeight: 880 }}>{value}</div>
              <div
                style={{
                  color: muted,
                  fontSize: 14,
                  fontWeight: 850,
                  letterSpacing: "0.06em",
                  lineHeight: 1.25,
                  marginTop: 2,
                  textTransform: "uppercase",
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
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
                gap: 12,
                padding: "10px 12px",
                borderRadius: 13,
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
                  fontSize: 20,
                  fontWeight: 950,
                  height: 22,
                  justifyContent: "center",
                  width: 22,
                }}
              >
                <span style={{ opacity: selectedProgress }}>✓</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 24, fontWeight: 800 }}>
                  {proposal.title}
                </div>
                <div style={{ color: muted, fontSize: 18, marginTop: 3 }}>
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
                  fontSize: 18,
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
          marginTop: 8,
          opacity: ease(local(progress, 0.24, 0.42)),
          padding: "9px 11px",
          transform: `translate3d(${interpolate(ease(local(progress, 0.24, 0.42)), [0, 1], [14, 0])}px, 0, 0)`,
        }}
      >
        <span style={{ fontSize: 24, fontWeight: 950 }}>!</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 850 }}>
            Building Better Event Data · not placed
          </div>
          <div style={{ fontSize: 16, marginTop: 3 }}>
            No room satisfies capacity and speaker availability.
          </div>
        </div>
        <Chip tone="warn">unplaced</Chip>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 16,
          marginTop: 14,
          padding: "10px 11px",
          borderRadius: 13,
          border: `1px solid ${interpolateColors(saveProgress, [0, 1], ["rgba(190,98,66,.24)", "rgba(143,191,154,.38)"])}`,
          background: interpolateColors(
            saveProgress,
            [0, 1],
            ["rgba(190,98,66,.055)", "rgba(143,191,154,.085)"],
          ),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <StatusDot tone={scenarioApplied ? "good" : "neutral"} />
          <div>
            <div
              style={{
                color: scenarioApplied ? PALETTE.sageDeep : ink,
                fontSize: 16,
                fontWeight: 900,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              {scenarioApplied
                ? "Draft updated · not published"
                : "Active draft boundary"}
            </div>
            <div
              style={{
                color: muted,
                fontSize: 18,
                fontWeight: 700,
                marginTop: 3,
              }}
            >
              {scenarioApplied
                ? "Applied after a separate confirmation. Public program unchanged."
                : scenarioSaved
                  ? "Saved privately. The active draft remains unchanged."
                  : "Saving this named alternative changes nothing."}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 16,
          }}
        >
          {scenarioSaved && !scenarioApplied ? (
            <span
              style={{
                color: PALETTE.sageDeep,
                fontSize: 16,
                fontWeight: 850,
              }}
            >
              SAVED PRIVATELY ✓
            </span>
          ) : null}
          <div
            style={{
              padding: "10px 13px",
              borderRadius: 10,
              background: interpolateColors(
                applyProgress,
                [0, 1],
                [ink, copper],
              ),
              color: paper,
              fontSize: 16,
              fontWeight: 850,
              letterSpacing: "0.06em",
              boxShadow: `0 10px ${interpolate(Math.max(saveProgress, applyProgress), [0, 1], [0, 24])}px rgba(190,98,66,.22)`,
              transform: `translateY(${interpolate(Math.max(saveProgress, applyProgress), [0, 1], [2, -1])}px)`,
            }}
          >
            {scenarioApplied
              ? "APPLIED TO DRAFT ✓"
              : scenarioApplying
                ? "APPLY 1 TO DRAFT"
                : scenarioSaved
                  ? "REVIEW SAVED PLAN"
                  : scenarioSaving
                    ? "SAVE 1 SELECTED PLACEMENT"
                    : "REVIEW PROPOSED PLAN"}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({ progress }: { progress: number }) {
  const actionProgress = ease(local(progress, 0.72, 0.9));
  const approved = progress >= 0.82;
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
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              color: PALETTE.copperDeep,
              fontSize: 9,
              fontWeight: 900,
              letterSpacing: "0.13em",
              textTransform: "uppercase",
            }}
          >
            Schedule version 2
          </div>
          <div
            style={{
              fontSize: 21,
              fontWeight: 850,
              letterSpacing: "-0.03em",
              marginTop: 5,
            }}
          >
            Content approval
          </div>
        </div>
        <Chip tone={approved ? "good" : "copper"}>
          {approved ? "APPROVED" : "IN REVIEW"}
        </Chip>
      </div>
      <div
        style={{
          border: `1px solid ${line}`,
          borderRadius: 16,
          padding: 15,
          background: "#fff",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <MiniAvatar initials="MC" color="#436b62" />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 850,
              }}
            >
              {placementStory.title}
            </div>
            <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
              {placementStory.speaker} · 25 min · Cities &amp; communities
            </div>
          </div>
          <Chip tone="good">CONTENT REVISION 4</Chip>
        </div>
        <div
          style={{
            borderTop: `1px solid ${line}`,
            color: ink,
            fontSize: 12,
            fontWeight: 720,
            lineHeight: 1.45,
            marginTop: 13,
            paddingTop: 12,
          }}
        >
          Care at neighbourhood scale
        </div>
        <div
          style={{
            color: muted,
            fontSize: 10,
            lineHeight: 1.45,
            marginTop: 7,
          }}
        >
          Public scheduled content must be Approved before its exact schedule
          snapshot can be published.
        </div>
      </div>
      <div
        style={{
          background: "rgba(24,37,34,.025)",
          border: `1px solid ${line}`,
          borderRadius: 15,
          marginTop: 10,
          padding: 13,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "grid",
            gap: 10,
            gridTemplateColumns: "1fr 166px",
          }}
        >
          <div>
            <div
              style={{
                color: muted,
                fontSize: 8,
                fontWeight: 900,
                letterSpacing: "0.11em",
                textTransform: "uppercase",
              }}
            >
              Next status
            </div>
            <div
              style={{
                alignItems: "center",
                background: "#fff",
                border: `1px solid ${line}`,
                borderRadius: 10,
                display: "flex",
                fontSize: 12,
                fontWeight: 820,
                justifyContent: "space-between",
                marginTop: 5,
                padding: "9px 11px",
              }}
            >
              Approved <span style={{ color: muted }}>⌄</span>
            </div>
          </div>
          <div
            style={{
              alignItems: "center",
              alignSelf: "end",
              background: interpolateColors(
                actionProgress,
                [0, 1],
                [ink, PALETTE.sageDeep],
              ),
              borderRadius: 10,
              boxShadow: `0 10px ${interpolate(actionProgress, [0, 1], [0, 24])}px rgba(143,191,154,.24)`,
              color: paper,
              display: "flex",
              fontSize: 9,
              fontWeight: 900,
              justifyContent: "center",
              letterSpacing: "0.06em",
              minHeight: 36,
              transform: `scale(${interpolate(actionProgress, [0, 1], [0.98, 1.015])})`,
            }}
          >
            {approved ? "STATUS CHANGED ✓" : "CHANGE STATUS"}
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            color: muted,
            display: "flex",
            fontSize: 10,
            fontWeight: 720,
            gap: 8,
            marginTop: 10,
          }}
        >
          <span
            style={{
              alignItems: "center",
              background: approved ? sage : "#fff",
              border: `1px solid ${approved ? sage : "rgba(24,37,34,.24)"}`,
              borderRadius: 5,
              color: ink,
              display: "flex",
              fontSize: 9,
              height: 17,
              justifyContent: "center",
              width: 17,
            }}
          >
            {approved ? "✓" : ""}
          </span>
          Apply this exact status to the current content revision
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
            style={{ fontSize: 30, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Publication diff
          </div>
          <div style={{ color: muted, fontSize: 18, marginTop: 5 }}>
            A readable summary of material schedule and session-content changes.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Chip tone="good">CONTENT REV 4 · APPROVED</Chip>
          <Chip tone="copper">2 MATERIAL CHANGES</Chip>
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
          fontSize: 18,
          fontWeight: 750,
          opacity: footerProgress,
          transform: `translateY(${interpolate(footerProgress, [0, 1], [8, 0])}px)`,
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: 2, background: sage }}
        />{" "}
        The current public program remains unchanged until you confirm.
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
          fontSize: 16,
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
              minHeight: 68,
              gap: 10,
              padding: "10px 14px",
              borderBottom:
                index < rows.length - 1 ? `1px solid ${line}` : undefined,
              color: mutedRows.includes(index) ? "#68756e" : ink,
              fontSize: 22,
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
                fontSize: 16,
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
                fontSize: 22,
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
            SCHEDULE VERSION 2
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
          Publish schedule
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
          Make version 2 the new public program. If blocked, version 1 remains
          unchanged.
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
          <span style={{ fontSize: 15 }}>✓</span> Conflicts, public content,
          participation and publication dependencies revalidated.
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
            CONFIRM PUBLICATION ↗
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: interpolate(cursorTravel, [0, 1], [630, 522]),
            top: interpolate(cursorTravel, [0, 1], [250, 350]),
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
            top: 353,
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
  const digestReveal = ease(local(progress, 0.14, 0.68));
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
          top: 22,
          width: 700,
          zIndex: 3,
          opacity: interpolate(heroSettle, [0, 1], [0.34, 1]),
          transform: `translate3d(${interpolate(heroSettle, [0, 1], [-24, 0])}px, ${interpolate(heroSettle, [0, 1], [18, 0])}px, 36px)`,
        }}
      >
        <Eyebrow tone="sage" dark>
          Latest publication
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 40,
            lineHeight: 1.03,
            fontWeight: 860,
            letterSpacing: "-0.06em",
            marginTop: 16,
          }}
        >
          Version 2 <span style={{ color: sage }}>change digest.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.58)",
            fontSize: 20,
            fontWeight: 720,
            marginTop: 8,
          }}
        >
          Compared with published version 1 · durably recorded with version 2
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 6,
            marginTop: 19,
            opacity: digestReveal,
            transform: `translate3d(0, ${interpolate(digestReveal, [0, 1], [10, 0])}px, 0)`,
          }}
        >
          {[
            ["Added", "0"],
            ["Removed", "0"],
            ["Moved or resized", "1"],
            ["Visibility", "0"],
            ["Public content", "1"],
          ].map(([label, value]) => (
            <div
              key={label}
              style={{
                minHeight: 54,
                padding: "9px 8px",
                borderRadius: 11,
                border: `1px solid ${value === "0" ? "rgba(255,253,248,.12)" : "rgba(143,191,154,.38)"}`,
                background:
                  value === "0"
                    ? "rgba(255,253,248,.035)"
                    : "rgba(143,191,154,.11)",
              }}
            >
              <div
                style={{
                  color: value === "0" ? "rgba(255,253,248,.5)" : sage,
                  fontSize: 28,
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                {value}
              </div>
              <div
                style={{
                  color: "rgba(255,253,248,.56)",
                  fontSize: 14,
                  fontWeight: 850,
                  letterSpacing: "0.06em",
                  lineHeight: 1.2,
                  marginTop: 5,
                  textTransform: "uppercase",
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 9,
            padding: "12px 13px",
            borderRadius: 14,
            border: "1px solid rgba(143,191,154,.28)",
            background: "rgba(143,191,154,.075)",
            opacity: digestReveal,
            transform: `translate3d(0, ${interpolate(digestReveal, [0, 1], [14, 0])}px, 0)`,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                color: sage,
                fontSize: 16,
                fontWeight: 900,
                letterSpacing: "0.11em",
                textTransform: "uppercase",
              }}
            >
              Review affected records
            </div>
            <div
              style={{
                color: paper,
                fontSize: 18,
                fontWeight: 850,
              }}
            >
              2 material changes
            </div>
          </div>
          {[
            {
              category: "Moved or resized",
              detail: "Main Hall, Thu 10:30 → Studio B, Thu 10:30",
            },
            {
              category: "Public content",
              detail: "description",
            },
          ].map((item, index) => (
            <div
              key={item.category}
              style={{
                alignItems: "center",
                borderTop: "1px solid rgba(255,253,248,.1)",
                display: "grid",
                gap: 4,
                gridTemplateColumns: "156px 1fr",
                marginTop: index ? 8 : 10,
                paddingTop: 8,
              }}
            >
              <div
                style={{
                  color: sage,
                  fontSize: 16,
                  fontWeight: 850,
                }}
              >
                {item.category}
              </div>
              <div>
                <div style={{ color: paper, fontSize: 20, fontWeight: 820 }}>
                  {placementStory.title}
                </div>
                <div
                  style={{
                    color: "rgba(255,253,248,.54)",
                    fontSize: 16,
                    marginTop: 2,
                  }}
                >
                  {item.detail}
                </div>
              </div>
            </div>
          ))}
          <div
            style={{
              borderTop: "1px solid rgba(255,253,248,.1)",
              color: "rgba(255,253,248,.45)",
              fontSize: 14,
              fontWeight: 750,
              letterSpacing: "0.035em",
              marginTop: 9,
              paddingTop: 8,
              textTransform: "uppercase",
            }}
          >
            Counts exact · highlights capped at 20 per category · no content
            bodies stored
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
              FUTURE OF EVENTS 2027 / PROGRAM
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
  const scenarioApplied = resolutionProgress >= 0.77;
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
        chapter="PROGRAM SCHEDULING"
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
        CONFLICT-AWARE PLANNING · PRIVATE SCENARIOS
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
            caption="published baseline"
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
              fontSize: 22,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 430,
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
            top: 215,
            transformOrigin: "right top",
            transform: `translate3d(${interpolate(conflictProgress, [0, 1], [18, -9])}px, ${interpolate(conflictProgress, [0, 1], [9, -5])}px, 0) scale(${interpolate(conflictProgress, [0, 1], [1.38, 1.4])})`,
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
            02 · Scenario Lab
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
            {scenarioApplied ? "Apply after review." : "Name the option."}
            <br />
            <span style={{ color: sage }}>
              {scenarioApplied
                ? "Keep publication intact."
                : "Keep the draft intact."}
            </span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 22,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 430,
            }}
          >
            {scenarioApplied
              ? "A separate confirmation applies the selected move to the draft. The saved scenario needs refresh; the public program stays unchanged."
              : "Choose which valid auto-placement moves define a private scenario. Warnings and unplaced sessions stay visible before the active draft changes."}
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
            <Check />
            {scenarioApplied
              ? "DRAFT CHANGED · PUBLIC PROGRAM UNCHANGED"
              : "SAVE ≠ APPLY · APPLY ≠ PUBLISH"}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 116,
            top: 210,
            transformOrigin: "left top",
            transform: `translate3d(${interpolate(resolutionProgress, [0, 1], [20, -10])}px, ${interpolate(resolutionProgress, [0, 1], [8, -6])}px, 0) scale(${interpolate(resolutionProgress, [0, 1], [1.04, 1.06])})`,
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
              fontSize: 22,
              lineHeight: 1.45,
              marginTop: 18,
              maxWidth: 430,
            }}
          >
            Move the exact public-content revision to Approved. The currently
            published program remains unchanged.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 116,
            top: 215,
            transformOrigin: "right top",
            transform: `translate3d(${interpolate(approvalProgress, [0, 1], [17, -9])}px, ${interpolate(approvalProgress, [0, 1], [8, -5])}px, 0) scale(${interpolate(approvalProgress, [0, 1], [1.38, 1.4])})`,
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
              fontSize: 22,
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
              fontSize: 22,
              lineHeight: 1.48,
              marginTop: 20,
              maxWidth: 430,
            }}
          >
            The publication boundary revalidates conflicts, public content,
            confirmed participation and required public dependencies.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 116,
            top: 230,
            transformOrigin: "right top",
            transform: `perspective(1400px) translate3d(${interpolate(confirmCamera, [0, 1], [58, 0])}px, ${interpolate(confirmCamera, [0, 1], [24, 0])}px, 0) rotateY(${interpolate(confirmCamera, [0, 1], [-4.5, 0])}deg) scale(${interpolate(confirmCamera, [0, 1], [1.42, 1.45])})`,
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
        activationPoints={[0.13, 0.3, 0.47, 0.64, 0.8, 0.92]}
        progress={progress}
        items={[
          "detect",
          "scenario lab",
          "approve",
          "compare",
          "confirm",
          "digest",
        ]}
      />
    </AbsoluteFill>
  );
}
