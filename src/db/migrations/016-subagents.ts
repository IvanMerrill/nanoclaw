import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'subagents',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN agents TEXT NOT NULL DEFAULT '{}';
    `);
  },
};
