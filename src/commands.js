'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FULL_ACCESS_ARGS = Object.freeze([
  '--sandbox',
  'danger-full-access',
  '--ask-for-approval',
  'never',
]);

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

function inspectWindowsProcess(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;

  const command = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    'if ($null -ne $p) {',
    '$p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    '}',
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    }
  );

  if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) return null;

  try {
    return JSON.parse(String(result.stdout).trim());
  } catch (_) {
    return null;
  }
}

function isExpectedHapiCodexProcess(processInfo) {
  if (!processInfo || typeof processInfo !== 'object') return false;
  const name = String(processInfo.Name || processInfo.name || '').toLowerCase();
  const commandLine = String(processInfo.CommandLine || processInfo.commandLine || '');
  return name === 'hapi.exe' && /hapi\.exe"?\s+codex(?:\s|$)/i.test(commandLine);
}

function getHapiOwnership(session) {
  const pid = Number(session && session.hapiHostPid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { owned: false, pid: 0, reason: 'no-hapi-pid' };
  }

  const processInfo = inspectWindowsProcess(pid);
  if (!processInfo) {
    return { owned: false, pid, reason: 'not-running' };
  }

  if (!isExpectedHapiCodexProcess(processInfo)) {
    return { owned: false, pid, reason: 'pid-reused-or-unexpected-process', processInfo };
  }

  return { owned: true, pid, processInfo };
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function takeOverHapiSession(session) {
  if (process.platform !== 'win32') {
    throw new Error('HAPI takeover is currently supported on Windows only.');
  }

  const ownership = getHapiOwnership(session);
  if (!ownership.owned) {
    throw new Error('The HAPI owner is no longer running or could not be safely verified.');
  }

  let result = run(
    'taskkill.exe',
    ['/PID', String(ownership.pid), '/T'],
    { stdio: 'pipe' }
  );

  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!inspectWindowsProcess(ownership.pid)) {
      sleepSync(300);
      return ownership;
    }
    sleepSync(100);
  }

  result = run(
    'taskkill.exe',
    ['/PID', String(ownership.pid), '/T', '/F'],
    { stdio: 'pipe' }
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!inspectWindowsProcess(ownership.pid)) {
      sleepSync(300);
      return ownership;
    }
    sleepSync(100);
  }

  const detail = String(result.stderr || result.stdout || '').trim();
  throw new Error(
    detail || `HAPI session process ${ownership.pid} is still running after takeover.`
  );
}

function buildStartSessionArgs(projectPath) {
  return [
    ...FULL_ACCESS_ARGS,
    '-C',
    projectPath,
    '--no-alt-screen',
  ];
}

function buildResumeSessionArgs(sessionId, cwd) {
  return [
    'resume',
    sessionId,
    ...FULL_ACCESS_ARGS,
    '-C',
    cwd,
    '--no-alt-screen',
  ];
}

function resumeSession(session) {
  const cwd = sessionCwd(session);
  runCodex(buildResumeSessionArgs(session.codexSessionId, cwd), cwd);
}

function archiveSession(session) {
  const result = runCodexProcess(
    ['archive', session.codexSessionId],
    sessionCwd(session),
    'inherit'
  );
  if (result.status !== 0) throw new Error(`codex archive exited with status ${result.status}`);
}

function unarchiveSession(session) {
  const result = runCodexProcess(
    ['unarchive', session.codexSessionId],
    sessionCwd(session),
    'inherit'
  );
  if (result.status !== 0) throw new Error(`codex unarchive exited with status ${result.status}`);
}

function startSession(projectPath) {
  runCodex(buildStartSessionArgs(projectPath), projectPath);
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

function workspaceTarget(root, name) {
  const safe = String(name || '').trim();
  if (!safe || safe === '.' || safe === '..' || /[<>:"/\\|?*]/.test(safe)) {
    throw new Error('Invalid workspace directory name.');
  }
  return path.join(root, safe);
}

function inspectWorkspaceDirectory(root, name) {
  const target = workspaceTarget(root, name);
  if (!fs.existsSync(target)) {
    return { path: target, exists: false, isDirectory: false, isGitRepository: false };
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return { path: target, exists: true, isDirectory: false, isGitRepository: false };
  }

  const isDirectory = stat.isDirectory();
  return {
    path: target,
    exists: true,
    isDirectory,
    isGitRepository: isDirectory && isGitRepository(target),
  };
}

function initializeGitRepository(target) {
  if (isGitRepository(target)) return false;
  const result = run('git', ['init'], { cwd: target, stdio: 'pipe' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || 'git init failed for the workspace.');
  }
  return true;
}

function createWorkspaceDirectory(root, name, initializeGit = true) {
  const target = workspaceTarget(root, name);
  if (fs.existsSync(target)) throw new Error('Directory already exists.');

  fs.mkdirSync(target, { recursive: false });
  if (initializeGit) initializeGitRepository(target);
  return target;
}

module.exports = {
  FULL_ACCESS_ARGS,
  buildStartSessionArgs,
  buildResumeSessionArgs,
  resolveCodexInvocation,
  runCodexProcess,
  inspectWindowsProcess,
  isExpectedHapiCodexProcess,
  getHapiOwnership,
  takeOverHapiSession,
  runCodex,
  resumeSession,
  archiveSession,
  unarchiveSession,
  startSession,
  gitOutput,
  isGitRepository,
  getBranch,
  isDirty,
  createWorktree,
  inspectWorkspaceDirectory,
  initializeGitRepository,
  createWorkspaceDirectory,
};
