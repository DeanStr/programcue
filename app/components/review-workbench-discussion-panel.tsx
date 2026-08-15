import { useFetcher } from "react-router";
import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { EventDateTime } from "~/components/ui/event-date-time";

export function ReviewDiscussionPanel() {
  const { workspace, eventTimezone } = useReviewWorkbenchModel();
  const discussion = workspace.discussion;
  const discussionKey = discussion
    ? `${discussion.target.roundId}:${discussion.target.targetType}:${discussion.target.targetId}`
    : "none";
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    message?: string;
    committed?: boolean;
  }>({ key: `review-discussion:${discussionKey}` });
  if (!discussion) return null;
  return (
    <section className="card pad mt" aria-labelledby="review-discussion-title">
      <div className="card-title">
        <div>
          <h2 id="review-discussion-title">Committee discussion</h2>
          <p className="subtle">
            This thread belongs only to this review round and target.
          </p>
        </div>
        {discussion.available ? (
          <span className="status info right">
            {discussion.messages.length} message
            {discussion.messages.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {!discussion.available ? (
        <div className="validation-item warn">
          <strong>Independent review first</strong>
          <span>
            Submit your review before reading or joining this target&rsquo;s
            committee discussion.
          </span>
        </div>
      ) : (
        <>
          {discussion.messages.length ? (
            <ol className="list-clean stack">
              {discussion.messages.map((message) => (
                <li className="card pad" key={message.id}>
                  <div className="card-title">
                    <strong>{message.authorName}</strong>
                    <EventDateTime
                      className="subtle right"
                      epochSeconds={message.createdAt}
                      timeZone={eventTimezone}
                    />
                  </div>
                  <p>{message.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="subtle">No committee messages yet.</p>
          )}
          {fetcher.data ? (
            <div
              className={`validation-item ${fetcher.data.ok || fetcher.data.committed ? "ok" : "error"} mt`}
              role={
                fetcher.data.ok || fetcher.data.committed ? "status" : "alert"
              }
            >
              {"error" in fetcher.data
                ? fetcher.data.error
                : fetcher.data.message}
            </div>
          ) : null}
          {discussion.writable ? (
            <fetcher.Form
              className="stack mt"
              key={discussion.postIntentId}
              method="post"
            >
              <input
                type="hidden"
                name="intent"
                value="add-discussion-message"
              />
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
              <div>
                <button
                  className="btn primary"
                  disabled={fetcher.state !== "idle"}
                >
                  {fetcher.state === "idle" ? "Add message" : "Adding…"}
                </button>
              </div>
            </fetcher.Form>
          ) : (
            <p className="help mt">This archived discussion is read-only.</p>
          )}
        </>
      )}
    </section>
  );
}
