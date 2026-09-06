import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";
import type { ReviewAssignment } from "./review-workbench-contract";

/* Every scale renders as a radio group, so the group — not one control — is
   the scoring unit the keyboard drives. Marked in the DOM because the shortcut
   handler runs at the document, above the component that renders the rubric. */
const SCALE_GROUP_SELECTOR = "[data-review-scale]";

// A dialog owns the keyboard while it is open: a shortcut firing behind a modal
// edits a record the reviewer cannot see.
function reviewDialogIsOpen() {
  return Boolean(
    document.querySelector("[role='dialog'],[role='alertdialog']"),
  );
}

function reviewTargetIsTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  // Radios are the scoring control itself, so digits have to reach them.
  return target instanceof HTMLInputElement && target.type !== "radio";
}

/* A digit lands on the group focus is in; with focus outside the rubric it
   fills the first unscored group and moves on, so 4-4-3-5 typed blind scores
   the rubric top to bottom. */
function scoreRubricFromDigit(form: HTMLFormElement, digit: number) {
  const groups = Array.from(
    form.querySelectorAll<HTMLElement>(SCALE_GROUP_SELECTOR),
  );
  if (!groups.length) return false;
  const unscored = groups.filter(
    (group) => !group.querySelector("input:checked:not([value=''])"),
  );
  const focused = groups.find(
    (group) =>
      document.activeElement instanceof Node &&
      group.contains(document.activeElement),
  );
  const target = focused ?? unscored[0] ?? groups[0];
  const option =
    target.querySelectorAll<HTMLInputElement>(
      "input[type='radio']:not([value=''])",
    )[digit - 1] ?? null;
  if (!option || option.disabled) return false;
  option.click();
  const next = unscored.find(
    (group) =>
      group !== target && !group.querySelector("input:checked:not([value=''])"),
  );
  (
    next?.querySelector<HTMLInputElement>(
      "input[type='radio']:not(:disabled)",
    ) ?? option
  ).focus();
  return true;
}

export function useReviewWorkbenchShortcuts({
  previousAssignment,
  nextAssignment,
  readOnly,
  requestAssignmentNavigation,
  formRef,
  submitNextTriggerRef,
  saveDraftTriggerRef,
  setShortcutsOpen,
  assignmentKey,
}: {
  previousAssignment: ReviewAssignment | null;
  nextAssignment: ReviewAssignment | null;
  readOnly: boolean;
  requestAssignmentNavigation(href: string): void;
  formRef: RefObject<HTMLFormElement | null>;
  submitNextTriggerRef: RefObject<HTMLButtonElement | null>;
  saveDraftTriggerRef: RefObject<HTMLButtonElement | null>;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  assignmentKey: string;
}) {
  /* The shortcut handler reads the model through a ref rather than through its
     dependency list: navigation closes over autosave state that changes on
     every keystroke, and resubscribing the document listener that often would
     make a keypress depend on render timing. */
  const shortcutModel = useRef({
    previousAssignment,
    nextAssignment,
    readOnly,
    requestAssignmentNavigation,
  });
  useEffect(() => {
    shortcutModel.current = {
      previousAssignment,
      nextAssignment,
      readOnly,
      requestAssignmentNavigation,
    };
  });
  useEffect(() => {
    function openAssignment(assignment: ReviewAssignment | null) {
      if (!assignment) return false;
      shortcutModel.current.requestAssignmentNavigation(
        `/review/workbench?assignment=${assignment.id}`,
      );
      return true;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || reviewDialogIsOpen()) return;
      const locked = shortcutModel.current.readOnly;
      if (event.metaKey || event.ctrlKey) {
        // Commit shortcuts stay live inside the notes fields: they are the
        // fields a reviewer is in when the review is finished.
        if (event.key === "Enter" && !locked) {
          event.preventDefault();
          submitNextTriggerRef.current?.click();
        } else if (event.key.toLowerCase() === "s" && !locked) {
          event.preventDefault();
          saveDraftTriggerRef.current?.click();
        }
        return;
      }
      if (event.altKey || reviewTargetIsTyping(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.shiftKey) return;
      if (event.key === "j" || event.key === "]") {
        if (openAssignment(shortcutModel.current.nextAssignment))
          event.preventDefault();
        return;
      }
      if (event.key === "k" || event.key === "[") {
        if (openAssignment(shortcutModel.current.previousAssignment))
          event.preventDefault();
        return;
      }
      if (!locked && /^[1-9]$/.test(event.key) && formRef.current) {
        if (scoreRubricFromDigit(formRef.current, Number(event.key)))
          event.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [formRef, submitNextTriggerRef, saveDraftTriggerRef, setShortcutsOpen]);
  /* Opening an assignment puts the caret where the work starts. Only on a
     change: stealing focus on first paint would move a screen reader off the
     page heading before it has been read. */
  const focusedAssignmentKey = useRef(assignmentKey);
  useEffect(() => {
    if (focusedAssignmentKey.current === assignmentKey) return;
    focusedAssignmentKey.current = assignmentKey;
    const form = formRef.current;
    if (!form || readOnly) return;
    const groups = Array.from(
      form.querySelectorAll<HTMLElement>(SCALE_GROUP_SELECTOR),
    );
    const target =
      groups.find(
        (group) => !group.querySelector("input:checked:not([value=''])"),
      ) ?? groups[0];
    target
      ?.querySelector<HTMLInputElement>("input[type='radio']:not(:disabled)")
      ?.focus();
  }, [assignmentKey, readOnly, formRef]);
}
