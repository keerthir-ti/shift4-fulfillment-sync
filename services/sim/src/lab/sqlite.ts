import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: (string | number | null | bigint)[]): { changes: number };
      get(...params: (string | number | null | bigint)[]): unknown;
      all(...params: (string | number | null | bigint)[]): unknown[];
    };
    close(): void;
  };
};

type RunResult = { changes: number };

export class Sqlite {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: (string | number | null | bigint)[]): RunResult {
    return this.db.prepare(sql).run(...params) as RunResult;
  }

  get<T>(sql: string, ...params: (string | number | null | bigint)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: (string | number | null | bigint)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
