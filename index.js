#!/usr/bin/env node
/**
 * xgodo CLI — Sync local project files with xgodo.com online IDE
 *
 * Commands:
 *   xgodo push -m "message"   Push local changes to xgodo
 *   xgodo pull                 Download remote files to local
 *   xgodo status               Show diff between local and remote
 *   xgodo config               Set up project config
 *   xgodo clone                Download entire project from xgodo
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─── Config ───────────────────────────────────────────────

const CONFIG_FILE = '.xgodo.json';
const GLOBAL_CONFIG = path.join(process.env.HOME || '~', '.xgodo.json');

function findConfig() {
  // Check cwd first, then global
  let dir = process.cwd();
  while (dir !== '/') {
    const configPath = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync(GLOBAL_CONFIG)) return JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
  return null;
}

function getConfig() {
  const config = findConfig();
  if (!config) {
    console.error('❌ No .xgodo.json found. Run `xgodo config` first.');
    process.exit(1);
  }
  // CLI overrides
  const projectIdFlag = process.argv.indexOf('-p');
  if (projectIdFlag >= 0 && projectIdFlag + 1 < process.argv.length) {
    config.projectId = process.argv[projectIdFlag + 1];
  }
  if (!config.token) {
    console.error('❌ No auth token in config. Get your bearer token from xgodo.com (DevTools → Network → Authorization header) and run `xgodo config`.');
    process.exit(1);
  }
  if (!config.projectId) {
    console.error('❌ No projectId in config. Use `-p <id>` or set it via `xgodo config`.');
    process.exit(1);
  }
  return config;
}

// ─── API Client ────────────────────────────────────────────

function apiRequest(method, config, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://xgodo.com/server/api/v1/automation-project/${config.projectId}${endpoint}`);
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`API ${res.statusCode}: ${json.message || data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error(`API ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Core API Functions ────────────────────────────────────

async function listFiles(config) {
  const res = await apiRequest('GET', config, '/files');
  const entries = res.files || [];
  // Return only actual files (not directories), skip compiled .js pairs
  return entries.filter(e => e.type === 'file');
}

async function getFile(config, filePath) {
  const res = await apiRequest('GET', config, `/file?path=${encodeURIComponent(filePath)}`);
  return res;
}

async function saveFile(config, filePath, content) {
  const res = await apiRequest('PUT', config, '/file', { path: filePath, content });
  return res;
}

async function deleteFile(config, filePath) {
  const res = await apiRequest('DELETE', config, `/file?path=${encodeURIComponent(filePath)}`);
  return res;
}

async function gitStatus(config) {
  const res = await apiRequest('GET', config, '/git/status');
  return res;
}

async function gitCommit(config, message) {
  const res = await apiRequest('POST', config, '/git/commit', { message });
  return res;
}

// ─── Local File Helpers ────────────────────────────────────

function getSourceDir(config) {
  const src = config.source || 'src';
  return path.resolve(process.cwd(), src);
}

const DEFAULT_IGNORE = [
  '.git', 'node_modules', '.gitignore',
  '.xgodo.json', '.xgodoignore', 'package-lock.json',
  'AGENTS.md', 'global.d.ts', '*.d.ts',
];

function loadIgnorePatterns(config) {
  const patterns = [...DEFAULT_IGNORE];
  if (config.ignore) patterns.push(...config.ignore);
  // Load .xgodoignore if exists
  const ignoreFile = path.join(process.cwd(), '.xgodoignore');
  if (fs.existsSync(ignoreFile)) {
    patterns.push(...fs.readFileSync(ignoreFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  }
  return patterns;
}

function shouldIgnore(filePath, patterns) {
  return patterns.some(p => {
    // Glob: *.ext matches any file with that extension anywhere
    if (p.startsWith('*.')) {
      return filePath.endsWith(p.slice(1)) || path.basename(filePath).endsWith(p.slice(1));
    }
    if (p.endsWith('/')) return filePath.startsWith(p);
    return filePath === p || filePath.startsWith(p + '/') || path.basename(filePath) === p;
  });
}

function getLocalFiles(config) {
  const srcDir = getSourceDir(config);
  if (!fs.existsSync(srcDir)) return [];

  const ignore = loadIgnorePatterns(config);
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(srcDir, fullPath);
      if (shouldIgnore(relPath, ignore)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(relPath);
      }
    }
  }
  walk(srcDir);
  return files;
}

function readLocalFile(config, filePath) {
  const srcDir = getSourceDir(config);
  const fullPath = path.join(srcDir, filePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

// ─── Commands ──────────────────────────────────────────────

async function cmdPush(config, message, flags) {
  if (!message) {
    console.error('❌ Commit message required. Use: xgodo push -m "your message"');
    process.exit(1);
  }

  const noDelete = flags.includes('--no-delete');
  const force = flags.includes('--force') || flags.includes('-f');
  const dryRun = flags.includes('--dry-run');

  const localFiles = getLocalFiles(config);
  const remoteFilesRaw = await listFiles(config);
  const remoteFiles = remoteFilesRaw.filter(f => f.type === 'file' && !f.isPairedJs).map(f => f.path);
  const pairedJsFiles = remoteFilesRaw.filter(f => f.isPairedJs).map(f => f.path);

  // Calculate what will be deleted
  const toDelete = noDelete ? [] : remoteFiles.filter(f => !localFiles.includes(f) && !pairedJsFiles.includes(f));
  const toUpload = localFiles;

  console.log(`📁 Local: ${localFiles.length} files | Remote: ${remoteFiles.length} files`);

  if (dryRun) {
    console.log(`\n🔍 DRY RUN — no changes will be made\n`);
    console.log(`  ⬆ Upload: ${toUpload.length} files`);
    if (toDelete.length > 0) console.log(`  🗑 Delete: ${toDelete.length} files`);
    if (toUpload.length === 0 && toDelete.length === 0) console.log('  ✨ Nothing to do.');
    return;
  }

  // Safety: warn if deleting many files
  if (toDelete.length > 5 && !force) {
    console.log(`\n⚠️  About to DELETE ${toDelete.length} remote files!`);
    toDelete.slice(0, 5).forEach(f => console.log(`     - ${f}`));
    if (toDelete.length > 5) console.log(`     ... and ${toDelete.length - 5} more`);
    console.log(`\n   Use --force to confirm, or --no-delete to skip deletions.`);
    process.exit(1);
  }

  console.log(`  ⬆ Uploading: ${toUpload.length} | 🗑 Deleting: ${toDelete.length}`);

  let uploaded = 0;
  let deleted = 0;

  for (const file of toUpload) {
    const content = readLocalFile(config, file);
    if (content === null) continue;
    process.stdout.write(`  ⬆ ${file}`);
    try {
      const res = await saveFile(config, file, content);
      console.log(res.compiled ? ' ✅ (compiled)' : ' ✅');
      uploaded++;
    } catch (e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  for (const rFile of toDelete) {
    process.stdout.write(`  🗑 ${rFile}`);
    try {
      await deleteFile(config, rFile);
      console.log(' ✅');
      deleted++;
    } catch (e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  // Commit
  if (uploaded > 0 || deleted > 0) {
    process.stdout.write(`\n📝 Committing: "${message}"`);
    try {
      const commit = await gitCommit(config, message);
      console.log(` ✅ (${commit.commit.hash.substring(0, 8)})`);
    } catch (e) {
      console.log(` ❌ ${e.message}`);
    }
  } else {
    console.log('\n✨ Nothing to commit — up to date.');
  }

  console.log(`\nDone: ${uploaded} uploaded, ${deleted} deleted.`);
}

async function cmdPull(config) {
  const files = await listFiles(config);
  const tsFiles = files.filter(f => f.type === 'file' && !f.isPairedJs);
  const srcDir = getSourceDir(config);

  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  console.log(`📥 Pulling ${tsFiles.length} files from xgodo...`);

  for (const file of tsFiles) {
    process.stdout.write(`  ⬇ ${file.path}`);
    try {
      const res = await getFile(config, file.path);
      const fullPath = path.join(srcDir, file.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, res.content, 'utf8');
      console.log(' ✅');
    } catch (e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  console.log(`\nDone. Files saved to ${srcDir}/`);
}

async function cmdStatus(config) {
  const localFiles = getLocalFiles(config);
  const remoteFilesRaw = await listFiles(config);
  const remoteFiles = remoteFilesRaw.filter(f => f.type === 'file' && !f.isPairedJs).map(f => f.path);

  console.log('🔍 Comparing local vs remote...\n');

  // New locally (not on remote)
  const newLocal = localFiles.filter(f => !remoteFiles.includes(f));
  // Modified (content differs)
  const modified = [];
  for (const file of localFiles.filter(f => remoteFiles.includes(f))) {
    const localContent = readLocalFile(config, file);
    try {
      const remote = await getFile(config, file);
      if (localContent !== remote.content) {
        modified.push(file);
      }
    } catch (e) {
      modified.push(file);
    }
  }
  // Deleted locally (still on remote)
  const deleted = remoteFiles.filter(f => !localFiles.includes(f));

  if (newLocal.length > 0) {
    console.log('  🆕 New files (will be created):');
    newLocal.forEach(f => console.log(`      ${f}`));
  }
  if (modified.length > 0) {
    console.log('  ✏️  Modified (will be updated):');
    modified.forEach(f => console.log(`      ${f}`));
  }
  if (deleted.length > 0) {
    console.log('  🗑  Deleted locally (will be removed):');
    deleted.forEach(f => console.log(`      ${f}`));
  }
  if (newLocal.length === 0 && modified.length === 0 && deleted.length === 0) {
    console.log('  ✅ Up to date. No changes.');
  }

  // Also show remote git status
  try {
    const status = await gitStatus(config);
    if (status.hasChanges) {
      console.log('\n  🌐 Remote has uncommitted changes:');
      status.changes.forEach(c => console.log(`      [${c.status}] ${c.path}`));
    }
  } catch (e) {}
}

async function cmdConfig() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('🔧 xgodo configuration\n');
  console.log('Get your bearer token: Open xgodo.com in your browser, inspect the page source,');
  console.log('search for "token" in the __NEXT_DATA__ script tag or network requests.\n');

  const token = await ask('Bearer token: ');
  const projectId = await ask('Project ID (from URL ?id=...): ');
  const source = await ask('Source directory [src]: ') || 'src';
  const saveGlobal = await ask('Save globally (~/.xgodo.json)? [Y/n]: ');

  const config = { token: token.trim(), projectId: projectId.trim(), source: source.trim() || 'src' };

  const savePath = (saveGlobal.toLowerCase() === 'n') 
    ? path.join(process.cwd(), CONFIG_FILE)
    : GLOBAL_CONFIG;

  fs.writeFileSync(savePath, JSON.stringify(config, null, 2));
  console.log(`\n✅ Config saved to ${savePath}`);
  rl.close();
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🦅 xgodo CLI — Sync local files with xgodo.com IDE

Usage:
  xgodo config              Set up project config (token, project ID)
  xgodo push -m "message"   Push local files to xgodo and commit
            --dry-run       Show what would change without doing it
            --no-delete     Skip deleting remote files
            --force, -f     Skip safety confirmation for bulk deletes
  xgodo pull [-p <id>]      Download remote files to local
  xgodo status [-p <id>]    Show diff between local and remote
  xgodo help                Show this help

  -p <projectId>            Target a specific xgodo project (overrides .xgodo.json)

Config file: .xgodo.json (per-project) or ~/.xgodo.json (global)
  {
    "token": "your-bearer-token",
    "projectId": "69ff69448c276d3bba06c460",
    "source": "src"
  }
`);
    return;
  }

  if (command === 'config') {
    await cmdConfig();
    return;
  }

  const config = getConfig();

  switch (command) {
    case 'push': {
      // Parse -m flag
      const mIndex = args.indexOf('-m');
      const messageIndex = args.indexOf('--message');
      let message = null;
      if (mIndex >= 0 && mIndex + 1 < args.length) message = args[mIndex + 1];
      if (messageIndex >= 0 && messageIndex + 1 < args.length) message = args[messageIndex + 1];
      const flags = args.filter(a => a.startsWith('--') && a !== '--message' || a === '-f');
      await cmdPush(config, message, flags);
      break;
    }
    case 'pull':
      await cmdPull(config);
      break;
    case 'status':
      await cmdStatus(config);
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      console.error('   Try: xgodo push | pull | status | config | help');
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`\n💥 Error: ${e.message}`);
  process.exit(1);
});
