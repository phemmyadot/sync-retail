#!/usr/bin/env node
/**
 * Builds the desktop host runtime as a Windows single-executable app and
 * stages everything the Tauri bundle needs:
 *
 *   frontend/src-tauri/binaries/sr-host-x86_64-pc-windows-msvc.exe   (Tauri sidecar)
 *   frontend/src-tauri/resources/host/
 *     pgsql/{bin,lib,share}      PostgreSQL 17 (pgAdmin GUI DLLs pruned)
 *     migrations/                Prisma migration SQL
 *     prisma/                    Prisma query engine (native addon)
 *     fonts/                     DejaVu TTFs for PDF reports
 *
 * Usage: npm -w backend run build:host
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(backend, '..');
const tauri = path.join(root, 'frontend', 'src-tauri');
const out = path.join(backend, 'build', 'host');
const resOut = path.join(tauri, 'resources', 'host');
const binOut = path.join(tauri, 'binaries');
const TRIPLE = 'x86_64-pc-windows-msvc';

if (process.platform !== 'win32') {
  console.error('build-host currently targets Windows (x64). Run it on Windows.');
  process.exit(1);
}

const step = (m) => console.log(`\n▸ ${m}`);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const copyDir = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter: filter ?? (() => true) });
// Look packages up on disk: some (e.g. @embedded-postgres/*) don't export package.json.
const pkgDir = (name) => {
  const hit = [path.join(backend, 'node_modules', name), path.join(root, 'node_modules', name)].find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!hit) throw new Error(`Package ${name} not installed`);
  return hit;
};

rm(out);
fs.mkdirSync(out, { recursive: true });

// 1. Bundle the runtime + API into one CommonJS file.
step('bundling runtime');
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('tsup', { paths: [backend] })] }));
await esbuild.build({
  entryPoints: [path.join(backend, 'src', 'host', 'runtime.ts')],
  outfile: path.join(out, 'runtime.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  // Optional native accelerators that the libraries fall back from gracefully.
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  // Inside a single-executable app, the built-in `require` only loads core
  // modules. Prisma loads its engine (.node addon) by absolute path, so give
  // the bundle a real file-system require.
  banner: { js: "var require = require('node:module').createRequire(process.execPath);" },
  define: { 'import.meta.url': 'undefined' },
});

// 2. Single executable application (Node SEA).
step('building single executable');
const seaConfig = path.join(out, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: path.join(out, 'runtime.cjs'), output: path.join(out, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: true }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const exe = path.join(out, 'sr-host.exe');
fs.copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [require.resolve('postject/dist/cli.js', { paths: [backend] }), exe, 'NODE_SEA_BLOB', path.join(out, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'],
  { stdio: 'inherit' },
);
fs.mkdirSync(binOut, { recursive: true });
fs.copyFileSync(exe, path.join(binOut, `sr-host-${TRIPLE}.exe`));

// 3. Resources.
step('staging resources');
rm(resOut);
const pgNative = path.join(pkgDir('@embedded-postgres/windows-x64'), 'native');
// pgAdmin's wxWidgets DLLs and ECPG aren't needed by initdb/pg_ctl/postgres.
const prune = /^(wx.*\.dll|testplug\.dll|libecpg.*\.dll|libpgtypes\.dll)$/i;
copyDir(pgNative, path.join(resOut, 'pgsql'), (src) => !prune.test(path.basename(src)) && path.basename(src) !== 'pg-symlinks.json');
copyDir(path.join(backend, 'prisma', 'migrations'), path.join(resOut, 'migrations'));
fs.mkdirSync(path.join(resOut, 'prisma'), { recursive: true });
const engine = path.join(root, 'node_modules', '.prisma', 'client', 'query_engine-windows.dll.node');
if (!fs.existsSync(engine)) throw new Error('Prisma engine missing — run `npm -w backend run db:generate` first');
fs.copyFileSync(engine, path.join(resOut, 'prisma', 'query_engine-windows.dll.node'));
fs.mkdirSync(path.join(resOut, 'fonts'), { recursive: true });
for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSerif-Italic.ttf']) {
  fs.copyFileSync(path.join(pkgDir('dejavu-fonts-ttf'), 'ttf', f), path.join(resOut, 'fonts', f));
}

const size = (p) => {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size;
  return n;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`\n✔ sr-host.exe ${mb(fs.statSync(exe).size)} · resources ${mb(size(resOut))}`);
