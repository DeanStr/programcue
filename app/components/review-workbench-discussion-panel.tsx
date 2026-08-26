import { Lock } from "lucide-react";
import { useFetcher } from "react-router";
import { useEvaluationDiscussionHistory } from "~/components/evaluation-discussion-history";
import { useReviewWorkbenchModel } from "~/components/review-workbench-model";
import { Button } from "~/components/ui/button";
import { EventDateTime } from "~/components/ui/event-date-time";

export function ReviewDiscussionPanel() {
  const { workspace, eventTimezone } = useReviewWorkbenchModel();
  const discussion = workspace.discussion;
  const history = useEvaluationDiscussionHistory(discussion);
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
    <section
      className="card pad mt review-discussion"
      aria-labelledby="review-discussion-title"
    >
      <div className="card-title">
        <div>
          <h2 id="review-discussion-title">Committee discussion</h2>
          <p className="subtle">
            This thread belongs only to this review round and target.
          </p>
        </div>
        {discussion.available ? (
          <span className="review-discussion-count pc-num">
            {history.messages.length}
            {history.hasEarlier ? "+" : ""} message
            {history.messages.length === 1 && !history.hasEarlier ? "" : "s"}
          </span>
        ) : null}
      </div>
      {!discussion.available ? (
        <div className="review-discussion-locked">
          <Lock aria-hidden size={16} />
          <div>
            <strong>Independent review first</strong>
            <p>
              Submit your review before reading or joining this target&rsquo;s
              committee discussion.
            </p>
          </div>
        </div>
      ) : (
        <>
          {history.hasEarlier ? (
            <div className="page-actions mb">
              <Button
                size="small"
                type="button"
                disabled={history.loadingEarlier}
                onClick={history.loadEarlier}
              >
                {history.loadingEarlier ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          ) : null}
          {history.messages.length ? (
            <ol className="list-clean review-discussion-thread">
              {history.messages.map((message) => (
                <li className="review-discussion-message" key={message.id}>
                  <div className="review-discussion-meta">
                    <strong>{message.authorName}</strong>
                    <EventDateTime
                      className="subtle"
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
                <Button
                  type="submit"
                  variant="primary"
                  disabled={fetcher.state !== "idle"}
                >
                  {fetcher.state === "idle" ? "Add message" : "Adding…"}
                </Button>
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
