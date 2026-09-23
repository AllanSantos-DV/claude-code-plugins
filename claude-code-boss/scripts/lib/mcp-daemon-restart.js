'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { detectGpu, resolveLatestAsset } = require('./mcp-release-resolver.js');

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

function inspectWindowsProcess(pid, deps = {}) {
  const exec = deps.execFileSync || execFileSync;
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
  const alive = opts.pidAlive || ((candidate) => {
    try { process.kill(candidate, 0); return true; }
    catch (err) { return !!(err && err.code === 'EPERM'); }
  });
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
  const gpu = /-gpu\.jar$/i.test(path.basename(currentJar))
    || (!/-\d+(?:\.\d+){1,3}(?:-gpu)?\.jar$/i.test(path.basename(currentJar)) && (deps.detectGpu || detectGpu)().present);
  const asset = await resolveAsset({ gpu });
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

function spawnDetached(executable, args, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const child = spawnFn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  });
  if (!child || typeof child.unref !== 'function') throw new Error('falha ao relançar daemon Java');
  if (typeof child.once !== 'function') {
    child.unref();
    return Promise.resolve(child.pid || null);
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid || null);
    });
  });
}

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

  // Validate and promote the downloaded JAR before touching the healthy daemon.
  const launchJar = await prepare(launch.jarPath, deps.latestVersion);
  const verifiedAgain = inspect(pid);
  if (verifiedAgain.executable !== launch.executable || verifiedAgain.jarPath !== launch.jarPath) {
    throw new Error(`PID ${pid} mudou entre inspeção e restart; recusando encerrar`);
  }
  const args = [...launch.args];
  args[launch.jarIndex + 1] = launchJar;
  const kill = deps.kill || (candidate => process.kill(candidate, 'SIGTERM'));
  kill(pid);
  if (!await waitPidGone(pid, deps)) throw new Error(`daemon PID ${pid} não encerrou`);
  try {
    const newPid = await spawnDetached(launch.executable, args, deps);
    return { pid, newPid, executable: launch.executable, jarPath: launchJar, previousJarPath: launch.jarPath, previousArgs: launch.args };
  } catch (err) {
    try { await spawnDetached(launch.executable, launch.args, deps); }
    catch (rollbackErr) {
      throw new Error(`relaunch da versão nova falhou (${err.message}); rollback também falhou (${rollbackErr.message})`);
    }
    throw new Error(`relaunch da versão nova falhou; versão anterior relançada: ${err.message}`);
  }
}

async function rollbackAfterFailedUpdate(restartInfo, deps = {}) {
  if (!restartInfo || !restartInfo.executable || !Array.isArray(restartInfo.previousArgs)) {
    throw new Error('dados insuficientes para rollback do daemon');
  }
  const alive = deps.pidAlive || (pid => {
    try { process.kill(pid, 0); return true; }
    catch (err) { return !!(err && err.code === 'EPERM'); }
  });
  const kill = deps.kill || (pid => process.kill(pid, 'SIGTERM'));
  if (Number.isInteger(restartInfo.newPid) && alive(restartInfo.newPid)) {
    kill(restartInfo.newPid);
    if (!await waitPidGone(restartInfo.newPid, deps)) {
      throw new Error(`daemon novo PID ${restartInfo.newPid} não encerrou para rollback`);
    }
  }
  const rollbackPid = await spawnDetached(restartInfo.executable, restartInfo.previousArgs, deps);
  return { rollbackPid, versionJar: restartInfo.previousJarPath };
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
  spawnDetached,
  restartForBootUpdate,
  rollbackAfterFailedUpdate,
};
