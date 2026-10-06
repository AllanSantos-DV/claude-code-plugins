'use strict';

const fs = require('fs');
const { pidAlive } = require('./process-lock.js');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveLatestAsset } = require('./mcp-release-resolver.js');

function registryFile(runDir) {
  return path.join(runDir || path.join(os.homedir(), '.mcp-memory', 'run'), 'daemon.json');
}

function splitWindowsCommandLine(commandLine) {
  const args = [];
  const re = /"([^"]*)"|([^\s]+)/g;
  let match;
  while ((match = re.exec(String(commandLine || ''))) !== null) args.push(match[1] !== undefined ? match[1] : match[2]);
  return args;
}

function extractJarPath(commandLine) {
  const args = splitWindowsCommandLine(commandLine);
  const jarIndex = args.findIndex(arg => String(arg).toLowerCase() === '-jar');
  return jarIndex >= 0 ? String(args[jarIndex + 1] || '') : '';
}

// Default seams call child_process directly with windowsHide forced after the
// spread (never trusted to callers): these run from console-less hooks.
// args must be an array: anything else in that slot would be read by Node as
// the options (or a callback) and the forced windowsHide ignored — fail loud.
const hiddenExecFileSync = (file, args, opts) => {
  if (!Array.isArray(args)) throw new TypeError('hiddenExecFileSync: args must be an array (options go in the 3rd argument)');
  return execFileSync(file, args, { ...opts, windowsHide: true });
};

function inspectWindowsProcess(pid, deps = {}) {
  const exec = deps.execFileSync || hiddenExecFileSync;
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`
    + 'if($p){[pscustomobject]@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}';
  const raw = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (!String(raw || '').trim()) throw new Error(`processo ${pid} não encontrado`);
  const info = JSON.parse(raw);
  const executable = String(info.ExecutablePath || '');
  if (path.basename(executable).toLowerCase() !== 'java.exe') throw new Error(`PID ${pid} não é java.exe`);
  const argv = splitWindowsCommandLine(info.CommandLine);
  if (argv.length && path.resolve(argv[0]).toLowerCase() === path.resolve(executable).toLowerCase()) argv.shift();
  const jarIndex = argv.findIndex(arg => String(arg).toLowerCase() === '-jar');
  const jarPath = extractJarPath(info.CommandLine);
  if (!/^mcp-memory-server(?:-.+)?\.jar$/i.test(path.basename(jarPath))) {
    throw new Error(`PID ${pid} não executa um JAR do mcp-memory-server`);
  }
  if (!argv.some(arg => arg === '--daemon')) throw new Error(`PID ${pid} não é o daemon do mcp-memory-server`);
  return { executable, jarPath, args: argv, jarIndex };
}

async function waitPidGone(pid, opts = {}) {
  const alive = opts.pidAlive || pidAlive;
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = opts.now || Date.now;
  const deadline = now() + (opts.timeoutMs || 5000);
  while (now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

function assertJar(file, deps = {}) {
  const io = deps.fs || fs;
  const stat = io.statSync(file);
  if (!stat.isFile() || stat.size < 1024 * 1024) throw new Error(`JAR de update inválido: ${file}`);
  const fd = io.openSync(file, 'r');
  const magic = Buffer.alloc(2);
  try { io.readSync(fd, magic, 0, 2, 0); } finally { io.closeSync(fd); }
  if (magic[0] !== 0x50 || magic[1] !== 0x4B) throw new Error(`JAR de update sem assinatura ZIP: ${file}`);
}

function sha256File(file, deps = {}) {
  if (typeof deps.sha256File === 'function') return deps.sha256File(file);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function normalizedVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

async function prepareVerifiedUpdate(currentJar, latestVersion, deps = {}) {
  const io = deps.fs || fs;
  const resolveAsset = deps.resolveLatestAsset || resolveLatestAsset;
  // The server launcher (native-java ADR-023, C-3) only runs exact mcp-memory-server-X.Y.Z.jar
  // names, so the update is always the CPU build — a "-gpu" jar would never be started.
  const asset = await resolveAsset();
  if (normalizedVersion(asset.version) !== normalizedVersion(latestVersion)) {
    throw new Error(`release resolvida ${asset.version} diverge de check_update ${latestVersion}`);
  }
  if (!asset.sha256 || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
    throw new Error(`release ${asset.version} sem SHA-256 verificável`);
  }
  if (!asset.name || path.basename(asset.name) !== asset.name || !/^mcp-memory-server-.+\.jar$/i.test(asset.name)) {
    throw new Error(`asset de update inválido: ${asset.name || '(sem nome)'}`);
  }
  const dir = path.dirname(currentJar);
  const targetJar = path.join(dir, asset.name);
  const sourceJar = io.existsSync(targetJar)
    ? targetJar
    : path.join(dir, 'mcp-memory-server-update.jar.tmp');
  if (!io.existsSync(sourceJar)) throw new Error(`JAR baixado pelo servidor não encontrado: ${sourceJar}`);
  assertJar(sourceJar, deps);
  const actualSha = await sha256File(sourceJar, deps);
  if (actualSha.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error(`SHA-256 do JAR de update diverge da release ${asset.version}`);
  }
  if (sourceJar !== targetJar) io.renameSync(sourceJar, targetJar);
  return targetJar;
}


/** Move a just-promoted jar out of the launcher's way (it picks the newest X.Y.Z). */
function setAside(jarPath, previousJarPath, deps = {}) {
  const io = deps.fs || fs;
  if (!jarPath || jarPath === previousJarPath || !io.existsSync(jarPath)) return null;
  const aside = `${jarPath}.rejected-${Date.now()}`;
  io.renameSync(jarPath, aside);
  return aside;
}

/**
 * Restart the daemon onto a downloaded update. The new jar is verified and promoted BEFORE the
 * healthy daemon is touched; then the old process is stopped and the server's own launcher
 * starts it again (native-java ADR-023: clients never start the jar — the launcher picks the
 * newest installed X.Y.Z, i.e. the promoted one). If the launcher fails, the new jar is set
 * aside and the launcher brings the previous version back.
 */
async function restartForBootUpdate(mcpConfig = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') throw new Error('restart auxiliar só é necessário/suportado no Windows');
  const readFile = deps.readFileSync || fs.readFileSync;
  const registry = JSON.parse(readFile(registryFile(mcpConfig.runDir), 'utf8'));
  const pid = Number(registry.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('daemon.json sem PID válido');
  const inspect = deps.inspectProcess || (candidate => inspectWindowsProcess(candidate, deps));
  const launch = inspect(pid);
  const prepare = deps.prepareUpdate || ((jar, version) => prepareVerifiedUpdate(jar, version, deps));
  const launcher = deps.runLauncher || (() => require('./mcp-launcher.js').runLauncher());

  // Validate and promote the downloaded JAR before touching the healthy daemon.
  const launchJar = await prepare(launch.jarPath, deps.latestVersion);
  const verifiedAgain = inspect(pid);
  if (verifiedAgain.executable !== launch.executable || verifiedAgain.jarPath !== launch.jarPath) {
    throw new Error(`PID ${pid} mudou entre inspeção e restart; recusando encerrar`);
  }
  const kill = deps.kill || (candidate => process.kill(candidate, 'SIGTERM'));
  kill(pid);
  if (!await waitPidGone(pid, deps)) throw new Error(`daemon PID ${pid} não encerrou`);
  const started = await launcher();
  if (started.ok) return { pid, newPid: started.pid, url: started.url, jarPath: launchJar, previousJarPath: launch.jarPath };
  setAside(launchJar, launch.jarPath, deps);
  const back = await launcher();
  if (!back.ok) throw new Error(`a versão nova não subiu (${started.error}); a anterior também não (${back.error})`);
  throw new Error(`a versão nova não subiu; a anterior voltou: ${started.error}`);
}

async function rollbackAfterFailedUpdate(restartInfo, deps = {}) {
  if (!restartInfo || !restartInfo.jarPath || !restartInfo.previousJarPath) {
    throw new Error('dados insuficientes para rollback do daemon');
  }
  const alive = deps.pidAlive || pidAlive;
  const kill = deps.kill || (pid => process.kill(pid, 'SIGTERM'));
  const launcher = deps.runLauncher || (() => require('./mcp-launcher.js').runLauncher());
  if (Number.isInteger(restartInfo.newPid) && alive(restartInfo.newPid)) {
    kill(restartInfo.newPid);
    if (!await waitPidGone(restartInfo.newPid, deps)) {
      throw new Error(`daemon novo PID ${restartInfo.newPid} não encerrou para rollback`);
    }
  }
  setAside(restartInfo.jarPath, restartInfo.previousJarPath, deps);
  const back = await launcher();
  if (!back.ok) throw new Error(`rollback: o inicializador não subiu a versão anterior: ${back.error}`);
  return { rollbackPid: back.pid, versionJar: restartInfo.previousJarPath };
}

module.exports = {
  registryFile,
  splitWindowsCommandLine,
  extractJarPath,
  inspectWindowsProcess,
  waitPidGone,
  assertJar,
  sha256File,
  prepareVerifiedUpdate,
  restartForBootUpdate,
  // test seams: the default child_process wrappers (force windowsHide)
  _hiddenExecFileSync: hiddenExecFileSync,
  rollbackAfterFailedUpdate,
};
