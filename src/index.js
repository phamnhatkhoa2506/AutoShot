#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext, createServer } from './server.js';

async function doctor() {
  const ctx = createContext();
  const out = (s) => process.stdout.write(s + '\n');
  out(`AutoShot doctor`);
  out(`  node        ${process.version} on ${process.platform}`);
  out(`  output dir  ${ctx.cfg.outputDir}`);
  out(`  cache dir   ${ctx.cfg.cacheDir}`);
  out(`  Windows Terminal ${ctx.cfg.hasWindowsTerminal ? 'found' : 'not found (classic console will be used)'}`);
  if (process.platform !== 'win32') {
    out('  ✖ AutoShot currently supports Windows hosts only (it can still drive Linux machines over SSH).');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  try {
    await ctx.worker.start();
  } catch (e) {
    out(`  ✖ worker failed to start: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  out(`  ✔ worker started in ${Date.now() - t0} ms (native core compiled/cached)`);
  const info = await ctx.worker.call('info', {}, { timeoutMs: 60_000 });
  out(`  ✔ PowerShell ${info.ps} · DPI mode ${info.dpi} · ${info.os}`);
  for (const s of info.screens) out(`    monitor ${s.Index}: ${s.Width}×${s.Height} at (${s.X},${s.Y})${s.Primary ? ' primary' : ''}`);
  if (info.ocr?.error) out(`  ✖ OCR: ${info.ocr.error}`);
  else out(`  ✔ OCR ${info.ocr.language} (installed: ${info.ocr.available.join(', ')})`);
  const file = path.join(ctx.cfg.cacheDir, 'tmp', 'doctor.png');
  try {
    const cap = (await ctx.worker.call('capture_screen', { index: 0, out: file })).capture;
    out(`  ✔ screen capture ${cap.Width}×${cap.Height}`);
    fs.rmSync(file, { force: true });
  } catch (e) {
    out(`  ✖ screen capture failed: ${e.message}`);
  }
  ctx.worker.stop();
  out('Ready. Register it in your agent, e.g.: claude mcp add autoshot -- node "' + path.resolve(process.argv[1]) + '"');
}

async function main() {
  if (process.argv.includes('--doctor')) {
    await doctor();
    return;
  }
  if (process.argv.includes('--version')) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return;
  }
  const ctx = createContext();
  const server = createServer(ctx);
  // warm the worker up in the background so the first tool call is fast
  ctx.worker.start().catch((e) => ctx.log(`worker warm-up failed: ${e.message}`));
  const transport = new StdioServerTransport();
  const shutdown = () => {
    ctx.worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`[autoshot] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
