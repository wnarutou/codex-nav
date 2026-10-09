'use strict';

const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const {
  discoverWorkspaceRoots,
  groupSessionsByProject,
  listProjects,
  groupOtherSessions,
  normalizePath,
  formatDate,
} = require('./core');
const { loadSessions } = require('./sessions');
const {
  resumeSession,
  archiveSession,
  unarchiveSession,
  startSession,
  getBranch,
  isDirty,
  createWorktree,
  createWorkspaceDirectory,
  inspectWorkspaceDirectory,
  initializeGitRepository,
  getHapiOwnership,
  takeOverHapiSession,
} = require('./commands');

const PAGE_SIZE = 20;

function parsePageNumber(value, pageCount) {
  const page = Number(String(value || '').trim());
  if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
  return page - 1;
}

async function promptPageNumber(rl, pageCount) {
  const value = await rl.question(`Page number (1-${pageCount}): `);
  return parsePageNumber(value, pageCount);
}

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

function sessionSourceLabel(session) {
  return session && session.source === 'codex+hapi' ? 'Codex · HAPI' : 'Codex';
}

function sessionLabel(session) {
  const place = session.branch || session.worktreeName || path.basename(session.path || session.baseProjectPath);
  const archived = session.archived ? '[已归档] ' : '';
  return `${archived}${session.title}  [${sessionSourceLabel(session)}]  [${place}]  ${formatDate(session.updatedAt)}`;
}

async function sessionMenu(rl, session) {
  while (true) {
    clear();
    heading(session.title);
    console.log(`Codex session: ${session.codexSessionId}`);
    console.log(`Path: ${session.path || session.baseProjectPath}`);
    if (session.branch) console.log(`Branch: ${session.branch}`);
    console.log(`Source: ${sessionSourceLabel(session)}`);
    console.log(`Status: ${session.archived ? '已归档' : '活动'}`);
    const ownership = getHapiOwnership(session);
    if (ownership.owned) console.log(`HAPI owner: PID ${ownership.pid} (running)`);
    console.log('');
    if (!session.archived) console.log('[R] Resume');
    if (!session.archived && ownership.owned) console.log('[T] Take over from HAPI and resume');
    if (session.archived) console.log('[U] Unarchive');
    else console.log('[A] Archive');
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
    if (action === 't' && ownership.owned) {
      const confirm = (await rl.question(
        `Stop HAPI session PID ${ownership.pid} and take over? [y/N] `
      )).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') continue;

      try {
        takeOverHapiSession(session);
        console.log(`Stopped HAPI session PID ${ownership.pid}. Resuming in Codex...`);
        rl.pause();
        try {
          resumeSession(session);
        } finally {
          rl.resume();
        }
        return;
      } catch (error) {
        console.log(`Takeover failed: ${error && error.message ? error.message : error}`);
        await rl.question('Press Enter to continue...');
        continue;
      }
    }
    if (action === 'u' && session.archived) {
      const confirm = (await rl.question('Unarchive this session? [y/N] ')).trim().toLowerCase();
      if (confirm === 'y' || confirm === 'yes') {
        unarchiveSession(session);
        console.log('Unarchived.');
        await rl.question('Press Enter to continue...');
        return 'refresh';
      }
    }
    if (action === 'a') {
      const confirm = (await rl.question('Archive this session? [y/N] ')).trim().toLowerCase();
      if (confirm === 'y' || confirm === 'yes') {
        archiveSession(session);
        console.log('Archived.');
        await rl.question('Press Enter to continue...');
        return 'refresh';
      }
    }
  }
}

async function sessionListMenu(rl, title, sessions, options = {}) {
  if (!sessions.length) {
    clear();
    heading(title);
    console.log('(no Codex sessions found)');
    await rl.question('Press Enter to continue...');
    return;
  }

  let page = 0;
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));

  while (true) {
    if (page >= pageCount) page = pageCount - 1;
    clear();
    heading(`${title} (${sessions.length})`);

    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, sessions.length);
    for (let index = start; index < end; index += 1) {
      const session = sessions[index];
      console.log(`${index + 1}. ${sessionLabel(session)}`);
      if (options.showPath) {
        console.log(`   ${session.path || session.baseProjectPath || '-'}`);
      }
    }

    console.log('');
    console.log(`Page ${page + 1}/${pageCount}`);
    if (page + 1 < pageCount) console.log('[>] Next page');
    if (page > 0) console.log('[<] Previous page');
    if (pageCount > 1) console.log('[G] Go to page');
    console.log('[B] Back');
    console.log('[Q] Quit');

    const value = (await rl.question('> ')).trim();
    if (/^q$/i.test(value)) return 'quit';
    if (/^b$/i.test(value)) return;
    if ((value === '>' || /^n$/i.test(value)) && page + 1 < pageCount) {
      page += 1;
      continue;
    }
    if ((value === '<' || /^p$/i.test(value)) && page > 0) {
      page -= 1;
      continue;
    }
    if (/^g$/i.test(value) && pageCount > 1) {
      const target = await promptPageNumber(rl, pageCount);
      if (target === null) {
        console.log(`Invalid page. Enter a number from 1 to ${pageCount}.`);
        await rl.question('Press Enter to continue...');
      } else {
        page = target;
      }
      continue;
    }

    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= sessions.length) {
      const result = await sessionMenu(rl, sessions[number - 1]);
      if (result === 'refresh') return 'refresh';
    }
  }
}

async function otherCodexMenu(rl, sessions, projects) {
  const groups = groupOtherSessions(sessions, projects);
  if (!groups.length) {
    clear();
    heading('Other Codex sessions');
    console.log('(no Codex sessions outside workspace projects)');
    await rl.question('Press Enter to continue...');
    return;
  }

  let page = 0;
  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));

  while (true) {
    if (page >= pageCount) page = pageCount - 1;
    clear();
    heading(`Other Codex workspaces (${groups.length})`);

    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, groups.length);
    for (let index = start; index < end; index += 1) {
      const group = groups[index];
      console.log(`${index + 1}. ${group.name}  (${group.sessions.length} sessions)`);
      console.log(`   ${group.path}`);
    }

    console.log('');
    console.log(`Page ${page + 1}/${pageCount}`);
    if (page + 1 < pageCount) console.log('[>] Next page');
    if (page > 0) console.log('[<] Previous page');
    if (pageCount > 1) console.log('[G] Go to page');
    console.log('[B] Back');
    console.log('[Q] Quit');

    const value = (await rl.question('> ')).trim();
    if (/^q$/i.test(value)) return 'quit';
    if (/^b$/i.test(value)) return;
    if ((value === '>' || /^n$/i.test(value)) && page + 1 < pageCount) {
      page += 1;
      continue;
    }
    if ((value === '<' || /^p$/i.test(value)) && page > 0) {
      page -= 1;
      continue;
    }
    if (/^g$/i.test(value) && pageCount > 1) {
      const target = await promptPageNumber(rl, pageCount);
      if (target === null) {
        console.log(`Invalid page. Enter a number from 1 to ${pageCount}.`);
        await rl.question('Press Enter to continue...');
      } else {
        page = target;
      }
      continue;
    }

    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= groups.length) {
      const group = groups[number - 1];
      const result = await sessionListMenu(
        rl,
        group.name,
        group.sessions,
        { showPath: true }
      );
      if (result === 'quit') return 'quit';
      if (result === 'refresh') return 'refresh';
    }
  }
}

async function projectMenu(rl, project, sessions) {
  const sortedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  let page = 0;
  const pageCount = Math.max(1, Math.ceil(sortedSessions.length / PAGE_SIZE));

  while (true) {
    if (page >= pageCount) page = pageCount - 1;
    clear();
    heading(`${project.name} (${sortedSessions.length})`);
    console.log(`Path: ${project.path}`);
    const branch = getBranch(project.path);
    if (branch) console.log(`Branch: ${branch}`);
    if (isDirty(project.path)) console.log('Warning: working tree has uncommitted changes.');
    console.log('');

    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, sortedSessions.length);
    for (let index = start; index < end; index += 1) {
      console.log(`${index + 1}. ${sessionLabel(sortedSessions[index])}`);
    }
    if (!sortedSessions.length) console.log('(no Codex sessions found)');

    console.log('');
    console.log(`Page ${page + 1}/${pageCount}`);
    if (page + 1 < pageCount) console.log('[>] Next page');
    if (page > 0) console.log('[<] Previous page');
    if (pageCount > 1) console.log('[G] Go to page');
    console.log('[N] New Codex session in this project');
    console.log('[W] New worktree + branch + Codex session');
    console.log('[B] Back');
    console.log('[Q] Quit');

    const value = (await rl.question('> ')).trim();
    if (/^q$/i.test(value)) return 'quit';
    if (/^b$/i.test(value)) return;
    if ((value === '>' || /^next$/i.test(value)) && page + 1 < pageCount) {
      page += 1;
      continue;
    }
    if ((value === '<' || /^prev$/i.test(value)) && page > 0) {
      page -= 1;
      continue;
    }
    if (/^g$/i.test(value) && pageCount > 1) {
      const target = await promptPageNumber(rl, pageCount);
      if (target === null) {
        console.log(`Invalid page. Enter a number from 1 to ${pageCount}.`);
        await rl.question('Press Enter to continue...');
      } else {
        page = target;
      }
      continue;
    }

    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= sortedSessions.length) {
      const result = await sessionMenu(rl, sortedSessions[number - 1]);
      if (result === 'refresh') return 'refresh';
      continue;
    }

    const action = value.toLowerCase();
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
      const projects = listProjects(roots);
      const groups = groupSessionsByProject(sessions, projects);
      const otherGroups = groupOtherSessions(sessions, projects);
      const otherSessionCount = otherGroups.reduce((sum, group) => sum + group.sessions.length, 0);

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
      console.log(`[C] Other Codex sessions (${otherSessionCount})`);
      console.log(`[A] All Codex sessions (${sessions.length})`);
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

      if (choice.type === 'text' && choice.value.toLowerCase() === 'c') {
        const result = await otherCodexMenu(rl, sessions, projects);
        if (result === 'quit') return;
        continue;
      }

      if (choice.type === 'text' && choice.value.toLowerCase() === 'a') {
        const result = await sessionListMenu(
          rl,
          'All Codex sessions',
          sessions,
          { showPath: true }
        );
        if (result === 'quit') return;
        continue;
      }

      if (choice.type === 'text' && choice.value.toLowerCase() === 'n') {
        const root = roots[0];
        const name = (await rl.question(`New directory under ${root}: `)).trim();
        if (!name) continue;

        try {
          const existing = inspectWorkspaceDirectory(root, name);
          if (existing.exists) {
            if (!existing.isDirectory) {
              console.log(`Cannot use workspace: ${existing.path} exists but is not a directory.`);
              await rl.question('Press Enter to continue...');
              continue;
            }

            console.log(`Directory already exists: ${existing.path}`);
            if (existing.isGitRepository) console.log('Existing Git repository detected.');

            const useExisting = (await rl.question(
              'Use this existing directory as a workspace? [Y/n] '
            )).trim().toLowerCase();
            if (useExisting === 'n' || useExisting === 'no') continue;

            if (!existing.isGitRepository) {
              const initGit = (await rl.question(
                'Initialize Git repository in the existing directory? [Y/n] '
              )).trim().toLowerCase();
              if (initGit !== 'n' && initGit !== 'no') {
                initializeGitRepository(existing.path);
                console.log('Git repository initialized.');
              }
            }

            console.log(`Using existing workspace: ${existing.path}`);
            await rl.question('Press Enter to continue...');
            continue;
          }

          const initGit = (await rl.question(
            'Initialize Git repository? [Y/n] '
          )).trim().toLowerCase();
          const target = createWorkspaceDirectory(
            root,
            name,
            initGit !== 'n' && initGit !== 'no'
          );
          console.log(`Created: ${target}`);
          await rl.question('Press Enter to continue...');
        } catch (error) {
          console.log(`Workspace error: ${error && error.message ? error.message : error}`);
          await rl.question('Press Enter to continue...');
        }
      }
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  parsePageNumber,
  runApp,
};
