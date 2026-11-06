import { describe, expect, it } from "vitest";
import { resolveProperty, type BackingValue } from "../../services/sim/src/foundry/reconcile.js";

const absent: BackingValue = { present: false, value: undefined };

describe("resolveProperty", () => {
  it("keeps a newer edit and lets an equal or newer source suppress it", () => {
    const backing: BackingValue = { present: true, value: "oracle" };
    const edit = { value: "local", editedAt: 1500 };
    expect(resolveProperty(backing, edit, 1000, "source")).toEqual({ present: true, value: "local" });
    expect(resolveProperty(backing, edit, 1500, "source")).toEqual({ present: true, value: "oracle" });
    expect(resolveProperty(backing, edit, 2000, "source")).toEqual({ present: true, value: "oracle" });
  });

  it("permits an edit when the source timestamp is missing", () => {
    const backing: BackingValue = { present: true, value: "oracle" };
    expect(resolveProperty(backing, { value: "local", editedAt: 1 }, null, "source")).toEqual({
      present: true,
      value: "local",
    });
  });

  it("treats explicit null as a source value and omitted as absent", () => {
    const edit = { value: "local", editedAt: 1000 };
    expect(resolveProperty({ present: true, value: null }, edit, 2000, "source")).toEqual({
      present: true,
      value: null,
    });
    expect(resolveProperty(absent, edit, 2000, "source")).toEqual({ present: true, value: "local" });
  });

  it("keeps edit-only properties even when the source is newer", () => {
    expect(
      resolveProperty(absent, { value: true, editedAt: 1000 }, 9_000, "edit-only"),
    ).toEqual({ present: true, value: true });
    expect(resolveProperty(absent, null, 9_000, "edit-only")).toEqual({ present: false, value: undefined });
  });
});
