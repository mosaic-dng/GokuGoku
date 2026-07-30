'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function readExistingBackup(candidate, sourceBytes) {
  if (!fs.existsSync(candidate)) return null;
  if (!fs.statSync(candidate).isFile()) {
    throw new Error(`备份路径不是文件：${candidate}`);
  }
  return fs.readFileSync(candidate).equals(sourceBytes);
}

function ensureMigrationBackup(sourcePath, preferredPath) {
  const sourceBytes = fs.readFileSync(sourcePath);
  let candidate = preferredPath;
  let suffix = 0;

  while (fs.existsSync(candidate)) {
    if (readExistingBackup(candidate, sourceBytes)) return candidate;
    suffix += 1;
    candidate = `${preferredPath}.${suffix}`;
  }

  const temporary = `${candidate}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, sourceBytes, { flag: 'wx' });
    fs.renameSync(temporary, candidate);
    if (!readExistingBackup(candidate, sourceBytes)) {
      throw new Error(`迁移备份校验失败：${candidate}`);
    }
    return candidate;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

module.exports = { ensureMigrationBackup };
