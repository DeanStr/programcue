import { data, Form, useActionData } from "react-router";
import { ZodError } from "zod";
import { Button, ButtonLink } from "~/components/ui/button";
import {
  EventFieldService,
  EventFieldStateError,
} from "~/modules/fields/event-field-service.server";
import { fixedParticipantProfileFields } from "~/modules/fields/event-field-types";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-event-fields";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  return new EventFieldService(env).configuration(viewer);
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new EventFieldService(env);
  try {
    if (intent === "save-policies") {
      await service.saveProfilePolicies(viewer, form);
      return data({
        ok: true as const,
        message: "Participant profile access saved.",
      });
    }
    if (intent === "create-field") {
      await service.createDefinition(viewer, {
        ownerType: form.get("ownerType"),
        fieldKey: form.get("fieldKey"),
        label: form.get("label"),
        fieldType: form.get("fieldType"),
        options: String(form.get("options") ?? "")
          .split("\n")
          .map((option) => option.trim())
          .filter(Boolean),
        participantAccess: form.get("participantAccess"),
        required: form.get("required") === "true",
      });
      return data({
        ok: true as const,
        message: "Reusable event field created.",
      });
    }
    if (intent === "archive-field") {
      if (form.get("confirmed") !== "true") {
        throw new EventFieldStateError(
          "Confirm that this field should be archived.",
          422,
        );
      }
      await service.archiveDefinition(
        viewer,
        String(form.get("definitionId") ?? ""),
      );
      return data({
        ok: true as const,
        message: "Field archived; saved values were retained.",
      });
    }
    return data(
      { ok: false as const, message: "Unsupported field action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof EventFieldStateError) {
      return data(
        {
          ok: false as const,
          message:
            error instanceof ZodError
              ? (error.issues[0]?.message ?? "Review the field settings.")
              : error.message,
        },
        { status: error instanceof EventFieldStateError ? error.status : 422 },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Participant fields · Program Cue" }];

export default function AdminEventFields({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const activeDefinitions = loaderData.definitions.filter(
    (definition) => definition.status === "active",
  );
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Participant &amp; session fields</h1>
          <p>
            Control the standard participant profile and add a small set of
            event-owned typed fields.
          </p>
        </div>
        <ButtonLink to="/admin/event">Event settings</ButtonLink>
      </div>

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "Saved" : "Action blocked"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <section className="card pad mb" aria-labelledby="standard-fields-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Participant portal</span>
            <h2 id="standard-fields-title">Standard profile access</h2>
          </div>
        </div>
        <p className="help">
          Hidden fields are omitted from the portal. Read-only fields remain
          visible but can only be changed by an organiser. These rules are
          enforced on the server as well as in the form.
        </p>
        <Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="save-policies" />
          {fixedParticipantProfileFields.map((field) => (
            <label className="label" key={field.key}>
              {field.label}
              <select
                className="select"
                name={`policy:${field.key}`}
                defaultValue={loaderData.policies[field.key]}
              >
                <option value="editable">Participant can edit</option>
                <option value="read_only">Read-only</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
          ))}
          <Button type="submit" variant="primary">
            Save profile access
          </Button>
        </Form>
      </section>

      <section className="card pad mb" aria-labelledby="reusable-fields-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Event-owned metadata</span>
            <h2 id="reusable-fields-title">Reusable fields</h2>
          </div>
          <span className="pill">{activeDefinitions.length} active</span>
        </div>
        {activeDefinitions.length ? (
          <div className="stack mt">
            {activeDefinitions.map((field) => (
              <div className="validation-item" key={field.id}>
                <div>
                  <strong>{field.label}</strong>
                  <div className="help">
                    {field.ownerType} · {field.fieldType.replaceAll("_", " ")} ·{" "}
                    {field.participantAccess.replaceAll("_", " ")}
                    {field.required ? " · required" : ""}
                  </div>
                </div>
                <Form method="post" className="inline-form">
                  <input type="hidden" name="intent" value="archive-field" />
                  <input type="hidden" name="definitionId" value={field.id} />
                  <label className="toggle">
                    <input
                      type="checkbox"
                      name="confirmed"
                      value="true"
                      required
                    />
                    Archive
                  </label>
                  <Button type="submit" size="small">
                    Archive field
                  </Button>
                </Form>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No reusable fields yet.</p>
        )}
      </section>

      <section className="card pad" aria-labelledby="new-field-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">
              No formulas or dependencies
            </span>
            <h2 id="new-field-title">Add one typed field</h2>
          </div>
        </div>
        <Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="create-field" />
          <div className="form-row">
            <label className="label">
              Record type
              <select className="select" name="ownerType" defaultValue="person">
                <option value="person">Person</option>
                <option value="session">Session</option>
              </select>
            </label>
            <label className="label">
              Field type
              <select
                className="select"
                name="fieldType"
                defaultValue="short_text"
              >
                <option value="short_text">Short text</option>
                <option value="long_text">Long text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes / no</option>
                <option value="date">Date</option>
                <option value="single_choice">Single choice</option>
                <option value="multiple_choice">Multiple choice</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="label">
              Label
              <input className="field" name="label" required maxLength={120} />
            </label>
            <label className="label">
              Stable key
              <input
                className="field"
                name="fieldKey"
                required
                pattern="[a-z][a-z0-9_]{1,39}"
              />
            </label>
          </div>
          <label className="label">
            Choices (one per line)
            <textarea className="textarea" name="options" rows={4} />
            <span className="help">
              Required only for single- or multiple-choice fields.
            </span>
          </label>
          <label className="label">
            Participant access
            <select
              className="select"
              name="participantAccess"
              defaultValue="read_only"
            >
              <option value="read_only">Read-only</option>
              <option value="editable">
                Participant can edit (person fields only)
              </option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" name="required" value="true" /> Required
          </label>
          <Button type="submit" variant="primary">
            Create field
          </Button>
        </Form>
      </section>
    </div>
  );
}
