import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const account = os.userInfo();
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
    assert.doesNotMatch(result.stdout, /WantedBy=default.target/);
    const custom = run(
      '--dry-run',
      '--service-user',
      account.username,
      '--vault',
      '/tmp/custom-vault',
      '--port',
      '3456',
    );
    assert.equal(custom.status, 0, custom.stderr);
    assert.match(custom.stdout, /VAULT_DIR=\/tmp\/custom-vault/);
    assert.match(custom.stdout, /PORT=3456/);
  },
);

test('installer rejects root execution identity and invalid configuration before installation', () => {
  assert.notEqual(run('--dry-run', '--service-user', 'root').status, 0);
  assert.notEqual(run('--dry-run', '--service-user', 'invalid\nuser').status, 0);
  assert.notEqual(run('--dry-run', '--port', '65536').status, 0);
});
