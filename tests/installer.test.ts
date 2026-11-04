import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const account = os.userInfo();
const repo = fileURLToPath(new URL('..', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/install-service.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUDO_USER: account.username },
  });

test(
  'installer generates a boot-enabled system service running as the selected account',
  {
    skip: account.uid === 0 ? 'Requires a non-root test account' : false,
  },
  () => {
    const result = run('--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`User=${account.username}\\n`));
    assert.match(result.stdout, /WantedBy=multi-user.target/);
    assert.match(result.stdout, /PORT=3000/);
    assert.ok(result.stdout.includes(path.join(account.homedir, '.local/share/excalidraws/vault')));
    assert.ok(result.stdout.includes(`WorkingDirectory=${repo}\n`));
    assert.ok(result.stdout.includes(path.join(repo, 'scripts/prepare-service.mjs')));
    assert.ok(result.stdout.includes(path.join(repo, 'dist/server/main.js')));
    assert.match(result.stdout, /ExecStartPre=/);
    assert.match(result.stdout, /TimeoutStartSec=15min/);
    assert.match(result.stdout, /RequiresMountsFor=/);
    assert.doesNotMatch(result.stdout, /\/releases\//);
    assert.doesNotMatch(result.stdout, /WantedBy=default.target/);
    const custom = run(
      '--dry-run',
      '--service-user',
      account.username,
      '--vault',
      '/tmp/custom-vault',
      '--port',
      '3456',
      '--host',
      '0.0.0.0',
      '--allowed-hosts',
      'draw.example.test',
      '--origin',
      'https://draw.example.test',
    );
    assert.equal(custom.status, 0, custom.stderr);
    assert.match(custom.stdout, /VAULT_DIR=\/tmp\/custom-vault/);
    assert.match(custom.stdout, /PORT=3456/);
    assert.match(custom.stdout, /HOST=0.0.0.0/);
    assert.match(custom.stdout, /ALLOWED_HOSTS=draw.example.test/);
    assert.match(custom.stdout, /PUBLIC_ORIGIN=https:\/\/draw.example.test/);
  },
);

test('installer rejects root execution identity and invalid configuration before installation', () => {
  assert.notEqual(run('--dry-run', '--service-user', 'root').status, 0);
  assert.notEqual(run('--dry-run', '--service-user', 'invalid\nuser').status, 0);
  assert.notEqual(run('--dry-run', '--port', '65536').status, 0);
});

test(
  'installer uses its own checkout and escapes spaces, dollar signs and systemd specifiers',
  { skip: account.uid === 0 ? 'Requires a non-root test account' : false },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'excalidraws-installer-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const checkout = path.join(root, 'Checkout with spaces $VARIABLE %h');
    const installer = path.join(checkout, 'scripts/install-service.mjs');
    await fs.mkdir(path.dirname(installer), { recursive: true });
    await fs.copyFile(path.join(repo, 'scripts/install-service.mjs'), installer);
    const result = spawnSync(process.execPath, [installer, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, SUDO_USER: account.username },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`WorkingDirectory=${checkout.replaceAll('%', '%%')}/\n`));
    assert.ok(
      result.stdout.includes(
        path
          .join(checkout, 'scripts/prepare-service.mjs')
          .replaceAll('$', '$$')
          .replaceAll('%', '%%'),
      ),
    );
    assert.equal(result.stdout.includes(repo), false);
  },
);
