import { join } from "node:path";
import { EDIT_ONLY_PROPERTIES, type ObjectType, type SnapshotRow } from "@shift4/contracts";
import { Sqlite } from "../lab/sqlite.js";
import { resolveObject, type StoredEdit } from "./reconcile.js";

export type GenerationRecord = {
  id: string;
  kind: string;
  capturedAt: number;
  committedAt: number | null;
  status: "committed" | "failed";
  error: string | null;
};

type EditRow = {
  object_type: string;
  object_key: string;
  property: string;
  value_json: string;
  edited_at: number;
  ownership: "source" | "edit-only";
};

export class FoundryStore {
  readonly db: Sqlite;

  constructor(dataDir: string) {
    this.db = new Sqlite(join(dataDir, "foundry.sqlite"));
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        committed_at INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        object_types_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS backing_rows (
        generation_id TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_key TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        present_json TEXT NOT NULL,
        source_timestamp INTEGER,
        PRIMARY KEY (generation_id, object_type, object_key)
      );
      CREATE TABLE IF NOT EXISTS edits (
        object_type TEXT NOT NULL,
        object_key TEXT NOT NULL,
        property TEXT NOT NULL,
        value_json TEXT NOT NULL,
        edited_at INTEGER NOT NULL,
        ownership TEXT NOT NULL,
        PRIMARY KEY (object_type, object_key, property)
      );
      CREATE TABLE IF NOT EXISTS indexed_objects (
        object_type TEXT NOT NULL,
        object_key TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        source_timestamp INTEGER,
        PRIMARY KEY (object_type, object_key)
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        message TEXT,
        failed_kind TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS deleted_objects (
        object_type TEXT NOT NULL,
        object_key TEXT NOT NULL,
        PRIMARY KEY (object_type, object_key)
      );
      INSERT OR IGNORE INTO sync_state (id, status, message, failed_kind, updated_at) VALUES (1, 'unknown', NULL, NULL, NULL);
    `);
  }

  reset(): void {
    this.db.exec("DELETE FROM backing_rows; DELETE FROM generations; DELETE FROM edits; DELETE FROM indexed_objects; DELETE FROM deleted_objects;");
    this.db.run("UPDATE sync_state SET status = 'unknown', message = NULL, failed_kind = NULL, updated_at = NULL WHERE id = 1");
  }

  writeGeneration(id: string, kind: string, capturedAt: number, committedAt: number, rows: SnapshotRow[], objectTypes: ObjectType[]): void {
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO generations (id, kind, captured_at, committed_at, status, error, object_types_json) VALUES (?, ?, ?, ?, 'committed', NULL, ?)",
        id,
        kind,
        capturedAt,
        committedAt,
        JSON.stringify(objectTypes),
      );
      for (const row of rows) {
        this.db.run(
          `INSERT INTO backing_rows (generation_id, object_type, object_key, properties_json, present_json, source_timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          row.objectType,
          row.objectKey,
          JSON.stringify(row.properties),
          JSON.stringify(row.present),
          row.sourceTimestamp,
        );
      }
    });
  }

  recordFailure(id: string, kind: string, capturedAt: number, message: string, at: number): void {
    this.db.run(
      "INSERT INTO generations (id, kind, captured_at, committed_at, status, error) VALUES (?, ?, ?, NULL, 'failed', ?)",
      id,
      kind,
      capturedAt,
      message,
    );
    this.db.run("UPDATE sync_state SET status = 'stale', message = ?, failed_kind = ?, updated_at = ? WHERE id = 1", message, kind, at);
  }

  markSynced(at: number, kind?: string): void {
    const current = this.syncState();
    if (current.status === "stale" && current.failedKind && kind && current.failedKind !== kind) return;
    this.db.run("UPDATE sync_state SET status = 'ok', message = NULL, failed_kind = NULL, updated_at = ? WHERE id = 1", at);
  }

  syncState(): { status: string; message: string | null; failedKind: string | null; updatedAt: number | null } {
    const row = this.db.get<{ status: string; message: string | null; failed_kind: string | null; updated_at: number | null }>(
      "SELECT status, message, failed_kind, updated_at FROM sync_state WHERE id = 1",
    );
    return {
      status: row?.status ?? "unknown",
      message: row?.message ?? null,
      failedKind: row?.failed_kind ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  generations(): GenerationRecord[] {
    return this.db
      .all<{
        id: string;
        kind: string;
        captured_at: number;
        committed_at: number | null;
        status: "committed" | "failed";
        error: string | null;
      }>("SELECT * FROM generations ORDER BY captured_at, id")
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        capturedAt: row.captured_at,
        committedAt: row.committed_at,
        status: row.status,
        error: row.error,
      }));
  }

  rows(generationId: string): SnapshotRow[] {
    return this.db
      .all<{
        object_type: ObjectType;
        object_key: string;
        properties_json: string;
        present_json: string;
        source_timestamp: number | null;
      }>("SELECT * FROM backing_rows WHERE generation_id = ?", generationId)
      .map((row) => ({
        objectType: row.object_type,
        objectKey: row.object_key,
        properties: JSON.parse(row.properties_json) as Record<string, unknown>,
        present: JSON.parse(row.present_json) as string[],
        sourceTimestamp: row.source_timestamp,
      }));
  }

  upsertEdit(objectType: ObjectType, objectKey: string, property: string, value: unknown, editedAt: number, ownership: "source" | "edit-only"): void {
    this.db.run(
      `INSERT INTO edits (object_type, object_key, property, value_json, edited_at, ownership)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(object_type, object_key, property)
       DO UPDATE SET value_json = excluded.value_json, edited_at = excluded.edited_at, ownership = excluded.ownership`,
      objectType,
      objectKey,
      property,
      JSON.stringify(value),
      editedAt,
      ownership,
    );
  }

  editsFor(objectType: string, objectKey: string): StoredEdit[] {
    return this.db
      .all<EditRow>("SELECT * FROM edits WHERE object_type = ? AND object_key = ?", objectType, objectKey)
      .map(mapEdit);
  }

  /**
   * Foundry's documented rules for "Apply most recent value". Each edit is compared on its own with the
   * datasource's timestamp, and the edit wins only if it's newer. An object an Action created stays when
   * its source row disappears, and an object deleted by an Action stays deleted if the row reappears.
   */
  publish(generationId: string, indexedAt: number, options: { append?: boolean } = {}): void {
    const rows = this.rows(generationId);
    const declared = this.db.get<{ object_types_json: string }>("SELECT object_types_json FROM generations WHERE id = ?", generationId);
    const types = (declared ? (JSON.parse(declared.object_types_json) as ObjectType[]) : [...new Set(rows.map((row) => row.objectType))]);
    this.db.transaction(() => {
      for (const objectType of types) {
        if (!options.append) this.db.run("DELETE FROM indexed_objects WHERE object_type = ?", objectType);
        const deleted = new Set(this.db.all<{ object_key: string }>("SELECT object_key FROM deleted_objects WHERE object_type = ?", objectType).map((row) => row.object_key));
        const backed = new Set<string>();
        for (const row of rows.filter((candidate) => candidate.objectType === objectType)) {
          backed.add(row.objectKey);
          if (deleted.has(row.objectKey)) continue;
          const properties = resolveObject(
            row.properties,
            row.present,
            this.editsFor(objectType, row.objectKey),
            row.sourceTimestamp,
            EDIT_ONLY_PROPERTIES,
          );
          this.db.run(
            `INSERT OR REPLACE INTO indexed_objects (object_type, object_key, properties_json, indexed_at, source_timestamp)
             VALUES (?, ?, ?, ?, ?)`,
            objectType,
            row.objectKey,
            JSON.stringify(properties),
            indexedAt,
            row.sourceTimestamp,
          );
        }
        if (options.append) continue;
        const created = this.db.all<{ object_key: string }>("SELECT DISTINCT object_key FROM edits WHERE object_type = ? AND ownership = 'source'", objectType);
        for (const { object_key: objectKey } of created) {
          if (backed.has(objectKey) || deleted.has(objectKey)) continue;
          const properties = Object.fromEntries(this.editsFor(objectType, objectKey).map((edit) => [edit.property, edit.value]));
          this.upsertIndexed(objectType, objectKey, properties, indexedAt, null);
        }
      }
    });
    const kind = this.db.get<{ kind: string }>("SELECT kind FROM generations WHERE id = ?", generationId)?.kind;
    this.markSynced(indexedAt, kind);
  }

  /** A "Delete object" Action: gone now, and a row reappearing in a later snapshot doesn't undo it. */
  deleteObject(objectType: ObjectType, objectKey: string): void {
    this.db.run("DELETE FROM indexed_objects WHERE object_type = ? AND object_key = ?", objectType, objectKey);
    this.db.run("DELETE FROM edits WHERE object_type = ? AND object_key = ?", objectType, objectKey);
    this.db.run("INSERT OR IGNORE INTO deleted_objects (object_type, object_key) VALUES (?, ?)", objectType, objectKey);
  }

  private getIndexedRow(objectType: ObjectType, objectKey: string) {
    const row = this.db.get<{ properties_json: string; indexed_at: number; source_timestamp: number | null }>(
      "SELECT properties_json, indexed_at, source_timestamp FROM indexed_objects WHERE object_type = ? AND object_key = ?",
      objectType,
      objectKey,
    );
    return row ? { properties: JSON.parse(row.properties_json) as Record<string, unknown>, indexedAt: row.indexed_at, sourceTimestamp: row.source_timestamp } : undefined;
  }

  upsertIndexed(objectType: ObjectType, objectKey: string, properties: Record<string, unknown>, indexedAt: number, sourceTimestamp: number | null): void {
    this.db.run(
      `INSERT INTO indexed_objects (object_type, object_key, properties_json, indexed_at, source_timestamp)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(object_type, object_key)
       DO UPDATE SET properties_json = excluded.properties_json, indexed_at = excluded.indexed_at, source_timestamp = excluded.source_timestamp`,
      objectType,
      objectKey,
      JSON.stringify(properties),
      indexedAt,
      sourceTimestamp,
    );
    if (this.syncState().status === "unknown") this.markSynced(indexedAt);
  }

  listIndexed(objectType: ObjectType): { objectKey: string; properties: Record<string, unknown>; indexedAt: number }[] {
    return this.db
      .all<{ object_key: string; properties_json: string; indexed_at: number }>(
        "SELECT object_key, properties_json, indexed_at FROM indexed_objects WHERE object_type = ? ORDER BY object_key",
        objectType,
      )
      .map((row) => ({
        objectKey: row.object_key,
        properties: JSON.parse(row.properties_json) as Record<string, unknown>,
        indexedAt: row.indexed_at,
      }));
  }

  getIndexed(objectType: ObjectType, objectKey: string): Record<string, unknown> | undefined {
    return this.getIndexedRow(objectType, objectKey)?.properties;
  }

  close(): void {
    this.db.close();
  }
}

function mapEdit(row: EditRow): StoredEdit {
  return {
    property: row.property,
    value: JSON.parse(row.value_json) as unknown,
    editedAt: row.edited_at,
    ownership: row.ownership,
  };
}
