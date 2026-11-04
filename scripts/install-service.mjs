#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
if (args.includes('--help')) {
  console.log(
    'node scripts/install-service.mjs [--port 3001] [--host 127.0.0.1] [--vault /absolute/path] [--allowed-hosts desktop.tailnet.ts.net] [--origin https://draw.example.com] [--dry-run]',
  );
  process.exit(0);
}
for (const argument of args.filter((arg) => arg.startsWith('--'))) {
  if (
    !['--port', '--host', '--vault', '--allowed-hosts', '--origin', '--dry-run'].includes(argument)
  )
    throw new Error(`Unknown option: ${argument}`);
}
const port = Number(option('--port', '3001'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const host = option('--host', '127.0.0.1');
const origin = option('--origin', '');
if (origin && (!/^https?:\/\//.test(origin) || new URL(origin).origin !== origin))
  throw new Error('Origin must be an HTTP(S) origin without a path or trailing slash');
const base = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'),
  'excalidraws',
);
const vault = path.resolve(option('--vault', path.join(base, 'vault')));
const unitDirectory = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'systemd/user',
);
const unitPath = path.join(unitDirectory, 'excalidraws.service');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const release = path.join(base, 'releases', stamp);
const quote = (value) =>
  `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
for (const value of [
  release,
  vault,
  host,
  origin,
  process.execPath,
  option('--allowed-hosts', ''),
]) {
  if (/[\r\n\x00]/.test(value))
    throw new Error('Service settings cannot contain line breaks or NUL');
}
const unit = `[Unit]
Description=Excalidraws file workspace
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${release.replaceAll('%', '%%')}
ExecStart=${quote(process.execPath).replaceAll('$', '$$')} ${quote(path.join(release, 'dist/server/main.js')).replaceAll('$', '$$')}
Environment=${quote(`HOST=${host}`)}
Environment=${quote(`PORT=${port}`)}
Environment=${quote(`VAULT_DIR=${vault}`)}
Environment=${quote(`ALLOWED_HOSTS=${option('--allowed-hosts', '')}`)}
Environment=${quote(`PUBLIC_ORIGIN=${origin}`)}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;

function command(binary, arguments_, cwd) {
  const result = spawnSync(binary, arguments_, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${binary} ${arguments_.join(' ')} failed (${result.status})`);
}
const state = (verb) =>
  spawnSync('systemctl', ['--user', verb, '--quiet', 'excalidraws.service']).status === 0;

// All validations and dependency installation happen before touching the existing unit.
await readFile(path.join(repo, 'dist/client/index.html'));
await readFile(path.join(repo, 'dist/server/main.js'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'excalidraws-unit-'));
try {
  const candidate = path.join(temporary, 'excalidraws.service');
  await writeFile(candidate, unit);
  command('systemd-analyze', ['--user', 'verify', candidate]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (args.includes('--dry-run')) {
  console.log(unit);
  process.exit(0);
}
await mkdir(release, { recursive: true });
await cp(path.join(repo, 'dist'), path.join(release, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json'])
  await cp(path.join(repo, file), path.join(release, file));
command('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-fund'], release);
await mkdir(unitDirectory, { recursive: true });
await mkdir(vault, { recursive: true, mode: 0o700 });
const previous = await readFile(unitPath, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const wasActive = state('is-active');
const wasEnabled = state('is-enabled');
const backup = path.join(base, `excalidraws.service.${stamp}.backup`);
if (previous !== null) await writeFile(backup, previous, { mode: 0o600 });
try {
  await writeFile(unitPath, unit, { mode: 0o600 });
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', 'excalidraws.service']);
  command('systemctl', ['--user', 'restart', 'excalidraws.service']);
  const checkHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const checkUrl = `http://${checkHost.includes(':') ? `[${checkHost}]` : checkHost}:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await fetch(`${checkUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = await health.json();
      const mainPid = Number(
        spawnSync(
          'systemctl',
          ['--user', 'show', 'excalidraws.service', '--property=MainPID', '--value'],
          { encoding: 'utf8' },
        ).stdout.trim(),
      );
      if (
        health.ok &&
        body.application === 'excalidraws' &&
        body.pid === mainPid &&
        state('is-active')
      ) {
        const homepage = await fetch(`${checkUrl}/`, { signal: AbortSignal.timeout(1000) });
        if (homepage.ok && (await homepage.text()).includes('Excalidraws')) {
          healthy = true;
          break;
        }
      }
    } catch {
      /* Wait briefly for systemd to launch Node. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error('Service health check failed');
} catch (error) {
  spawnSync('systemctl', ['--user', 'stop', 'excalidraws.service'], { stdio: 'inherit' });
  if (previous !== null) await writeFile(unitPath, previous, { mode: 0o600 });
  else {
    spawnSync('systemctl', ['--user', 'disable', 'excalidraws.service']);
    await rm(unitPath, { force: true });
  }
  command('systemctl', ['--user', 'daemon-reload']);
  if (!wasEnabled && previous !== null)
    spawnSync('systemctl', ['--user', 'disable', 'excalidraws.service']);
  if (wasActive) command('systemctl', ['--user', 'start', 'excalidraws.service']);
  throw error;
}
console.log(
  `Installed: http://${host}:${port}\nVault: ${vault}\nRelease: ${release}${previous !== null ? `\nPrevious unit: ${backup}` : ''}`,
);
