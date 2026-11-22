import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
}

export interface MigrationRunResult {
  fromVersion: number;
  toVersion: number;
  applied: { version: number; name: string }[];
  skipped: boolean;
}

function assertSqlIdentifier(identifier: string, label: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL ${label}: "${identifier}"`);
  }
}

/** Reads SQLite's built-in `PRAGMA user_version` schema version integer (0 for unversioned DBs). */
export function getSchemaVersion(database: Database.Database): number {
  return Number(database.pragma('user_version', { simple: true }) ?? 0);
}

/** Sets SQLite's built-in `PRAGMA user_version` after validating a non-negative integer version. */
export function setSchemaVersion(database: Database.Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid SQLite user_version: ${version}`);
  }
  database.pragma(`user_version = ${version}`);
}

export function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );
}

export function hasColumn(database: Database.Database, table: string, column: string): boolean {
  assertSqlIdentifier(table, 'table name');
  assertSqlIdentifier(column, 'column name');
  const cols = database.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some(c => c.name === column);
}

/**
 * Adds a column only if missing in `PRAGMA table_info`. Throws on SQL errors instead of
 * swallowing failures so broken migrations roll back atomically.
 */
export function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  definition: string
): boolean {
  assertSqlIdentifier(table, 'table name');
  assertSqlIdentifier(column, 'column name');
  if (!definition || !definition.trim()) {
    throw new Error(`Column definition for ${table}.${column} must be non-empty`);
  }
  if (hasColumn(database, table, column)) {
    return false;
  }
  database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  return true;
}

function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`Invalid migration version ${m.version}: versions must be positive integers starting at 1`);
    }
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version}`);
    }
    seen.add(m.version);
    const expected = i + 1;
    if (m.version !== expected) {
      throw new Error(`Non-sequential migration definitions: expected version ${expected}, found ${m.version}`);
    }
    if (!m.name || !m.name.trim()) {
      throw new Error(`Migration v${m.version} must have a non-empty name`);
    }
  }

  return sorted;
}

/**
 * Applies pending migrations strictly sequentially inside per-migration SQLite transactions,
 * advancing `PRAGMA user_version` atomically alongside each migration's DDL/DML changes.
 */
export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[]
): MigrationRunResult {
  const ordered = validateMigrations(migrations);
  const latest = ordered.length === 0 ? 0 : ordered[ordered.length - 1].version;
  const current = getSchemaVersion(database);

  if (current < 0) {
    throw new Error(`Invalid database schema version ${current}; expected >= 0`);
  }

  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than supported version ${latest}; refusing to run older code against a newer database schema.`
    );
  }

  if (current === latest) {
    return {
      fromVersion: current,
      toVersion: current,
      applied: [],
      skipped: true
    };
  }

  const applied: { version: number; name: string }[] = [];
  for (const m of ordered) {
    if (m.version <= current) continue;
    const applyOne = database.transaction(() => {
      m.up(database);
      setSchemaVersion(database, m.version);
    });
    applyOne();
    applied.push({ version: m.version, name: m.name });
    console.log(`[DB] Applied migration v${m.version} (${m.name})`);
  }

  return {
    fromVersion: current,
    toVersion: latest,
    applied,
    skipped: false
  };
}
