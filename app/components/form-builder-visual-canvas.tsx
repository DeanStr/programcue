import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { type CSSProperties, Fragment, useState } from "react";
import { requireValue } from "~/lib/required-value";

import {
  conditionalFieldOrderIssue,
  createFormField,
  FORM_FIELD_TYPES,
  type FormFieldInsertionTarget,
  formConditionSourceLabel,
  formFieldCreationIssue,
  formFieldTypeLabel,
  insertFormFieldAtTarget,
  moveFormFieldToTarget,
} from "~/modules/submissions/form-builder-fields";
import type {
  FormField,
  SaveFormInput,
} from "~/modules/submissions/submission-schema";
import { formSectionsForAuthoring } from "~/modules/submissions/submission-schema";

type DraggedItem =
  | { kind: "new-field"; fieldType: FormField["type"]; label: string }
  | { kind: "field"; fieldId: string; label: string };

function fieldsInSectionOrder(input: SaveFormInput) {
  return formSectionsForAuthoring(input.schema).flatMap(
    (section) => section.fields,
  );
}

const formCollisionDetection: CollisionDetection = (args) => {
  const canvasTargets = args.droppableContainers.filter(
    (container) => container.data.current?.kind === "canvas-boundary",
  );
  if (!pointerWithin({ ...args, droppableContainers: canvasTargets }).length) {
    return [];
  }
  const insertionTargets = args.droppableContainers.filter(
    (container) => container.data.current?.kind === "insertion-target",
  );
  const directInsertionTarget = pointerWithin({
    ...args,
    droppableContainers: insertionTargets,
  });
  if (directInsertionTarget.length) return directInsertionTarget;
  return closestCenter({
    ...args,
    droppableContainers: insertionTargets.length
      ? insertionTargets
      : args.droppableContainers,
  });
};

function PaletteField({
  type,
  label,
  add,
}: {
  type: FormField["type"];
  label: string;
  add(): void;
}) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `form-palette:${type}`,
    data: { kind: "new-field", fieldType: type, label } satisfies DraggedItem,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`fb-canvas-palette-field${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      onClick={add}
      aria-label={`Add ${label}`}
      {...listeners}
    >
      <GripVertical size={14} aria-hidden="true" />
      {label}
    </button>
  );
}

function FieldControlPreview({ field }: { field: FormField }) {
  if (field.type === "long_text") {
    return (
      <textarea
        disabled
        rows={2}
        aria-label={`${field.label} preview`}
        placeholder={field.example || "Long answer"}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select disabled defaultValue="" aria-label={`${field.label} preview`}>
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (field.type === "multi_select") {
    return (
      <span className="fb-canvas-checklist">
        {field.options.slice(0, 3).map((option) => (
          <span key={option}>
            <input
              type="checkbox"
              disabled
              aria-label={`${field.label}: ${option} preview`}
            />{" "}
            {option}
          </span>
        ))}
        {field.options.length > 3 ? (
          <small>+{field.options.length - 3} more</small>
        ) : null}
      </span>
    );
  }
  return (
    <input
      disabled
      type={field.type === "url" || field.type === "video" ? "url" : "text"}
      aria-label={`${field.label} preview`}
      placeholder={field.example || formFieldTypeLabel(field.type)}
    />
  );
}

function CanvasField({
  field,
  selected,
  select,
  openSettings,
  conditionSourceLabel,
}: {
  field: FormField;
  selected: boolean;
  select(): void;
  openSettings(): void;
  conditionSourceLabel: string | null;
}) {
  const draggable = useDraggable({
    id: `form-field:${field.id}`,
    data: {
      kind: "field",
      fieldId: field.id,
      label: field.label,
    } satisfies DraggedItem,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(draggable.transform),
  };

  return (
    <li
      ref={draggable.setNodeRef}
      className={`fb-canvas-field${selected ? " is-selected" : ""}${draggable.isDragging ? " is-dragging" : ""}`}
      style={style}
      data-field-id={field.id}
    >
      <div className="fb-canvas-field-head">
        <span
          className="fb-canvas-drag-handle"
          title={`Drag to reorder ${field.label}`}
          aria-hidden="true"
          {...draggable.listeners}
        >
          <GripVertical size={17} aria-hidden="true" />
        </span>
        <button
          type="button"
          className="fb-canvas-field-select"
          aria-current={selected ? "true" : undefined}
          onClick={select}
        >
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
          <small>{formFieldTypeLabel(field.type)}</small>
        </button>
      </div>
      {field.help ? <p>{field.help}</p> : null}
      <div className="fb-canvas-control">
        <FieldControlPreview field={field} />
      </div>
      {field.condition ? (
        <small className="fb-canvas-condition">
          Shown when {conditionSourceLabel} = {field.condition.equals || "…"}
        </small>
      ) : null}
      {selected ? (
        // biome-ignore lint/a11y/useValidAnchor: This control both reveals the settings panel and navigates to its fragment.
        <a
          className="fb-canvas-edit-link"
          href="#form-builder-field-settings"
          onClick={openSettings}
        >
          Edit {field.label} settings
        </a>
      ) : null}
    </li>
  );
}

function CanvasInsertionTarget({
  target,
  empty,
}: {
  target: FormFieldInsertionTarget;
  empty?: boolean;
}) {
  const droppable = useDroppable({
    id: `form-insertion:${target.sectionId}:${target.index}`,
    data: { kind: "insertion-target", ...target },
  });

  return (
    <li
      ref={droppable.setNodeRef}
      className={`fb-canvas-insertion-target${empty ? " is-empty" : ""}${droppable.isOver ? " is-over" : ""}`}
      data-drop-index={target.index}
      data-drop-section={target.sectionId}
      aria-hidden="true"
    />
  );
}

function CanvasPage({
  input,
  selectedId,
  onSelect,
  onOpenSettings,
}: {
  input: SaveFormInput;
  selectedId: string | undefined;
  onSelect(fieldId: string): void;
  onOpenSettings(): void;
}) {
  const canvas = useDroppable({
    id: "form-canvas-boundary",
    data: { kind: "canvas-boundary" },
  });
  const sections = formSectionsForAuthoring(input.schema);
  const orderedFields = sections.flatMap((section) => section.fields);

  return (
    <div ref={canvas.setNodeRef} className="fb-canvas-page">
      <div className="fb-canvas-introduction">
        <strong>Introduction</strong>
        <p>
          {input.schema.introduction || "Add an introduction to your form."}
        </p>
      </div>
      <ol className="fb-canvas-fields">
        {sections.map((section) => (
          <Fragment key={section.id}>
            <li className="fb-canvas-section">
              <strong>{section.title}</strong>
              {section.description ? <p>{section.description}</p> : null}
            </li>
            <CanvasInsertionTarget
              target={{ sectionId: section.id, index: 0 }}
              empty={section.fields.length === 0}
            />
            {section.fields.map((field, index) => (
              <Fragment key={field.id}>
                <CanvasField
                  field={field}
                  selected={field.id === selectedId}
                  select={() => onSelect(field.id)}
                  openSettings={onOpenSettings}
                  conditionSourceLabel={
                    field.condition
                      ? formConditionSourceLabel(
                          orderedFields,
                          field.condition.fieldId,
                        )
                      : null
                  }
                />
                <CanvasInsertionTarget
                  target={{ sectionId: section.id, index: index + 1 }}
                />
              </Fragment>
            ))}
          </Fragment>
        ))}
      </ol>
      {!input.schema.fields.length ? (
        <p className="fb-canvas-empty">Drag a field here to begin.</p>
      ) : null}
    </div>
  );
}

export function FormBuilderVisualCanvas({
  input,
  selectedId,
  change,
  onSelect,
  onOpenSettings,
  operationMessage,
  onOperationBlocked,
}: {
  input: SaveFormInput;
  selectedId: string | undefined;
  change(next: SaveFormInput): void;
  onSelect(fieldId: string): void;
  onOpenSettings(): void;
  operationMessage: string | null;
  onOperationBlocked(message: string): void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);

  function insertField(
    type: FormField["type"],
    target: FormFieldInsertionTarget,
  ) {
    const orderedFields = fieldsInSectionOrder(input);
    const issue = formFieldCreationIssue(orderedFields, type);
    if (issue) {
      onOperationBlocked(issue);
      return;
    }
    const field = createFormField(orderedFields, type, target.sectionId);
    const fields = insertFormFieldAtTarget(
      orderedFields,
      field,
      target,
      input.schema.sections.map((section) => section.id),
    );
    change({ ...input, schema: { ...input.schema, fields } });
    onSelect(field.id);
  }

  function addField(type: FormField["type"]) {
    const section = requireValue(
      input.schema.sections.at(-1),
      "Required input.schema.sections.at(-1) is unavailable.",
    );
    const sectionFieldCount = input.schema.fields.filter(
      (field) => field.sectionId === section.id,
    ).length;
    insertField(type, { sectionId: section.id, index: sectionFieldCount });
  }

  function finishDrag(event: DragEndEvent) {
    setDraggedItem(null);
    const active = event.active.data.current as DraggedItem | undefined;
    const over = event.over?.data.current as
      | ({ kind: "insertion-target" } & FormFieldInsertionTarget)
      | undefined;
    if (!active || !over || over.kind !== "insertion-target") return;

    const target = { sectionId: over.sectionId, index: over.index };

    if (active.kind === "new-field") {
      insertField(active.fieldType, target);
      return;
    }

    const orderedFields = fieldsInSectionOrder(input);
    const fields = moveFormFieldToTarget(
      orderedFields,
      active.fieldId,
      target,
      input.schema.sections.map((section) => section.id),
    );
    if (!fields) return;
    const issue = conditionalFieldOrderIssue(fields);
    if (issue) {
      onOperationBlocked(issue);
      return;
    }
    change({ ...input, schema: { ...input.schema, fields } });
    onSelect(active.fieldId);
  }

  function startDrag(event: DragStartEvent) {
    setDraggedItem(event.active.data.current as DraggedItem);
  }

  return (
    <DndContext
      id="form-builder-dnd-instructions"
      sensors={sensors}
      collisionDetection={formCollisionDetection}
      onDragStart={startDrag}
      onDragCancel={() => setDraggedItem(null)}
      onDragEnd={finishDrag}
    >
      <section
        className="program-cue-form-canvas"
        aria-label="Visual call-for-speakers form editor"
      >
        <fieldset
          className="fb-canvas-palette pc-plain-fieldset"
          aria-label="Field palette"
        >
          <strong>Add a field</strong>
          <span>Drag into the form or select to append.</span>
          <div className="fb-canvas-palette-fields">
            {FORM_FIELD_TYPES.map(({ value, label }) => (
              <PaletteField
                key={value}
                type={value}
                label={label}
                add={() => addField(value)}
              />
            ))}
          </div>
          {operationMessage ? (
            <div
              className="validation-item error fb-canvas-operation-message"
              role="alert"
            >
              <strong>Canvas action blocked</strong>
              <span>{operationMessage}</span>
            </div>
          ) : null}
        </fieldset>
        <CanvasPage
          input={input}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
        />
      </section>
      <DragOverlay dropAnimation={null}>
        {draggedItem ? (
          <div className="fb-canvas-drag-overlay">
            <GripVertical size={16} aria-hidden="true" />
            {draggedItem.label}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
