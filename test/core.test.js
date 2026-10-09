'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  getWorkspaceRootsFromRunnerState,
  inferBaseProjectPath,
  parseSessionRow,
  groupSessionsByProject,
  normalizePath,
  listProjects,
  groupOtherSessions,
  findProjectForSession,
} = require('../src/core');
const { meaningfulUserText, mergeSessions, parseCodexSessionFile } = require('../src/sessions');
const { isExpectedHapiCodexProcess, inspectWorkspaceDirectory, createWorkspaceDirectory } = require('../src/commands');

test('extracts repeated workspace roots from HAPI runner argv', () => {
  const state = {
    startedWithArgv: [
      'runner',
      'start-sync',
      '--workspace-root',
      'C:\\Users\\me\\projects',
      '--workspace-root',
      'D:\\work',
    ],
  };

  const roots = getWorkspaceRootsFromRunnerState(state);
  assert.equal(roots.length, 2);
  assert.equal(roots[0], path.resolve('C:\\Users\\me\\projects'));
  assert.equal(roots[1], path.resolve('D:\\work'));
});

test('prefers explicit worktree basePath', () => {
  const metadata = {
    path: 'C:\\projects\\demo-worktrees\\1003-abcd',
    worktree: {
      basePath: 'C:\\projects\\demo',
    },
  };

  assert.equal(
    normalizePath(inferBaseProjectPath(metadata)),
    normalizePath('C:\\projects\\demo')
  );
});

test('infers base project from -worktrees convention', () => {
  const metadata = {
    path: 'C:\\projects\\demo-worktrees\\1003-abcd',
  };

  assert.equal(
    normalizePath(inferBaseProjectPath(metadata)),
    normalizePath('C:\\projects\\demo')
  );
});

test('parses HAPI session metadata and groups newest first', () => {
  const older = parseSessionRow({
    id: 'h1',
    updated_at: 100,
    active: 0,
    metadata: JSON.stringify({
      path: 'C:\\projects\\demo',
      codexSessionId: 'c1',
      summary: { text: 'old' },
    }),
  });
  const newer = parseSessionRow({
    id: 'h2',
    updated_at: 200,
    active: 0,
    metadata: JSON.stringify({
      path: 'C:\\projects\\demo',
      codexSessionId: 'c2',
      summary: { text: 'new' },
    }),
  });

  const grouped = groupSessionsByProject([older, newer]);
  const sessions = grouped.get(normalizePath('C:\\projects\\demo'));
  assert.equal(sessions[0].title, 'new');
  assert.equal(sessions[1].title, 'old');
});

test('parses HAPI process ownership metadata', () => {
  const session = parseSessionRow({
    id: 'h-owner',
    updated_at: 300,
    active: 0,
    metadata: JSON.stringify({
      path: 'C:\\projects\\demo',
      codexSessionId: 'c-owner',
      hostPid: 5128,
      lifecycleState: 'running',
      startedBy: 'runner',
      hapiMcpUrl: 'http://127.0.0.1:64720/',
    }),
  });

  assert.equal(session.hapiHostPid, 5128);
  assert.equal(session.hapiLifecycleState, 'running');
  assert.equal(session.hapiStartedBy, 'runner');
});

test('recognizes only HAPI Codex process command lines as takeover targets', () => {
  assert.equal(
    isExpectedHapiCodexProcess({
      Name: 'hapi.exe',
      CommandLine: 'C:\\tools\\hapi.exe codex --started-by runner',
    }),
    true
  );
  assert.equal(
    isExpectedHapiCodexProcess({
      Name: 'hapi.exe',
      CommandLine: 'C:\\tools\\hapi.exe runner start',
    }),
    false
  );
  assert.equal(
    isExpectedHapiCodexProcess({
      Name: 'notepad.exe',
      CommandLine: 'notepad.exe codex',
    }),
    false
  );
});


test('ignores injected context when choosing a native Codex session title', () => {
  assert.equal(
    meaningfulUserText({
      role: 'user',
      content: [
        { type: 'input_text', text: '<environment_context>ignored</environment_context>' },
        { type: 'input_text', text: 'Fix the retry logic in the sync worker' },
      ],
    }),
    'Fix the retry logic in the sync worker'
  );
});

test('HAPI metadata enriches native Codex sessions without duplicating them', () => {
  const nativeSession = {
    codexSessionId: 'c1',
    title: 'native title',
    path: 'C:\\projects\\demo-worktrees\\1003-abcd',
    baseProjectPath: 'C:\\projects\\demo',
    branch: 'codex-1003-abcd',
    updatedAt: 200,
  };
  const hapiSession = {
    hapiSessionId: 'h1',
    codexSessionId: 'c1',
    title: 'HAPI summary',
    path: nativeSession.path,
    baseProjectPath: nativeSession.baseProjectPath,
    branch: 'hapi-1003-abcd',
    worktreeName: '1003-abcd',
    updatedAt: 150,
  };

  const merged = mergeSessions([nativeSession], [hapiSession]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'HAPI summary');
  assert.equal(merged[0].branch, 'hapi-1003-abcd');
  assert.equal(merged[0].hapiSessionId, 'h1');
  assert.equal(merged[0].hapiHostPid || 0, 0);
});

test('HAPI-only rows do not resurrect archived Codex sessions', () => {
  const merged = mergeSessions([], [{
    hapiSessionId: 'h-old',
    codexSessionId: 'archived-codex-id',
    title: 'archived',
    path: 'C:\\projects\\demo',
    baseProjectPath: 'C:\\projects\\demo',
    updatedAt: 100,
  }]);

  assert.deepEqual(merged, []);
});

test('archived Codex session files are marked archived', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nav-archive-'));
  try {
    const filePath = path.join(root, 'rollout-test.jsonl');
    const records = [
      {
        timestamp: '2026-10-01T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'archived-1',
          cwd: 'C:\\projects\\demo',
          git: { branch: 'main' },
        },
      },
      {
        timestamp: '2026-10-01T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Archived session title' }],
        },
      },
    ];
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'));

    const session = parseCodexSessionFile(filePath, { archived: true });
    assert.equal(session.codexSessionId, 'archived-1');
    assert.equal(session.archived, true);
    assert.equal(session.title, 'Archived session title');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('active and archived sessions are mixed strictly by update time descending', () => {
  const sessions = [
    { title: 'older active', baseProjectPath: 'C:\\projects\\demo', updatedAt: 100, archived: false },
    { title: 'new archived', baseProjectPath: 'C:\\projects\\demo', updatedAt: 300, archived: true },
    { title: 'middle active', baseProjectPath: 'C:\\projects\\demo', updatedAt: 200, archived: false },
  ];

  const grouped = groupSessionsByProject(sessions);
  const items = grouped.get(normalizePath('C:\\projects\\demo'));
  assert.deepEqual(items.map((item) => item.title), [
    'new archived',
    'middle active',
    'older active',
  ]);
});

test('workspace project list only contains real directories under configured roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nav-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nav-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'real-project'));
    fs.mkdirSync(path.join(root, 'real-project-worktrees'));
    fs.mkdirSync(path.join(outside, 'bang'));

    const projects = listProjects([root], [{
      baseProjectPath: path.join(outside, 'bang'),
      updatedAt: 10,
    }]);

    assert.deepEqual(projects.map((project) => project.name), ['real-project']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('Codex sessions outside workspace projects are grouped separately', () => {
  const projects = [
    { name: 'joinquant', path: 'C:\\projects\\joinquant' },
  ];
  const sessions = [
    {
      title: 'workspace',
      baseProjectPath: 'C:\\projects\\joinquant',
      updatedAt: 200,
    },
    {
      title: 'old bang',
      baseProjectPath: 'C:\\Users\\me\\Documents\\Codex\\2026-08-23\\bang',
      updatedAt: 300,
    },
    {
      title: 'older bang',
      baseProjectPath: 'C:\\Users\\me\\Documents\\Codex\\2026-08-23\\bang',
      updatedAt: 100,
    },
  ];

  const groups = groupOtherSessions(sessions, projects);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'bang');
  assert.equal(groups[0].sessions.length, 2);
  assert.equal(groups[0].sessions[0].title, 'old bang');
});

test('sessions nested inside a workspace project stay attached to that project', () => {
  const projects = [
    { name: 'gitrieve', path: 'C:\\projects\\gitrieve' },
  ];
  const nestedSession = {
    title: 'nested worktree',
    baseProjectPath: 'C:\\projects\\gitrieve\\.claude\\worktrees\\abc123',
    updatedAt: 400,
  };

  const project = findProjectForSession(nestedSession, projects);
  assert.equal(project.name, 'gitrieve');

  const grouped = groupSessionsByProject([nestedSession], projects);
  assert.equal(grouped.get(normalizePath(projects[0].path)).length, 1);
  assert.equal(groupOtherSessions([nestedSession], projects).length, 0);
});

test('existing workspace directory is detected instead of treated as a fatal create error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nav-'));
  try {
    const existing = path.join(root, 'existing-project');
    fs.mkdirSync(existing);

    const info = inspectWorkspaceDirectory(root, 'existing-project');
    assert.equal(info.path, existing);
    assert.equal(info.exists, true);
    assert.equal(info.isDirectory, true);
    assert.equal(info.isGitRepository, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new workspace directory can still be created normally', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nav-'));
  try {
    const target = createWorkspaceDirectory(root, 'new-project', false);
    assert.equal(target, path.join(root, 'new-project'));
    assert.equal(fs.statSync(target).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
