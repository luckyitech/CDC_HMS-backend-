#!/usr/bin/env node
'use strict';
// =====================================================================
// Builds dist/CDC-Scanner-Relay-Setup.exe — a normal Windows installer.
//
// Runs on Linux, macOS or Windows; needs Node 18+, npm and NSIS 3
// (`makensis` on PATH: apt install nsis · brew install makensis ·
// nsis.sourceforge.io on Windows). The Windows Node runtime comes from the
// `node-win-x64` npm package (the official node.exe, pinned exactly), so no
// Windows machine is needed to build.
//
//   node build-installer.js
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const NODE_WIN = 'node-win-x64@22.22.3';   // pinned: the exact node.exe shipped
const here = __dirname;
const build = path.join(here, 'build');
const payload = path.join(build, 'payload');
const dist = path.join(here, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(payload, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. node.exe from the pinned npm package
console.log(`==> Fetching ${NODE_WIN}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-win-'));
const tgz = execFileSync('npm', ['pack', NODE_WIN, '--pack-destination', tmp, '--silent'], { encoding: 'utf8' }).trim().split('\n').pop();
sh('tar', ['xzf', path.join(tmp, tgz), '-C', tmp]);
const nodeExe = path.join(tmp, 'package', 'bin', 'node.exe');
if (!fs.existsSync(nodeExe)) throw new Error('node.exe not found in the package');
fs.copyFileSync(nodeExe, path.join(payload, 'node.exe'));
const lic = ['LICENSE', 'LICENSE.txt'].map((f) => path.join(tmp, 'package', f)).find(fs.existsSync);
fs.writeFileSync(path.join(payload, 'LICENSE-node.txt'), lic ? fs.readFileSync(lic) : 'Node.js — MIT licence, https://nodejs.org/');

// 2. the relay
for (const f of ['relay.js', 'k40.js', 'README.md']) fs.copyFileSync(path.join(here, f), path.join(payload, f));

// 3. the installer
console.log('==> makensis');
const makensis = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
sh(makensis, ['-V2', `-DVERSION=${version}`, 'installer.nsi'], { cwd: path.join(here, 'installer') });
const out = path.join(dist, 'CDC-Scanner-Relay-Setup.exe');
console.log(`==> Built ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
fs.rmSync(tmp, { recursive: true, force: true });
