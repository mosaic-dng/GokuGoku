'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_SHOTS = {
  'shot-onboarding-880.png': [480, 880],
  'shot-onboarding-720-step1.png': [480, 720],
  'shot-onboarding-720-step2.png': [480, 720],
  'shot-main.png': [480, 720],
  'shot-undo.png': [480, 720],
  'shot-main-open.png': [480, 960],
  'shot-settings-bottom.png': [480, 960],
  'shot-reminder.png': [520, 380],
};

function pngDimensions(filename) {
  const header = Buffer.alloc(24);
  const descriptor = fs.openSync(filename, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`PNG 文件不完整：${filename}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error(`不是 PNG 文件：${filename}`);
  }
  return [header.readUInt32BE(16), header.readUInt32BE(20)];
}

function verifyShots(directory) {
  for (const [name, expected] of Object.entries(EXPECTED_SHOTS)) {
    const filename = path.join(directory, name);
    if (!fs.existsSync(filename)) throw new Error(`缺少 Electron 截图：${name}`);
    const actual = pngDimensions(filename);
    if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
      throw new Error(`${name} 尺寸错误：期望 ${expected.join('x')}，实际 ${actual.join('x')}`);
    }
  }
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '.shots'));
  verifyShots(directory);
  process.stdout.write(`Electron 截图验收通过：${Object.keys(EXPECTED_SHOTS).length} 张。\n`);
}

module.exports = { EXPECTED_SHOTS, pngDimensions, verifyShots };
