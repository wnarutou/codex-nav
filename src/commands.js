'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.stdio || 'inherit',
    encoding: options.encoding || 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;
  return result;
}

function whereFirst(command) {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('where.exe', [command], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function resolveCodexInvocation() {
  if (process.platform !== 'win32') {
    return { command: 'codex', argsPrefix: [] };
  }

  const nativeExe = whereFirst('codex.exe');
  if (nativeExe) {
    return { command: nativeExe, argsPrefix: [] };
  }

  const npmShim = whereFirst('codex.cmd');
  if (npmShim) {
    const npmEntry = path.join(
      path.dirname(npmShim),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    );
    if (fs.existsSync(npmEntry)) {
      return { command: process.execPath, argsPrefix: [npmEntry] };
    }
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'codex.cmd'],
  };
}

function runCodexProcess(args, cwd, stdio = 'inherit') {
  const invocation = resolveCodexInvocation();
  return run(invocation.command, [...invocation.argsPrefix, ...args], { cwd, stdio });
}

function runCodex(args, cwd) {
  const result = runCodexProcess(args, cwd, 'inherit');
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`Codex exited with status ${result.status}`);
  }
}

function sessionCwd(session) {
  const candidates = [session.path, session.baseProjectPath, process.cwd()];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || process.cwd();
}

function resumeSession(session) {
  const cwd = sessionCwd(session);
  runCodex(['resume', session.codexSessionId, '-C', cwd, '--no-alt-screen'], cwd);
}

function archiveSession(session) {
  const result = runCodexProcess(
    ['archive', session.codexSessionId],
    sessionCwd(session),
    'inherit'
  );
  if (result.status !== 0) throw new Error(`codex archive exited with status ${result.status}`);
}

function startSession(projectPath) {
  runCodex(['-C', projectPath, '--no-alt-screen'], projectPath);
}

function gitOutput(args, cwd) {
  const result = run('git', args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }
  return String(result.stdout || '').trim();
}

function isGitRepository(projectPath) {
  try {
    return gitOutput(['rev-parse', '--is-inside-work-tree'], projectPath) === 'true';
  } catch (_) {
    return false;
  }
}

function getBranch(projectPath) {
  if (!isGitRepository(projectPath)) return '';
  try {
    return gitOutput(['branch', '--show-current'], projectPath) || '(detached)';
  } catch (_) {
    return '';
  }
}

function isDirty(projectPath) {
  if (!isGitRepository(projectPath)) return false;
  return Boolean(gitOutput(['status', '--porcelain'], projectPath));
}

function createWorktree(projectPath) {
  if (!isGitRepository(projectPath)) {
    throw new Error('This project is not a Git repository.');
  }

  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const suffix = crypto.randomBytes(2).toString('hex');
  const shortName = `${mmdd}-${suffix}`;
  const branch = `codex-${shortName}`;
  const worktreeRoot = path.join(path.dirname(projectPath), `${path.basename(projectPath)}-worktrees`);
  const worktreePath = path.join(worktreeRoot, shortName);

  fs.mkdirSync(worktreeRoot, { recursive: true });
  gitOutput(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], projectPath);

  return { branch, worktreePath, shortName };
}

function createWorkspaceDirectory(root, name, initializeGit = true) {
  const safe = String(name || '').trim();
  if (!safe || safe === '.' || safe === '..' || /[<>:"/\\|?*]/.test(safe)) {
    throw new Error('Invalid workspace directory name.');
  }

  const target = path.join(root, safe);
  if (fs.existsSync(target)) throw new Error('Directory already exists.');

  fs.mkdirSync(target, { recursive: false });
  if (initializeGit) {
    const result = run('git', ['init'], { cwd: target, stdio: 'pipe' });
    if (result.status !== 0) throw new Error('git init failed for the new workspace.');
  }
  return target;
}

module.exports = {
  resolveCodexInvocation,
  runCodexProcess,
  runCodex,
  resumeSession,
  archiveSession,
  startSession,
  gitOutput,
  isGitRepository,
  getBranch,
  isDirty,
  createWorktree,
  createWorkspaceDirectory,
};
