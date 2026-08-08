#!/usr/bin/env python3
"""Fail-fast static review for product invariants not covered by unit tests."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "public/app.js").read_text()
SEED = (ROOT / "public/seed.js").read_text()
CSS = (ROOT / "public/styles.css").read_text()
WORKER = (ROOT / "workers/app.js").read_text()
SERVER = (ROOT / "server.mjs").read_text()
PACKAGE = json.loads((ROOT / "package.json").read_text())

errors: list[str] = []

def require(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)

for forbidden in ("SessionFlow", "applicationFormat", "/api/public/events/", "programcue.example", "Add custom field"):
    require(forbidden not in APP + SEED + SERVER, f"forbidden stale identifier remains: {forbidden}")

canonical_nav = [
    "Command Centre", "Event Setup", "Submissions", "Review", "Speakers", "Schedule",
    "Communications", "Tasks", "Programme", "Integrations", "Settings",
]
nav_match = re.search(r"export const navItems\s*=\s*\[(.*?)\];", SEED, re.S)
require(nav_match is not None, "canonical navItems export is missing")
if nav_match:
    nav_text = nav_match.group(1)
    positions = [nav_text.find(f"'{label}'") for label in canonical_nav]
    require(all(position >= 0 for position in positions), "one or more canonical navigation labels are missing")
    require(positions == sorted(positions), "canonical navigation order is inconsistent")
    require("Reports" not in nav_text and "AI Assistant" not in nav_text, "non-canonical top-level navigation item found")

require("/api/v1/public/events/future-of-events-2025/programme" in SERVER, "versioned local public programme API is missing")
require("INTERNAL_API_TOKEN" in WORKER and "authorization" in WORKER.lower(), "private Worker routes are not protected by the explicit bearer boundary")
require("Required Cloudflare binding" in WORKER, "Worker must fail closed on missing bindings")
require("focus-visible" in CSS, "visible keyboard focus styles are missing")
require("prefers-reduced-motion" in CSS, "reduced-motion support is missing")
require("Required when visible" in APP, "conditional required-field semantics are not explicit")
require("Preview" in APP and "Diff" in APP and "Confirm & send" in APP, "shared preview/diff/confirm flow is incomplete")
require("persistDraft" in APP and "state.application.draft" in APP and "state.application.drafts" in APP, "public application is not driven by persisted drafts")
require("emailVerified" in APP and "coSpeakers" in APP and "minSpeakers" in APP and "maxSpeakers" in APP, "public application is missing verified-email or multi-speaker behavior")
require("function bindSettings" in APP and "data-save-settings" in APP, "settings are not persisted")
require("sanitizeRichHtml" in APP and "allowedTags" in APP and "safeProtocols" in APP, "rich content sanitizer is missing")
require("data-export-programme" in APP and "programmeIcs" in APP and "calendar.ics" in APP, "programme exports are incomplete")
require("data-public-query" in APP and "data-public-filter" in APP and "data-clear-public" in APP, "public programme filters are not wired")
require("validateScheduleMove" in APP and "Pending publication" in APP, "schedule staging/publish safeguards are incomplete")
require("sync completed" not in APP and "data-sync-integration" not in APP and "no provider call was made" in APP, "integration UI fabricates provider success instead of using a dry-run/fail-closed boundary")
require("sourceSubmissionId" in APP and "added to the unscheduled queue" in APP, "accepted and direct sessions do not create unscheduled programme records")
require("data-confirm-decision" in APP and "Decision ready" in APP, "administrator decision workflow is incomplete")
require("data-confirm-speaker-profile" in APP and "data-confirm-speaker-upload" in APP, "speaker profile or file workflow is incomplete")
require("speakerResourcesPage" in APP and "resource-embed" in APP and "sandbox=\"\"" in APP and "data-ack-resource" in APP, "speaker resources/wiki acknowledgement workflow is incomplete")
require("['Room','List','Day','Week','Track']" in APP and "data-schedule-view" in APP, "required schedule views are incomplete")
require(WORKER.count("{ id: 'p") >= 8, "Worker demo programme does not match the representative eight-session public programme")
require("dependencies" not in PACKAGE or not PACKAGE.get("dependencies"), "zero-install evaluator unexpectedly declares runtime dependencies")

if errors:
    for error in errors:
        print(f"ERROR: {error}")
    raise SystemExit(1)
print(f"static audit passed: {len(canonical_nav)} canonical navigation items and 25 product invariants")
