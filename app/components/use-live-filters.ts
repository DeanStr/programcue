import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useLocation,
  useNavigate,
  useNavigation,
  useNavigationType,
} from "react-router";

/* A closed select fires a change on every arrow key, so a select waits long
   enough for keyboard traversal to make one request. Typing waits a little
   longer. Enter applies at once. */
const SELECT_DELAY_MS = 250;
const TEXT_DELAY_MS = 300;

type FilterControl = HTMLInputElement | HTMLSelectElement;

/* History entries keep their state, so an id from an earlier request can
   come back with Back or Forward; each request gets a fresh one. */
function filterRequestId(state: unknown) {
  return typeof state === "object" && state !== null && "liveFilter" in state
    ? state.liveFilter
    : undefined;
}

/**
 * A GET filter form that applies its own changes. `applied` holds the values
 * the loader used, keyed by control name.
 *
 * The controls are controlled and the form is never remounted, so focus and
 * anything typed while a request loads survive it. The form's own requests
 * replace the history entry and keep the scroll position. They are told apart
 * by an id in their history state, not by their URL, so Back to an entry with
 * the same query as a loading request is still Back. Back and Forward
 * restore their destination exactly: they discard edits that have not
 * loaded. Any other navigation (a view control, a link outside the form)
 * shows the values it loaded, except for a control whose edit has not loaded
 * yet: that keeps its value and is applied on top. A link inside the form,
 * such as Clear, also discards edits that have not loaded.
 */
export function useLiveFilters(applied: Record<string, string>) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [values, setValues] = useState(applied);
  const [reapply, setReapply] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // Control name → number of the edit that last changed it, until a request
  // carrying that edit has loaded.
  const edits = useRef(new Map<string, number>());
  const editCount = useRef(0);
  const requested = useRef<{
    id: string;
    search: string;
    edit: number;
  } | null>(null);
  const latest = useRef({ location, navigation, navigate });
  const mounted = useRef(false);

  useEffect(() => {
    latest.current = { location, navigation, navigate };
  });

  function apply() {
    window.clearTimeout(timer.current);
    const form = formRef.current;
    if (!form) return;
    const { location, navigation, navigate } = latest.current;
    // Another navigation is loading. Applying now would cancel it and resend
    // the values it is about to replace; its commit re-applies the edits.
    if (
      navigation.state !== "idle" &&
      (!requested.current ||
        filterRequestId(navigation.location?.state) !== requested.current.id)
    ) {
      return;
    }
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === "string") params.append(name, value);
    }
    const query = params.toString();
    const search = query ? `?${query}` : "";
    if (search === (requested.current?.search ?? location.search)) {
      // Edits that returned to the requested or loaded values need no request.
      if (requested.current) requested.current.edit = editCount.current;
      else edits.current.clear();
      return;
    }
    const id = crypto.randomUUID();
    requested.current = { id, search, edit: editCount.current };
    void navigate(
      { pathname: location.pathname, search },
      { replace: true, preventScrollReset: true, state: { liveFilter: id } },
    );
  }

  // A choice made before hydration is in the form but not in state; the next
  // render would put the loaded value back. Treat it as an edit. A select
  // whose loaded value has no option shows another option without any edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once, on the server-rendered form.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const typed: Record<string, string> = {};
    for (const [name, value] of Object.entries(applied)) {
      const control = form.elements.namedItem(name);
      if (
        (control instanceof HTMLInputElement ||
          (control instanceof HTMLSelectElement &&
            [...control.options].some((option) => option.value === value))) &&
        control.value !== value
      ) {
        typed[name] = control.value;
        editCount.current += 1;
        edits.current.set(name, editCount.current);
      }
    }
    if (Object.keys(typed).length) {
      setValues((current) => ({ ...current, ...typed }));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Each committed navigation is the trigger; `applied` belongs to the same render.
  useEffect(() => {
    const request = requested.current;
    requested.current = null;
    if (request && filterRequestId(location.state) === request.id) {
      for (const [name, edit] of edits.current) {
        if (edit <= request.edit) edits.current.delete(name);
      }
      return;
    }
    // The first commit is the document load, which reports POP; it keeps the
    // choices made before hydration. Later history traversal restores its
    // destination instead of re-applying a pending edit over it.
    const firstCommit = !mounted.current;
    mounted.current = true;
    if (!firstCommit && navigationType === "POP") {
      window.clearTimeout(timer.current);
      edits.current.clear();
      setValues(applied);
      return;
    }
    setValues((current) =>
      Object.fromEntries(
        Object.entries(applied).map(([name, value]) => [
          name,
          edits.current.has(name) ? (current[name] ?? value) : value,
        ]),
      ),
    );
    if (edits.current.size) setReapply((count) => count + 1);
  }, [location.key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once the kept edits have rendered into the form.
  useEffect(() => {
    if (reapply) apply();
  }, [reapply]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function field(name: string) {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Live filter control "${name}" has no applied value.`);
    }
    return {
      name,
      value,
      onChange(event: ChangeEvent<FilterControl>) {
        const control = event.currentTarget;
        setValues((current) => ({ ...current, [name]: control.value }));
        editCount.current += 1;
        edits.current.set(name, editCount.current);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(
          apply,
          control instanceof HTMLSelectElement
            ? SELECT_DELAY_MS
            : TEXT_DELAY_MS,
        );
      },
    };
  }

  return {
    form: {
      ref: formRef,
      method: "get" as const,
      onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        apply();
      },
      onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        if (event.target instanceof HTMLInputElement) {
          // A form with several text fields and no submit button has no
          // implicit submission, so Enter is handled here for every field.
          event.preventDefault();
          apply();
        } else if (event.target instanceof HTMLSelectElement) {
          apply();
        }
      },
      onClick(event: MouseEvent<HTMLFormElement>) {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          !(event.target instanceof Element) ||
          !event.target.closest("a[href]")
        ) {
          return;
        }
        window.clearTimeout(timer.current);
        edits.current.clear();
      },
    },
    field,
  };
}
