'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizePath(input) {
  if (!input) return '';
  return path.resolve(String(input)).replace(/[\\/]+$/, '').toLowerCase();
}

function getWorkspaceRootsFromRunnerState(state) {
  const argv = Array.isArray(state && state.startedWithArgv) ? state.startedWithArgv : [];
  const roots = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace-root' && argv[i + 1]) {
      roots.push(path.resolve(argv[i + 1]));
      i += 1;
    }
  }
  return [...new Map(roots.map((root) => [normalizePath(root), root])).values()];
}

function discoverWorkspaceRoots() {
  const statePath = path.join(os.homedir(), '.hapi', 'runner.state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const roots = getWorkspaceRootsFromRunnerState(state).filter((root) => fs.existsSync(root));
    if (roots.length) return roots;
  } catch (_) {
    // Fall through to conventional locations.
  }

  const fallback = path.join(os.homedir(), 'Documents', 'projects');
  if (fs.existsSync(fallback)) return [fallback];
  return [process.cwd()];
}

function inferBaseProjectPath(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  if (metadata.worktree && metadata.worktree.basePath) {
    return path.resolve(metadata.worktree.basePath);
  }

  const sessionPath = metadata.path ? path.resolve(metadata.path) : '';
  if (!sessionPath) return '';

  const parent = path.dirname(sessionPath);
  const parentName = path.basename(parent);
  if (parentName.endsWith('-worktrees')) {
    return path.join(path.dirname(parent), parentName.slice(0, -'-worktrees'.length));
  }

  return sessionPath;
}

function parseSessionRow(row) {
  let metadata = {};
  try {
    metadata = row && row.metadata ? JSON.parse(row.metadata) : {};
  } catch (_) {
    metadata = {};
  }

  const baseProjectPath = inferBaseProjectPath(metadata);
  const summary = metadata.summary && metadata.summary.text
    ? String(metadata.summary.text)
    : '(untitled session)';

  return {
    hapiSessionId: row && row.id ? String(row.id) : '',
    codexSessionId: metadata.codexSessionId ? String(metadata.codexSessionId) : '',
    path: metadata.path ? path.resolve(metadata.path) : '',
    baseProjectPath,
    branch: metadata.worktree && metadata.worktree.branch ? String(metadata.worktree.branch) : '',
    worktreeName: metadata.worktree && metadata.worktree.name ? String(metadata.worktree.name) : '',
    title: summary,
    updatedAt: Number(row && row.updated_at ? row.updated_at : 0),
    active: Boolean(row && row.active),
    hapiHostPid: Number.isInteger(Number(metadata.hostPid)) ? Number(metadata.hostPid) : 0,
    hapiLifecycleState: metadata.lifecycleState ? String(metadata.lifecycleState) : '',
    hapiStartedBy: metadata.startedBy ? String(metadata.startedBy) : '',
    hapiMcpUrl: metadata.hapiMcpUrl ? String(metadata.hapiMcpUrl) : '',
  };
}

function groupSessionsByProject(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    if (!session || !session.baseProjectPath) continue;
    const key = normalizePath(session.baseProjectPath);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return groups;
}

function listProjects(roots, sessions) {
  const byKey = new Map();

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith('-worktrees')) continue;
      const fullPath = path.join(root, entry.name);
      byKey.set(normalizePath(fullPath), {
        name: entry.name,
        path: fullPath,
      });
    }
  }

  for (const session of sessions) {
    if (!session.baseProjectPath) continue;
    const key = normalizePath(session.baseProjectPath);
    if (!byKey.has(key) && fs.existsSync(session.baseProjectPath)) {
      byKey.set(key, {
        name: path.basename(session.baseProjectPath),
        path: session.baseProjectPath,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  normalizePath,
  getWorkspaceRootsFromRunnerState,
  discoverWorkspaceRoots,
  inferBaseProjectPath,
  parseSessionRow,
  groupSessionsByProject,
  listProjects,
  formatDate,
};
