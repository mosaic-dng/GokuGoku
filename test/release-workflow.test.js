'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function readRequired(relativePath) {
  const filePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(filePath), true, `${relativePath} must exist`);
  return fs.readFileSync(filePath, 'utf8');
}

test('CI validates tests and the Windows portable build', () => {
  const workflow = readRequired('.github/workflows/ci.yml');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /node-version:\s*['"]22\.x['"]/);
  assert.match(workflow, /cache:\s*['"]npm['"]/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run pack:win/);
  assert.match(workflow, /run:\s*npm run verify:win/);
  assert.match(workflow, /-FilePath ['"]dist\/GokuGoku-win32-x64\/GokuGoku\.exe['"]/);
  assert.match(workflow, /npm run verify:shots/);
});

test('release workflow validates a stable main-branch tag and publishes one portable ZIP', () => {
  const workflow = readRequired('.github/workflows/release.yml');

  assert.match(workflow, /tags:\s*\n\s*-\s*['"]v\*['"]/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /node-version:\s*['"]22\.x['"]/);
  assert.match(workflow, /cache:\s*['"]npm['"]/);
  assert.match(workflow, /git merge-base --is-ancestor \$env:GITHUB_SHA origin\/main/);
  assert.match(workflow, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/);
  assert.match(workflow, /package\.json/);
  assert.match(workflow, /Tag version .* does not match package version/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run pack:win/);
  assert.match(workflow, /run:\s*npm run verify:win/);
  assert.match(workflow, /npm run verify:shots/);
  assert.match(workflow, /VersionInfo\.ProductVersion/);
  assert.match(workflow, /GokuGoku-v\$version-Windows-x64/);
  assert.match(workflow, /tar\.exe -a -c -f/);
  assert.match(workflow, /\$archiveSize -gt 128MB/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test('download and maintainer release documentation expose the release contract', () => {
  const readme = readRequired('README.md');
  const releasing = readRequired('docs/RELEASING.md');

  assert.match(readme, /https:\/\/github\.com\/mosaic-dng\/GokuGoku\/releases\/latest/);
  assert.equal((readme.match(/docs\/RELEASING\.md/g) || []).length, 2);
  assert.match(releasing, /GokuGoku-v1\.2\.3-Windows-x64\.zip/);
  assert.match(releasing, /git tag -a v1\.1\.0/);
  assert.match(releasing, /npm version (?:patch|minor|major)/);
  assert.match(releasing, /git push origin main --follow-tags/);
});
