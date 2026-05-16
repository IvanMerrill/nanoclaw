import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations } from './index.js';

describe('migration 016 — agents column', () => {
  it('adds an "agents" TEXT column with default empty JSON object to container_configs', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(container_configs)').all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const agents = cols.find((c) => c.name === 'agents');

    expect(agents).toBeDefined();
    expect(agents!.type).toBe('TEXT');
    expect(agents!.notnull).toBe(1);
    expect(agents!.dflt_value).toBe(`'{}'`);
  });

  it('existing rows get the default {} value on migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`).run(
      'ag-test',
      'Test',
      'test',
      new Date().toISOString(),
    );
    db.prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(
      'ag-test',
      new Date().toISOString(),
    );

    const row = db.prepare('SELECT agents FROM container_configs WHERE agent_group_id = ?').get('ag-test') as {
      agents: string;
    };
    expect(row.agents).toBe('{}');
  });
});
