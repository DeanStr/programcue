import { Form, Link } from "react-router";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { useEvaluationDiscussionHistory } from "~/components/evaluation-discussion-history";
import { EventDateTime } from "~/components/ui/event-date-time";

export function EvaluationDiscussionPanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  const discussion = loaderData.reviewDiscussion;
  const history = useEvaluationDiscussionHistory(discussion);
  if (!discussion) return null;
  if (!loaderData.reviewDiscussionTitle) {
    throw new Error("The evaluation discussion target title is unavailable.");
  }
  const adding =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "add-discussion-message";
  return (
    <section
      className="card pad mt"
      id="evaluation-discussion"
      aria-labelledby="evaluation-discussion-title"
    >
      <div className="card-title">
        <div>
          <h2 id="evaluation-discussion-title">Committee discussion</h2>
          <p className="subtle">
            {loaderData.reviewDiscussionTitle} · this thread is confined to the
            selected round.
          </p>
        </div>
        <span className="status info right">
          {history.messages.length}
          {history.hasEarlier ? "+" : ""} message
          {history.messages.length === 1 && !history.hasEarlier ? "" : "s"}
        </span>
      </div>
      {history.hasEarlier ? (
        <div className="page-actions mb">
          <button
            className="btn small"
            type="button"
            disabled={history.loadingEarlier}
            onClick={history.loadEarlier}
          >
            {history.loadingEarlier ? "Loading…" : "Load earlier messages"}
          </button>
        </div>
      ) : null}
      {history.messages.length ? (
        <ol className="list-clean stack">
          {history.messages.map((message) => (
            <li className="card pad" key={message.id}>
              <div className="card-title">
                <strong>{message.authorName}</strong>
                <EventDateTime
                  className="subtle right"
                  epochSeconds={message.createdAt}
                  timeZone={loaderData.eventTimezone}
                />
              </div>
              <p>{message.body}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="subtle">No committee messages yet.</p>
      )}
      {discussion.writable ? (
        <Form className="stack mt" key={discussion.postIntentId} method="post">
          <input type="hidden" name="intent" value="add-discussion-message" />
          <input
            type="hidden"
            name="roundId"
            value={discussion.target.roundId}
          />
          <input
            type="hidden"
            name="targetType"
            value={discussion.target.targetType}
          />
          <input
            type="hidden"
            name="targetId"
            value={discussion.target.targetId}
          />
          <input
            type="hidden"
            name="idempotencyKey"
            value={discussion.postIntentId}
          />
          <label className="label">
            Add to discussion
            <textarea
              className="textarea"
              name="body"
              maxLength={2000}
              required
            />
          </label>
          <div className="page-actions">
            <button type="submit" className="btn primary" disabled={adding}>
              {adding ? "Adding…" : "Add message"}
            </button>
            <Link
              className="btn"
              to={`/admin/review?${new URLSearchParams({
                resultsRound: discussion.target.roundId,
                sort: loaderData.resultSort,
                ...(loaderData.reviewFilter
                  ? { filter: loaderData.reviewFilter }
                  : {}),
              })}#evaluation-results`}
            >
              Close discussion
            </Link>
          </div>
        </Form>
      ) : (
        <p className="help mt">This archived discussion is read-only.</p>
      )}
    </section>
  );
}
