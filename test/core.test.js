'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  getWorkspaceRootsFromRunnerState,
  inferBaseProjectPath,
  parseSessionRow,
  groupSessionsByProject,
  normalizePath,
} = require('../src/core');
const { meaningfulUserText, mergeSessions } = require('../src/sessions');

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
