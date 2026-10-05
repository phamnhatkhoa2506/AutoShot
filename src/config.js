import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' ? n : fallback;
}

// wt.exe is an App Execution Alias (a reparse point that stat() cannot follow), so use lstat.
function aliasExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function loadConfig() {
  const outputDir = path.resolve(process.env.AUTOSHOT_DIR || path.join(process.cwd(), 'autoshot-output'));
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const wtPath = path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  return {
    outputDir,
    shotsDir: path.join(outputDir, 'shots'),
    evidenceDir: path.join(outputDir, 'evidence'),
    manifestPath: path.join(outputDir, 'evidence.json'),
    cacheDir: path.resolve(process.env.AUTOSHOT_CACHE || path.join(localAppData, 'AutoShot', 'cache')),
    inlineImages: envBool('AUTOSHOT_INLINE_IMAGES', true),
    previewMax: envNum('AUTOSHOT_PREVIEW_MAX', 1920),
    restoreFocus: envBool('AUTOSHOT_RESTORE_FOCUS', true),
    defaultHost: process.env.AUTOSHOT_HOST || 'auto',
    ocrScale: envNum('AUTOSHOT_OCR_SCALE', 2),
    commandTimeoutMs: envNum('AUTOSHOT_COMMAND_TIMEOUT_MS', 45_000),
    hasWindowsTerminal: aliasExists(wtPath),
    debug: envBool('AUTOSHOT_DEBUG', false),
  };
}

export function makeLogger(cfg) {
  return (...args) => {
    if (cfg.debug) process.stderr.write(`[autoshot] ${args.join(' ')}\n`);
  };
}
