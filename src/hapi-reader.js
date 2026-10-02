'use strict';

const { DatabaseSync } = require('node:sqlite');

const dbPath = process.argv[2];
if (!dbPath) process.exit(2);

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare(
    'SELECT id, metadata, updated_at, active FROM sessions ORDER BY updated_at DESC'
  ).all();
  process.stdout.write(JSON.stringify(rows));
} finally {
  db.close();
}
