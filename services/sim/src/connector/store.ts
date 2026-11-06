import { join } from "node:path";
import { Sqlite } from "../lab/sqlite.js";
import type { SnapshotKind, SnapshotRow } from "@shift4/contracts";

export type StoredGeneration = {
  id: string;
  kind: SnapshotKind;
  capturedAt: number;
  status: "captured" | "committed" | "failed";
  rows: SnapshotRow[];
  objectTypes: string[];
  error: string | null;
};

export class ConnectorStore {
  readonly db: Sqlite;
  private seq = 1;

  constructor(dataDir: string) {
    this.db = new Sqlite(join(dataDir, "connector.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        object_types_json TEXT NOT NULL,
        error TEXT
      );
    `);
  }

  reset(): void {
    this.db.exec("DELETE FROM generations;");
    this.seq = 1;
  }

  nextId(kind: string, capturedAt: number): string {
    return `gen-${kind}-${capturedAt}-${this.seq++}`;
  }

  save(generation: StoredGeneration): void {
    this.db.run(
      `INSERT INTO generations (id, kind, captured_at, status, payload_json, object_types_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      generation.id,
      generation.kind,
      generation.capturedAt,
      generation.status,
      JSON.stringify(generation.rows),
      JSON.stringify(generation.objectTypes),
      generation.error,
    );
  }

  update(id: string, status: StoredGeneration["status"], error: string | null): void {
    this.db.run("UPDATE generations SET status = ?, error = ? WHERE id = ?", status, error, id);
  }

  get(id: string): StoredGeneration | undefined {
    const row = this.db.get<{
      id: string;
      kind: SnapshotKind;
      captured_at: number;
      status: StoredGeneration["status"];
      payload_json: string;
      object_types_json: string;
      error: string | null;
    }>("SELECT * FROM generations WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      capturedAt: row.captured_at,
      status: row.status,
      rows: JSON.parse(row.payload_json) as SnapshotRow[],
      objectTypes: JSON.parse(row.object_types_json) as string[],
      error: row.error,
    };
  }

  close(): void {
    this.db.close();
  }
}
