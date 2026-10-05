// End-to-end test through the real MCP protocol (what Claude Code / Codex do).
// Opens real terminal windows on this desktop, so run it in an interactive Windows session:
//   npm run e2e
// The output folder (shots, evidence, reports) is printed at the end for inspection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoshot-e2e-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src', 'index.js')],
  env: { ...process.env, AUTOSHOT_DIR: outDir },
  stderr: 'inherit',
});
const client = new Client({ name: 'autoshot-e2e', version: '1.0.0' });
await client.connect(transport);

const timings = [];
async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = r.content.filter((c) => c.type === 'image').length;
  const ms = Date.now() - t0;
  timings.push({ name, ms, isError: !!r.isError });
  console.log(`\n=== ${name} (${ms} ms${images ? `, ${images} image` : ''}${r.isError ? ', ERROR' : ''})\n${text}`);
  return { text, images, isError: !!r.isError };
}
function grab(re, text, what) {
  const m = re.exec(text);
  assert.ok(m, `could not find ${what} in:\n${text}`);
  return m[1];
}

const shotFiles = [];
try {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log('tools:', names.join(', '));
  assert.equal(names.length, 14);
  assert.equal((await client.listPrompts()).prompts[0].name, 'evidence_report');

  await call('list_windows', { filter: 'terminal' });

  // ---------------------------------------------------------------- Windows Terminal + PowerShell
  const open = await call('open_terminal', { host: 'wt', shell: 'powershell', title: 'AutoShot E2E', cols: 100, rows: 26, x: 80, y: 80 });
  assert.ok(!open.isError, open.text);
  const t1 = grab(/session (t\d+)/, open.text, 'session id');

  const r1 = await call('run_command', { session: t1, command: 'Write-Output "xin chào ưu tiên"; 1..3 | ForEach-Object { "line $_" }', capture: 'block', clear_before: true });
  assert.match(r1.text, /✔ finished/);
  assert.match(r1.text, /xin chào ưu tiên/);
  assert.match(r1.text, /line 3/);
  shotFiles.push(grab(/file: (.+\.png)/, r1.text, 'shot file'));

  const r2 = await call('run_command', {
    session: t1,
    command: 'Get-NetIPAddress -AddressFamily IPv4 | Select-Object -First 3 IPAddress, InterfaceAlias | Format-Table -AutoSize',
    capture: 'block_titled',
    ops: [{ op: 'highlight', preset: 'ipv4', occurrence: 'first' }],
    evidence: { caption: 'Địa chỉ IPv4 của máy', section: 'Câu 1', name: 'ipv4' },
  });
  assert.match(r2.text, /saved evidence e1/);
  shotFiles.push(grab(/file: (.+\.png)/, r2.text, 'shot file'));

  const r3 = await call('run_command', { session: t1, command: 'Start-Sleep -Seconds 2; "server listening on 8080"; Start-Sleep -Seconds 30', expect: 'listening on \\d+' });
  assert.match(r3.text, /expected text appeared/);
  await call('send_input', { session: t1, keys: ['ctrl+c'] });

  const r4 = await call('run_command', { session: t1, command: 'ping -t 127.0.0.1', timeout_ms: 3000 });
  assert.match(r4.text, /still running/);
  await call('send_input', { session: t1, keys: ['ctrl+c'], wait_ms: 1200 });
  const w = await call('wait_for', { session: t1, timeout_ms: 15000 });
  assert.match(w.text, /^done/);

  const cap = await call('capture', { session: t1, with_text: true, grid: true });
  const baseShot = grab(/shot (s\d+)/, cap.text, 'shot id');
  const ed = await call('edit_shot', {
    shot: baseShot,
    ops: [
      { op: 'crop', from_text: 'ping -t', to_text: 'Control-C' },
      { op: 'box', text: 'Packets', label: 'thống kê' },
      { op: 'redact', preset: 'ipv4' },
      { op: 'frame', margin: 20 },
    ],
    evidence: { caption: 'Ngắt lệnh ping bằng Ctrl+C', section: 'Câu 2' },
  });
  assert.ok(!ed.isError, ed.text);
  shotFiles.push(grab(/file: (.+\.png)/, ed.text, 'shot file'));
  const view = await call('view_shot', { shot: baseShot, image: false });
  assert.match(view.text, /L01/);
  await call('manage_session', { action: 'close', session: t1 });

  // ---------------------------------------------------------------- classic console + cmd
  const open2 = await call('open_terminal', { host: 'conhost', shell: 'cmd', width: 900, height: 520, x: 120, y: 120 });
  assert.ok(!open2.isError, open2.text);
  const t2 = grab(/session (t\d+)/, open2.text, 'session id');
  const r5 = await call('run_command', { session: t2, command: 'dir /b "%WINDIR%\\System32\\drivers\\etc"', capture: 'block', clear_before: true, evidence: { caption: 'Thư mục etc trên Windows', section: 'Câu 3' } });
  assert.match(r5.text, /hosts/);
  shotFiles.push(grab(/file: (.+\.png)/, r5.text, 'shot file'));
  const rs = await call('read_screen', { session: t2, max_lines: 10 });
  assert.match(rs.text, /exact console buffer/);
  await call('manage_session', { action: 'close', session: t2 });

  // ---------------------------------------------------------------- reports
  const list = await call('manage_evidence', { action: 'list' });
  assert.match(list.text, /3 evidence item/);
  assert.match((await call('build_report', { format: 'docx', title: 'Báo cáo E2E', caption_prefix: 'Hình', include_commands: true })).text, /Report written/);
  await call('build_report', { format: 'markdown', title: 'Báo cáo E2E', caption_prefix: 'Hình' });
  await call('build_report', { format: 'html', title: 'Báo cáo E2E', caption_prefix: 'Hình' });

  const tpl = path.join(outDir, 'de-bai.docx');
  const paras = ['Bài thực hành', 'Câu 1: Xem địa chỉ IP', 'Câu 2: Ngắt lệnh đang chạy', 'Câu 3: Liệt kê thư mục', '{{e3}}', 'Hết'];
  fs.writeFileSync(tpl, await Packer.toBuffer(new Document({ sections: [{ children: paras.map((t) => new Paragraph({ children: [new TextRun(t)] })) }] })));
  const ins = await call('build_report', {
    template: tpl,
    output: path.join(outDir, 'bai-lam.docx'),
    caption_prefix: 'Hình',
    placements: [
      { anchor: 'Câu 1', evidence: ['e1'] },
      { anchor: 'Câu 2', evidence: ['e2'] },
    ],
  });
  assert.match(ins.text, /inserted/);

  console.log('\nShots to inspect:\n' + shotFiles.join('\n'));
  console.log(`\nOutput folder: ${outDir}`);
  console.log('\nTimings:\n' + timings.map((r) => `${r.name.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.isError ? '  (error)' : ''}`).join('\n'));
  console.log('\nE2E PASSED');
} finally {
  await client.close();
}
