'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { parseSessionRow } = require('./core');

function loadHapiSessions() {
  const dbPath = path.join(os.homedir(), '.hapi', 'hapi.db');
  if (!fs.existsSync(dbPath)) return [];

  const helper = path.join(__dirname, 'hapi-reader.js');
  const result = spawnSync(process.execPath, ['--no-warnings', helper, dbPath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) return [];

  let rows = [];
  try {
    rows = JSON.parse(result.stdout || '[]');
  } catch (_) {
    return [];
  }

  return rows
    .map(parseSessionRow)
    .filter((session) => session.codexSessionId);
}

module.exports = {
  loadHapiSessions,
};
