export type PropertyOwnership = "source" | "edit-only";

export type BackingValue = { present: boolean; value: unknown };
export type EditValue = { value: unknown; editedAt: number } | null;

export type Resolved = { present: boolean; value: unknown };

/**
 * Newer edit wins. An equal or newer source timestamp suppresses the edit.
 * A missing source timestamp permits the edit. Omitted source properties do not
 * suppress it; an explicit null is a real source value. Edit-only properties survive.
 * Comparison uses the unedited source timestamp.
 */
export function resolveProperty(
  backing: BackingValue,
  edit: EditValue,
  sourceTimestamp: number | null,
  ownership: PropertyOwnership,
): Resolved {
  if (ownership === "edit-only") {
    if (!edit) return { present: false, value: undefined };
    return { present: true, value: edit.value };
  }
  if (!backing.present) {
    if (edit) return { present: true, value: edit.value };
    return { present: false, value: undefined };
  }
  if (!edit) return { present: true, value: backing.value };
  if (sourceTimestamp == null) return { present: true, value: edit.value };
  if (edit.editedAt > sourceTimestamp) return { present: true, value: edit.value };
  return { present: true, value: backing.value };
}

export type StoredEdit = {
  property: string;
  value: unknown;
  editedAt: number;
  ownership: PropertyOwnership;
};

export function resolveObject(
  properties: Record<string, unknown>,
  present: string[],
  edits: StoredEdit[],
  sourceTimestamp: number | null,
  editOnly: readonly string[],
): Record<string, unknown> {
  const editMap = new Map(edits.map((edit) => [edit.property, edit]));
  const keys = new Set<string>([...present, ...edits.map((edit) => edit.property)]);
  const resolved: Record<string, unknown> = {};
  for (const key of keys) {
    const edit = editMap.get(key);
    const ownership: PropertyOwnership =
      edit?.ownership === "edit-only" || editOnly.includes(key) ? "edit-only" : "source";
    const result = resolveProperty(
      { present: present.includes(key), value: properties[key] },
      edit ? { value: edit.value, editedAt: edit.editedAt } : null,
      sourceTimestamp,
      ownership,
    );
    if (result.present) resolved[key] = result.value;
  }
  return resolved;
}
