'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadHapiSessions } = require('./hapi');
const { inferBaseProjectPath } = require('./core');

const READ_PREFIX_BYTES = 512 * 1024;

function walkJsonlFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

function readPrefix(filePath, maxBytes = READ_PREFIX_BYTES) {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function meaningfulUserText(payload) {
  if (!payload || payload.role !== 'user' || !Array.isArray(payload.content)) return '';
  for (const item of payload.content) {
    if (!item || item.type !== 'input_text' || typeof item.text !== 'string') continue;
    const text = item.text.trim();
    if (!text) continue;
    if (text.startsWith('<recommended_plugins>')) continue;
    if (text.startsWith('<environment_context>')) continue;
    if (text.startsWith('<permissions')) continue;
    return text.replace(/\s+/g, ' ').slice(0, 100);
  }
  return '';
}

function parseCodexSessionFile(filePath, options = {}) {
  let text;
  try {
    text = readPrefix(filePath);
  } catch (_) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let meta = null;
  let title = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }

    if (!meta && record.type === 'session_meta' && record.payload) {
      meta = record;
    }

    if (!title && record.type === 'response_item' && record.payload) {
      title = meaningfulUserText(record.payload);
    }

    if (meta && title) break;
  }

  if (!meta || !meta.payload || !meta.payload.id || !meta.payload.cwd) return null;

  const metadata = {
    path: meta.payload.cwd,
    worktree: meta.payload.git && meta.payload.git.branch
      ? { branch: meta.payload.git.branch }
      : undefined,
  };
  const updatedAt = fs.statSync(filePath).mtimeMs;

  return {
    hapiSessionId: '',
    codexSessionId: String(meta.payload.id),
    path: path.resolve(meta.payload.cwd),
    baseProjectPath: inferBaseProjectPath(metadata),
    branch: meta.payload.git && meta.payload.git.branch ? String(meta.payload.git.branch) : '',
    worktreeName: '',
    title: title || `Codex session ${String(meta.payload.id).slice(0, 8)}`,
    updatedAt,
    active: true,
    source: 'codex',
    archived: Boolean(options.archived),
  };
}

function loadCodexSessions() {
  const activeRoot = path.join(os.homedir(), '.codex', 'sessions');
  const archivedRoot = path.join(os.homedir(), '.codex', 'archived_sessions');

  const active = walkJsonlFiles(activeRoot)
    .map((filePath) => parseCodexSessionFile(filePath, { archived: false }))
    .filter(Boolean);
  const archived = walkJsonlFiles(archivedRoot)
    .map((filePath) => parseCodexSessionFile(filePath, { archived: true }))
    .filter(Boolean);

  const byId = new Map();
  for (const session of [...archived, ...active]) {
    const previous = byId.get(session.codexSessionId);
    if (!previous || previous.archived || !session.archived) {
      byId.set(session.codexSessionId, session);
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeSessions(codexSessions, hapiSessions) {
  const hapiByCodexId = new Map(
    hapiSessions
      .filter((session) => session.codexSessionId)
      .map((session) => [session.codexSessionId, session])
  );

  const merged = codexSessions.map((nativeSession) => {
    const hapi = hapiByCodexId.get(nativeSession.codexSessionId);
    if (!hapi) return nativeSession;

    return {
      ...nativeSession,
      hapiSessionId: hapi.hapiSessionId,
      title: hapi.title || nativeSession.title,
      path: hapi.path || nativeSession.path,
      baseProjectPath: hapi.baseProjectPath || nativeSession.baseProjectPath,
      branch: hapi.branch || nativeSession.branch,
      worktreeName: hapi.worktreeName || nativeSession.worktreeName,
      hapiHostPid: hapi.hapiHostPid || 0,
      hapiLifecycleState: hapi.hapiLifecycleState || '',
      hapiStartedBy: hapi.hapiStartedBy || '',
      hapiMcpUrl: hapi.hapiMcpUrl || '',
      updatedAt: Math.max(nativeSession.updatedAt || 0, hapi.updatedAt || 0),
      source: 'codex+hapi',
      archived: Boolean(nativeSession.archived),
    };
  });

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

function loadSessions() {
  return mergeSessions(loadCodexSessions(), loadHapiSessions());
}

module.exports = {
  meaningfulUserText,
  parseCodexSessionFile,
  loadCodexSessions,
  mergeSessions,
  loadSessions,
};
