import { Form } from "react-router";
import { EventFieldInputs } from "~/components/event-field-inputs";
import { SpeakerProfileHistory } from "~/components/speaker-profile-history";
import { Button } from "~/components/ui/button";
import {
  formatSpeakerXHandleInput,
  normalizeSpeakerLinkedinUrl,
} from "~/modules/speakers/speaker-schema";

import {
  type AdminSpeakerDetailLoaderData,
  formatTimestamp,
} from "./admin-speaker-detail-presentation";

export function AdminSpeakerProfilePanel({
  detail,
  customFields,
  busy,
  onDirty,
}: {
  detail: AdminSpeakerDetailLoaderData["detail"];
  customFields: AdminSpeakerDetailLoaderData["customFields"];
  busy: boolean;
  onDirty: () => void;
}) {
  const { profile, profileShared, profileScoped, event } = detail;
  return (
    <section className="crm-record-section" id="profile">
      <h2>Profile</h2>
      <p className="help">
        Last saved {formatTimestamp(profile.updatedAt, event.timezone)} ·
        revision {profile.revision}
      </p>
      {profileShared ? (
        <p className="help" role="status">
          Shared identity. Public name, social links and publication stay
          participant-managed. Organisation and event fields below do not change
          other events.
        </p>
      ) : null}
      {profileScoped ? (
        <Form
          key={`${profile.revision}:${profile.organisationProfileOperationId}:${profile.travelProfileOperationId}`}
          method="post"
          className="stack"
          onChange={onDirty}
        >
          <input
            type="hidden"
            name="_intent"
            value="save_speaker_scoped_profile"
          />
          <input
            type="hidden"
            name="profileRevision"
            value={profile.revision}
          />
          <input
            type="hidden"
            name="organisationProfileOperationId"
            value={profile.organisationProfileOperationId}
          />
          <input
            type="hidden"
            name="travelProfileOperationId"
            value={profile.travelProfileOperationId}
          />
          <fieldset className="stack pc-plain-fieldset">
            <p className="help">
              These values belong to {event.name} and its organisation. They do
              not overwrite the participant-owned public identity.
            </p>
            <label className="label">
              Organisation display name
              <input
                className="field"
                name="name"
                defaultValue={profile.name}
                required
                minLength={2}
                maxLength={120}
              />
            </label>
            <div className="form-row">
              <label className="label">
                Job title
                <input
                  className="field"
                  name="jobTitle"
                  defaultValue={profile.jobTitle ?? ""}
                  maxLength={160}
                />
              </label>
              <label className="label">
                Organisation
                <input
                  className="field"
                  name="organisationName"
                  defaultValue={profile.organisationName ?? ""}
                  maxLength={160}
                />
              </label>
            </div>
            <label className="label">
              Organisation biography
              <textarea
                className="textarea"
                name="biography"
                defaultValue={profile.biography ?? ""}
                maxLength={5_000}
                rows={7}
              />
            </label>
            <label className="label">
              Travel and logistics preferences
              <textarea
                className="textarea"
                name="travelPreferences"
                defaultValue={profile.travelPreferences ?? ""}
                maxLength={2_000}
                rows={4}
                placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
              />
              <span className="help">
                Private to the participant and authorised organisers; never
                shown on the public programme.
              </span>
            </label>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save organisation and event details"}
            </Button>
          </fieldset>
        </Form>
      ) : (
        <Form
          key={profile.revision}
          method="post"
          className="stack"
          onChange={onDirty}
        >
          <input type="hidden" name="_intent" value="save_speaker_profile" />
          <input type="hidden" name="revision" value={profile.revision} />
          <fieldset className="stack pc-plain-fieldset">
            <label className="label">
              Display name
              <input
                className="field"
                name="name"
                defaultValue={profile.name}
                required
                minLength={2}
                maxLength={120}
              />
            </label>
            <div className="form-row">
              <label className="label">
                Job title
                <input
                  className="field"
                  name="jobTitle"
                  defaultValue={profile.jobTitle ?? ""}
                  maxLength={160}
                />
              </label>
              <label className="label">
                Organisation
                <input
                  className="field"
                  name="organisationName"
                  defaultValue={profile.organisationName ?? ""}
                  maxLength={160}
                />
              </label>
            </div>
            <div className="form-row">
              <label className="label">
                LinkedIn profile URL
                <input
                  className="field"
                  name="linkedinUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://www.linkedin.com/in/your-name"
                  defaultValue={profile.linkedinUrl ?? ""}
                  onBlur={(event) => {
                    event.currentTarget.value = normalizeSpeakerLinkedinUrl(
                      event.currentTarget.value,
                    );
                  }}
                  maxLength={500}
                />
              </label>
              <label className="label">
                X handle
                <input
                  className="field"
                  name="xHandle"
                  placeholder="@your_handle"
                  defaultValue={profile.xHandle ? `@${profile.xHandle}` : ""}
                  onBlur={(event) => {
                    event.currentTarget.value = formatSpeakerXHandleInput(
                      event.currentTarget.value,
                    );
                  }}
                  maxLength={500}
                />
              </label>
            </div>
            <div className="form-row">
              <label className="label">
                Name pronunciation
                <input
                  className="field"
                  name="pronunciation"
                  defaultValue={profile.pronunciation ?? ""}
                  maxLength={160}
                />
              </label>
              <label className="label">
                Profile status
                <select
                  className="select"
                  name="profileStatus"
                  defaultValue={profile.profileStatus}
                >
                  <option value="draft">
                    Draft — hidden from the programme
                  </option>
                  <option value="published">
                    Published — visible in the public programme
                  </option>
                  <option value="archived">
                    Archived — retained but not published
                  </option>
                </select>
              </label>
            </div>
            <label className="label">
              Biography
              <textarea
                className="textarea"
                name="biography"
                defaultValue={profile.biography ?? ""}
                maxLength={5_000}
                rows={7}
              />
            </label>
            <label className="label">
              Travel and logistics preferences
              <textarea
                className="textarea"
                name="travelPreferences"
                defaultValue={profile.travelPreferences ?? ""}
                maxLength={2_000}
                rows={4}
                placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
              />
              <span className="help">
                Private to the participant and authorised organisers; never
                shown on the public programme.
              </span>
            </label>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </Button>
          </fieldset>
        </Form>
      )}
      {customFields.length ? (
        <Form method="post" className="stack mt">
          <input type="hidden" name="_intent" value="save_event_fields" />
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Event-specific</span>
              <h3>Additional information</h3>
            </div>
          </div>
          <EventFieldInputs fields={customFields} />
          <Button type="submit" variant="primary" disabled={busy}>
            Save additional information
          </Button>
        </Form>
      ) : null}
      <SpeakerProfileHistory
        revisions={detail.profileHistory}
        timeZone={event.timezone}
      />
    </section>
  );
}
