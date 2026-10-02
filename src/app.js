'use strict';

const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const {
  discoverWorkspaceRoots,
  groupSessionsByProject,
  listProjects,
  normalizePath,
  formatDate,
} = require('./core');
const { loadSessions } = require('./sessions');
const {
  resumeSession,
  archiveSession,
  startSession,
  getBranch,
  isDirty,
  createWorktree,
  createWorkspaceDirectory,
} = require('./commands');

function clear() {
  if (stdout.isTTY) stdout.write('\x1Bc');
}

function heading(text) {
  console.log('');
  console.log(text);
  console.log('-'.repeat(Math.max(12, text.length)));
}

async function choose(rl, prompt, max) {
  const value = (await rl.question(prompt)).trim();
  if (/^q$/i.test(value)) return { type: 'quit' };
  if (/^b$/i.test(value)) return { type: 'back' };
  const num = Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= max) {
    return { type: 'index', index: num - 1 };
  }
  return { type: 'text', value };
}

function sessionLabel(session) {
  const place = session.branch || session.worktreeName || path.basename(session.path || session.baseProjectPath);
  return `${session.title}  [${place}]  ${formatDate(session.updatedAt)}`;
}

async function sessionMenu(rl, session) {
  while (true) {
    clear();
    heading(session.title);
    console.log(`Codex session: ${session.codexSessionId}`);
    console.log(`Path: ${session.path || session.baseProjectPath}`);
    if (session.branch) console.log(`Branch: ${session.branch}`);
    console.log('');
    console.log('[R] Resume');
    console.log('[A] Archive');
    console.log('[B] Back');

    const action = (await rl.question('> ')).trim().toLowerCase();
    if (action === 'b') return;
    if (action === 'r') {
      rl.pause();
      try {
        resumeSession(session);
      } finally {
        rl.resume();
      }
      return;
    }
    if (action === 'a') {
      const confirm = (await rl.question('Archive this session? [y/N] ')).trim().toLowerCase();
      if (confirm === 'y' || confirm === 'yes') {
        archiveSession(session);
        console.log('Archived.');
        await rl.question('Press Enter to continue...');
        return;
      }
    }
  }
}

async function projectMenu(rl, project, sessions) {
  while (true) {
    clear();
    heading(project.name);
    console.log(`Path: ${project.path}`);
    const branch = getBranch(project.path);
    if (branch) console.log(`Branch: ${branch}`);
    if (isDirty(project.path)) console.log('Warning: working tree has uncommitted changes.');
    console.log('');

    sessions.forEach((session, index) => {
      console.log(`${index + 1}. ${sessionLabel(session)}`);
    });
    if (!sessions.length) console.log('(no HAPI/Codex sessions found)');

    console.log('');
    console.log('[N] New Codex session in this project');
    console.log('[W] New worktree + branch + Codex session');
    console.log('[B] Back');
    console.log('[Q] Quit');

    const choice = await choose(rl, '> ', sessions.length);
    if (choice.type === 'quit') return 'quit';
    if (choice.type === 'back') return;
    if (choice.type === 'index') {
      await sessionMenu(rl, sessions[choice.index]);
      continue;
    }

    const action = choice.value.toLowerCase();
    if (action === 'n') {
      if (isDirty(project.path)) {
        const answer = (await rl.question('Working tree is dirty. Continue in this project? [y/N] ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') continue;
      }
      rl.pause();
      try {
        startSession(project.path);
      } finally {
        rl.resume();
      }
    } else if (action === 'w') {
      const created = createWorktree(project.path);
      console.log(`Created ${created.branch} at ${created.worktreePath}`);
      rl.pause();
      try {
        startSession(created.worktreePath);
      } finally {
        rl.resume();
      }
    }
  }
}

async function runApp() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const roots = discoverWorkspaceRoots();
      const sessions = loadSessions();
      const groups = groupSessionsByProject(sessions);
      const projects = listProjects(roots, sessions);

      clear();
      heading('codex-nav');
      console.log('Workspace roots:');
      roots.forEach((root) => console.log(`  - ${root}`));
      console.log('');

      projects.forEach((project, index) => {
        const count = (groups.get(normalizePath(project.path)) || []).length;
        console.log(`${index + 1}. ${project.name}  (${count} sessions)`);
      });
      if (!projects.length) console.log('(no projects found)');

      console.log('');
      console.log('[N] New workspace directory');
      console.log('[Q] Quit');

      const choice = await choose(rl, '> ', projects.length);
      if (choice.type === 'quit') return;
      if (choice.type === 'index') {
        const project = projects[choice.index];
        const result = await projectMenu(
          rl,
          project,
          groups.get(normalizePath(project.path)) || []
        );
        if (result === 'quit') return;
        continue;
      }

      if (choice.type === 'text' && choice.value.toLowerCase() === 'n') {
        const root = roots[0];
        const name = (await rl.question(`New directory under ${root}: `)).trim();
        if (!name) continue;
        const initGit = (await rl.question('Initialize Git repository? [Y/n] ')).trim().toLowerCase();
        const target = createWorkspaceDirectory(root, name, initGit !== 'n' && initGit !== 'no');
        console.log(`Created: ${target}`);
        await rl.question('Press Enter to continue...');
      }
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  runApp,
};
