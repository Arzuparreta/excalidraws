#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, mkdtemp, chown } from 'node:fs/promises';
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
    'node scripts/install-service.mjs [--service-user username] [--port 3000] [--host 127.0.0.1] [--vault /absolute/path] [--allowed-hosts desktop.tailnet.ts.net] [--origin https://draw.example.com] [--dry-run]',
  );
  process.exit(0);
}
for (const argument of args.filter((arg) => arg.startsWith('--'))) {
  if (
    ![
      '--service-user',
      '--port',
      '--host',
      '--vault',
      '--allowed-hosts',
      '--origin',
      '--dry-run',
    ].includes(argument)
  )
    throw new Error(`Unknown option: ${argument}`);
}
const serviceUser = option('--service-user', process.env.SUDO_USER ?? os.userInfo().username);
if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(serviceUser) || serviceUser === 'root')
  throw new Error('Choose an existing non-root account with --service-user');
const accountResult = spawnSync('getent', ['passwd', serviceUser], { encoding: 'utf8' });
if (accountResult.status !== 0) throw new Error(`Unknown service user: ${serviceUser}`);
const account = accountResult.stdout.trim().split(':');
const uid = Number(account[2]);
const gid = Number(account[3]);
const home = account[5];
if (!uid || !path.isAbsolute(home))
  throw new Error('Service account must be non-root with an absolute home');
if (!args.includes('--dry-run') && process.getuid() !== 0)
  throw new Error(
    'System installation requires root. Run with sudo (or pkexec) and --service-user.',
  );
const port = Number(option('--port', '3000'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const host = option('--host', '127.0.0.1');
const origin = option('--origin', '');
if (origin && (!/^https?:\/\//.test(origin) || new URL(origin).origin !== origin))
  throw new Error('Origin must be an HTTP(S) origin without a path or trailing slash');
// Keep the existing personal vault and releases when migrating from the user service.
const base = path.join(home, '.local/share/excalidraws');
const vault = path.resolve(option('--vault', path.join(base, 'vault')));
const unitDirectory = '/etc/systemd/system';
const unitPath = path.join(unitDirectory, 'excalidraws.service');
const userUnitPath = path.join(home, '.config/systemd/user/excalidraws.service');
const userEnvironment = {
  ...process.env,
  HOME: home,
  XDG_RUNTIME_DIR: `/run/user/${uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
};
const userCommand = (arguments_) =>
  spawnSync('runuser', ['-u', serviceUser, '--', 'systemctl', '--user', ...arguments_], {
    env: userEnvironment,
    encoding: 'utf8',
  });
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
User=${serviceUser}
Group=${gid}
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
WantedBy=multi-user.target
`;

function command(binary, arguments_, cwd) {
  const result = spawnSync(binary, arguments_, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${binary} ${arguments_.join(' ')} failed (${result.status})`);
}
const state = (verb) =>
  spawnSync('systemctl', [verb, '--quiet', 'excalidraws.service']).status === 0;

// All validations and dependency installation happen before touching the existing unit.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'excalidraws-unit-'));
try {
  const candidate = path.join(temporary, 'excalidraws.service');
  await writeFile(candidate, unit);
  command('systemd-analyze', ['verify', candidate]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (args.includes('--dry-run')) {
  console.log(unit);
  process.exit(0);
}
await readFile(path.join(repo, 'dist/client/index.html'));
await readFile(path.join(repo, 'dist/server/main.js'));
await mkdir(release, { recursive: true });
await chown(base, uid, gid);
await chown(path.dirname(release), uid, gid);
await cp(path.join(repo, 'dist'), path.join(release, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json'])
  await cp(path.join(repo, file), path.join(release, file));
command('chown', ['-R', `${uid}:${gid}`, release]);
command(
  'runuser',
  ['-u', serviceUser, '--', 'npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-fund'],
  release,
);
await mkdir(unitDirectory, { recursive: true });
await mkdir(vault, { recursive: true, mode: 0o700 });
await chown(vault, uid, gid);
const previous = await readFile(unitPath, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const wasActive = state('is-active');
const wasEnabled = state('is-enabled');
const backup = path.join(base, `excalidraws.service.${stamp}.backup`);
if (previous !== null) await writeFile(backup, previous, { mode: 0o600 });
const userWasActive = userCommand(['is-active', '--quiet', 'excalidraws.service']).status === 0;
const userWasEnabled = userCommand(['is-enabled', '--quiet', 'excalidraws.service']).status === 0;
const previousUserUnit = await readFile(userUnitPath, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (previousUserUnit !== null && userCommand(['show-environment']).status !== 0)
  throw new Error(
    'Cannot contact the previous user service manager. Migrate while that user is logged in.',
  );
if (previousUserUnit !== null)
  await writeFile(path.join(base, `excalidraws.user.service.${stamp}.backup`), previousUserUnit, {
    mode: 0o600,
  });
try {
  if (userWasActive || userWasEnabled) {
    const stopped = userCommand(['disable', '--now', 'excalidraws.service']);
    if (stopped.status !== 0)
      throw new Error(`Cannot stop the previous user service: ${stopped.stderr}`);
  }
  await writeFile(unitPath, unit, { mode: 0o644 });
  command('systemctl', ['daemon-reload']);
  command('systemctl', ['enable', 'excalidraws.service']);
  command('systemctl', ['restart', 'excalidraws.service']);
  const checkHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const checkUrl = `http://${checkHost.includes(':') ? `[${checkHost}]` : checkHost}:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await fetch(`${checkUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = await health.json();
      const mainPid = Number(
        spawnSync('systemctl', ['show', 'excalidraws.service', '--property=MainPID', '--value'], {
          encoding: 'utf8',
        }).stdout.trim(),
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
  spawnSync('systemctl', ['stop', 'excalidraws.service'], { stdio: 'inherit' });
  if (previous !== null) await writeFile(unitPath, previous, { mode: 0o600 });
  else {
    spawnSync('systemctl', ['disable', 'excalidraws.service']);
    await rm(unitPath, { force: true });
  }
  command('systemctl', ['daemon-reload']);
  if (!wasEnabled && previous !== null) spawnSync('systemctl', ['disable', 'excalidraws.service']);
  if (wasActive) command('systemctl', ['start', 'excalidraws.service']);
  if (userWasEnabled) userCommand(['enable', 'excalidraws.service']);
  if (userWasActive) userCommand(['start', 'excalidraws.service']);
  throw error;
}
if (previousUserUnit !== null) {
  await rm(userUnitPath);
  const reloaded = userCommand(['daemon-reload']);
  if (reloaded.status !== 0)
    console.warn('System service is healthy; reload the user manager on your next login.');
}
console.log(
  `Installed: http://${host}:${port}\nVault: ${vault}\nRelease: ${release}${previous !== null ? `\nPrevious unit: ${backup}` : ''}`,
);
