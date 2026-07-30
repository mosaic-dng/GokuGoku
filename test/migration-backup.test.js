'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureMigrationBackup } = require('../lib/migration-backup.js');

function withTempDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gokugoku-backup-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('migration backup preserves the exact pre-migration bytes', () => {
  withTempDirectory((root) => {
    const source = path.join(root, 'gokugoku-data.json');
    const target = path.join(root, 'gokugoku-data.v2.bak.json');
    fs.writeFileSync(source, '{"schemaVersion":2,"workStart":9.5}');

    const backup = ensureMigrationBackup(source, target);

    assert.equal(backup, target);
    assert.deepEqual(fs.readFileSync(backup), fs.readFileSync(source));
  });
});

test('a stale backup is preserved and the current source gets a numbered backup', () => {
  withTempDirectory((root) => {
    const source = path.join(root, 'gokugoku-data.json');
    const target = path.join(root, 'gokugoku-data.v1.bak.json');
    fs.writeFileSync(source, 'current legacy bytes');
    fs.writeFileSync(target, 'older legacy bytes');

    const backup = ensureMigrationBackup(source, target);

    assert.equal(backup, `${target}.1`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'older legacy bytes');
    assert.equal(fs.readFileSync(backup, 'utf8'), 'current legacy bytes');
  });
});

test('an existing directory at the required backup path blocks migration persistence', () => {
  withTempDirectory((root) => {
    const source = path.join(root, 'gokugoku-data.json');
    const target = path.join(root, 'gokugoku-data.v2.bak.json');
    fs.writeFileSync(source, 'legacy bytes');
    fs.mkdirSync(target);

    assert.throws(
      () => ensureMigrationBackup(source, target),
      /备份路径不是文件/,
    );
  });
});
