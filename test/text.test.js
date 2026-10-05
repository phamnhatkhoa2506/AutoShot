import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScreen, detectAwaiting, findCommandLine, findText, isPromptLine, slug, splitPrompt } from '../src/text.js';

test('prompt detection across shells', () => {
  for (const p of ['PS C:\\Users\\khoap>', 'C:\\Windows\\System32>', 'student@lab01:~$', 'root@web-01:/etc/nginx#', '[user@centos ~]$', 'bash-5.1$', 'Router#', 'Switch(config)#', '(venv) dev@box:~/app$', '>>>', 'mysql>']) {
    assert.ok(isPromptLine(p), `should be prompt: ${p}`);
  }
  for (const p of ['Reply from 127.0.0.1: bytes=32 time<1ms TTL=128', 'total 48', '<div>', 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500', 'PS C:\\> whoami']) {
    assert.ok(!isPromptLine(p), `should not be prompt: ${p}`);
  }
  assert.ok(isPromptLine('myhost> ', /^myhost> ?$/));
});

test('splitPrompt separates prompt and command', () => {
  assert.deepEqual(splitPrompt('PS C:\\Users\\khoap> whoami'), { prompt: 'PS C:\\Users\\khoap>', rest: 'whoami' });
  assert.deepEqual(splitPrompt('student@lab:~$ ip a'), { prompt: 'student@lab:~$', rest: 'ip a' });
  assert.equal(splitPrompt('plain output line'), null);
});

test('findCommandLine: exact, last occurrence, OCR noise and wrapping', () => {
  const lines = ['PS C:\\> whoami', 'ghibli\\khoap', 'PS C:\\> whoami', 'ghibli\\khoap', 'PS C:\\>'];
  assert.equal(findCommandLine(lines, 'whoami'), 2);
  assert.equal(findCommandLine(['PS C: whoarni; Write—Output "hi"', 'hi'], 'whoami; Write-Output "hi"'), 0);
  const wrapped = ['PS C:\\> Get-ChildItem -Path C:\\Windows\\System32 -Filter *.dll -Rec', 'urse | Measure-Object', 'Count : 3000', 'PS C:\\>'];
  assert.equal(findCommandLine(wrapped, 'Get-ChildItem -Path C:\\Windows\\System32 -Filter *.dll -Recurse | Measure-Object'), 0);
  assert.equal(findCommandLine(['nothing here'], 'ipconfig'), -1);
});

test('analyzeScreen: done / running / awaiting / expect', () => {
  const done = analyzeScreen(['PS C:\\> ipconfig', '', 'Windows IP Configuration', '   IPv4 Address. . . : 10.0.0.5', '', 'PS C:\\>'], { command: 'ipconfig' });
  assert.equal(done.state, 'done');
  assert.deepEqual(done.output, ['Windows IP Configuration', '   IPv4 Address. . . : 10.0.0.5']);

  const running = analyzeScreen(['PS C:\\> ping -t 1.1.1.1', 'Reply from 1.1.1.1: bytes=32'], { command: 'ping -t 1.1.1.1' });
  assert.equal(running.state, 'running');

  const pw = analyzeScreen(['PS C:\\> ssh student@10.0.0.5', "student@10.0.0.5's password: "], { command: 'ssh student@10.0.0.5' });
  assert.equal(pw.state, 'awaiting');
  assert.equal(pw.awaiting.kind, 'password');

  const hostkey = analyzeScreen(['PS C:\\> ssh a@b', 'Are you sure you want to continue connecting (yes/no/[fingerprint])? '], { command: 'ssh a@b' });
  assert.equal(hostkey.awaiting.kind, 'confirm');

  const exp = analyzeScreen(['$ python -m http.server', 'Serving HTTP on 0.0.0.0 port 8000 ...'], { command: 'python -m http.server', expectRe: /Serving HTTP/ });
  assert.equal(exp.state, 'expect');

  const wrapped = analyzeScreen(['PS C:\\> echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'PS C:\\>'], { command: 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(wrapped.state, 'done');
  assert.deepEqual(wrapped.output, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const noCmd = analyzeScreen(['Welcome', 'student@lab:~$'], {});
  assert.equal(noCmd.state, 'done');
});

test('detectAwaiting', () => {
  assert.equal(detectAwaiting('[sudo] password for student: ').kind, 'password');
  assert.equal(detectAwaiting('Do you want to continue? [Y/n] ').kind, 'confirm');
  assert.equal(detectAwaiting('--More--(45%)').kind, 'pager');
  assert.equal(detectAwaiting('Nhập mật khẩu: ').kind, 'password');
  assert.equal(detectAwaiting('all good'), null);
});

const ocrLines = [
  { t: 'PS C:\\> ipconfig', b: [10, 50, 160, 18], w: [['PS', 10, 50, 20, 18], ['C:\\>', 35, 50, 40, 18], ['ipconfig', 80, 50, 90, 18]] },
  { t: 'IPv4 Address : 192.168.1.10', b: [10, 70, 300, 18], w: [['IPv4', 10, 70, 40, 18], ['Address', 55, 70, 70, 18], [':', 130, 70, 8, 18], ['192.168.1.10', 145, 70, 120, 18]] },
  { t: 'token=abcdefabcdefabcdefabcdefabcdefab12', b: [10, 90, 400, 18], w: [['token=abcdefabcdefabcdefabcdefabcdefab12', 10, 90, 380, 18]] },
];

test('findText: text, regex, preset and sub-word boxes', () => {
  const hit = findText(ocrLines, { text: '192.168.1.10' });
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].box, { x: 145, y: 70, w: 120, h: 18 });

  const ip = findText(ocrLines, { preset: 'ipv4' });
  assert.equal(ip[0].text, '192.168.1.10');

  const partial = findText(ocrLines, { regex: '168\\.1' });
  assert.equal(partial.length, 1);
  assert.ok(partial[0].box.x > 145 && partial[0].box.w < 120, 'sub-word box is interpolated inside the word');

  const multi = findText(ocrLines, { text: 'IPv4 Address' });
  assert.deepEqual(multi[0].box, { x: 10, y: 70, w: 115, h: 18 });

  const fuzzy = findText(ocrLines, { text: 'ipconflg' });
  assert.equal(fuzzy.length, 1);
  assert.ok(fuzzy[0].fuzzy);

  assert.equal(findText(ocrLines, { preset: 'secret' }).length, 1);
});

test('slug handles Vietnamese', () => {
  assert.equal(slug('Kiểm tra địa chỉ IP của máy chủ'), 'kiem-tra-dia-chi-ip-cua-may-chu');
  assert.equal(slug(''), 'shot');
});
