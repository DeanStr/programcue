# Program Cue launch film

This directory contains the six-minute, 13-scene, 1920 x 1080, 30 fps
Remotion launch film. Its editorial order is Command Centre -> setup -> collect
-> decide -> prepare -> assistant follow-up -> communicate -> place -> publish
-> operate.

The current narrative opens on one ranked critical session deliverable, then
moves to a separate outstanding speaker task and its approval-gated reminder.
It carries the event through a private Scenario Lab comparison, explicit
publication and its retained change digest. Completed AI work exposes focused
operator feedback without turning that feedback into an autonomous action or a
telemetry claim.

The film combines two kinds of product imagery. Reviewed, verified Playwright
captures show the implemented canonical demo interface. Product-faithful
code-native reconstructions provide motion, focus and otherwise unavailable
transitional states; they are grounded in current product rules, but they are
not browser captures or evidence that an external provider operation occurred.
Two generated editorial images provide human and event context without being
presented as customer, speaker or delivered-event evidence. Asset origin and
hashes are recorded in `video/asset-provenance.json`.

The working cut holds chapter titles between the aperture wipes, enlarges
scheduling comparisons for embedded playback and leaves a seven-second feedback
sequence with separate reading, selection and confirmation beats. These changes
retain the six-minute picture lock and the selected soundtrack.

## Preview and default render

```bash
npm run video:studio
npm run video:check
npm run video:frames
npm run video:render
npm run video:validate
npm run video:compare
```

Remotion uses `video/public` as its dedicated public directory; film assets do
not enter the application's `public/` tree. The selected soundtrack is the
exact Eleven Music v2 audio from the approved public master. `video:score`
downloads that immutable master when it is not cached, verifies the full master
and encoded/decoded audio hashes, and prepares the ignored
`video/public/video/program-cue-score.wav` for Studio. `video:score:offline`
requires the verified cache. Downloads have a five-minute total timeout,
report the release URL on failure and remove incomplete temporary files. The final render copies the released AAC packet
stream rather than re-encoding it, so `.artifacts/program-cue-launch.mp4` uses
the same audio as the current public film.

The deterministic procedural score remains available only as the explicit
`npm run video:score:procedural` fallback. It writes
`video/public/video/program-cue-procedural-score.wav` and is not mounted by the
film or normal render workflow.

The timed-description source is
`video/delivery/program-cue-launch-descriptions.vtt`. The story gate and rendering both validate exact
picture-lock coverage and contiguous caption-format description cues at no more
than 17 visible characters per second, then copies it to
`.artifacts/program-cue-launch.vtt` beside the master. Validation fully decodes
picture and sound, checks 10,800 constant-rate frames, stream topology, BT.709
metadata, loudness, true peak and excessive black, frozen or silent spans. The
comparison gate renders current stills, checks decoded scene canaries and
writes contact sheets under the ignored `.artifacts/encoded-review/` directory
for visual inspection.

This VTT belongs to the current working cut. It does not replace the public
site's captions or transcript until a release owner selects and approves a new
master. The public bundle is pinned separately by
`site/public/product-film-release.json`. Site validation checks the manifest
fields, immutable media URL and selected audio source, verifies the local poster
and caption hashes, validates the released VTT’s syntax, timing and reading
speed, and requires the HTML transcript to match those released captions. Soundtrack preparation verifies the downloaded master and its encoded
and decoded audio against the release hashes.

## Optional new ElevenLabs auditions

The 13 picture-locked chunks in `video/eleven-music-plan.json` define an
optional Eleven Music v2 candidate. Checking the plan is offline:

```bash
npm run video:music:eleven
npm run video:music:eleven -- --check
```

Both forms only validate the plan. Provider generation requires the explicit
`npm run video:music:eleven:live` action and `ELEVENLABS_API_KEY` in the
process environment. A successful request writes a content-addressed,
unmounted candidate and metadata under the ignored `.artifacts/video-music/`
directory. Checking, rendering or mastering the film never generates provider
music and never implies provider success.

`video/scripts/master-eleven-music.mjs` is an offline, pinned mastering recipe.
Given the exact recorded candidate and the current picture master,
it verifies the source hashes, builds the mastered audio, copies the validated
picture stream, validates and copies its picture-locked VTT, and creates
`.artifacts/program-cue-launch-elevenlabs.mp4`, its sibling VTT and a derived
manifest. It makes no provider request. This alternate does not replace the
selected released soundtrack or the normal master unless a release owner
explicitly selects the newly generated audio.

Run the pinned offline alternate workflow with:

```bash
npm run video:music:master
```

Voice-over remains an optional unmounted audition:

```bash
npm run video:voice
npm run video:voice:live
```

`video:voice` is a dry-run validation and makes no provider request.
`video:voice:live` is the explicit ElevenLabs generation command and requires
the process-only API key. All generated segments, alignment data, stems and
mixes remain under ignored `.artifacts/video-voiceover/`; none is served by the
application or mounted by `LaunchFilm.tsx`.

## Delivery and publication

Deliver the MP4 with its VTT sidecar. A host page must not autoplay the film;
it must show a poster and an obvious play control. When
`prefers-reduced-motion: reduce` is active, keep the poster stationary and wait
for an explicit play action.

Commercial publication remains blocked until a release owner records the
applicable Remotion licence approval and, for any ElevenLabs-derived audio,
the applicable ElevenLabs plan and commercial-use approval. Credentials are
never part of that record or the repository.

The website currently retains the previously approved Eleven Music v2 master
at the immutable `program-cue-launch-92cab554.mp4` URL. The current working cut
reuses that exact soundtrack and remains unpublished. Promoting the new picture
still requires a validated master, an immutable upload and an atomic update of
the release manifest, poster, captions and HTML transcript.

## Editorial boundaries

- The film uses a fictional seeded event and is not customer evidence.
- Audience-facing copy prioritises product value. Fixture, reconstruction and
  asset provenance remain documented here instead of appearing as repeated
  engineering disclaimers in the film.
- The generated event-context interstitial is editorial imagery and is never
  used as proof of a customer, venue or delivered event.
- The event assistant reads authorised seeded D1 evidence, shows the exact
  editable template and selected recipient rows, requires explicit confirmation
  before durable queue work, and keeps provider acceptance and delivery
  separate from queue state.
- Airtable is an explicit data-authority option, never presented as two-way
  sync.
- Accelevents appears as an export preview with mapped fields ready for
  confirmation. No completed provider sync or provider acceptance is shown.
- Uploads remain private through quarantine and scanning before clean release.
- Draft schedule changes reach public surfaces only after review, conflict
  revalidation, diff and explicit publication.
- The music-led film remains understandable when muted through its on-screen
  narrative and timed-description sidecar.
