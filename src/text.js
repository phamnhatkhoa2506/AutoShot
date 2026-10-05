// Text heuristics shared by console-buffer text and OCR text: prompt detection,
// fuzzy command matching, "waiting for input" detection and OCR word-span mapping.

const CONFUSABLES = [
  [/[0o]/g, 'o'],
  [/[1li|!]/g, 'l'],
  [/[’‘`´]/g, "'"],
  [/[“”]/g, '"'],
  [/[—–−]/g, '-'],
  [/\s+/g, ''],
];

/** Normalise text for OCR-tolerant comparison (case, whitespace, look-alike glyphs). */
export function fold(s) {
  let t = String(s ?? '').toLowerCase();
  for (const [re, rep] of CONFUSABLES) t = t.replace(re, rep);
  return t;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/** Best similarity between `needle` and any same-length window of `hay` (both already folded). */
export function windowSimilarity(hay, needle) {
  if (!needle) return 0;
  if (hay.includes(needle)) return 1;
  const h = hay.slice(0, 400);
  let best = 0;
  for (const len of [needle.length - 1, needle.length, needle.length + 1]) {
    if (len <= 0 || len > h.length) continue;
    for (let i = 0; i + len <= h.length; i++) {
      const s = similarity(h.slice(i, i + len), needle);
      if (s > best) best = s;
      if (best >= 0.999) return best;
    }
  }
  if (h.length < needle.length) best = Math.max(best, similarity(h, needle.slice(0, h.length)) * (h.length / needle.length));
  return best;
}

// ------------------------------------------------------------------ prompts
const PROMPT_RES = [
  /^PS [^>\n]{0,260}>\s?$/, // PowerShell
  /^[A-Za-z]:\\[^>\n]{0,260}>\s?$/, // cmd.exe
  /^[\w.-]+@[\w.-]+(?::|\s)[^\n]{0,200}[$#%]\s?$/, // user@host:~$
  /^\[[^\]\n]{1,200}\][$#%]\s?$/, // [user@host dir]$
  /^\([^)\n]{1,60}\)\s?[\w.-]+@[\w.-]+[^\n]{0,200}[$#%]\s?$/, // (venv) user@host:~$
  /^[\w.-]{1,40}[$#%]\s?$/, // bash-5.1$  router#
  /^[\w.-]{1,40}(?:\([^)\n]{1,40}\))?[#>]\s?$/, // switch(config)#  switch>
  /^(?:>>>|\.\.\.|mysql>|MariaDB \[[^\]]*\]>|sqlite>|[\w-]+=[#>]|ftp>|sftp>|\(gdb\)|irb\([^)]*\):\d+:\d+[>*]|In \[\d+\]:)\s?$/,
  /[❯➜λ»]\s?$/,
];

export function isPromptLine(line, custom) {
  // OCR sometimes reads the blinking cursor after the prompt as "|", "_" or a block glyph
  const t = String(line ?? '')
    .replace(/\s+$/, '')
    .replace(/([>$#%])\s+[|_█▌▋▍▎▏▐Il]$/, '$1');
  if (!t) return false;
  if (custom) return custom.test(t);
  if (t.startsWith('<')) return false;
  return PROMPT_RES.some((re) => re.test(t));
}

/** Split "PS C:\> dir" / "user@host:~$ ls" into prompt + command text, when it looks like one. */
export function splitPrompt(line) {
  const t = String(line ?? '');
  let m = /^(PS [^>\n]{0,260}>)\s?(.*)$/.exec(t) || /^([A-Za-z]:\\[^>\n]{0,260}>)(.*)$/.exec(t);
  if (!m) m = /^((?:\([^)]{1,60}\)\s?)?[\w.-]+@[\w.-]+(?::|\s)[^$#%\n]{0,200}[$#%])\s?(.*)$/.exec(t);
  if (!m) m = /^(\[[^\]\n]{1,200}\][$#%])\s?(.*)$/.exec(t);
  return m ? { prompt: m[1], rest: m[2] } : null;
}

// ------------------------------------------------------------------ waiting for input
const AWAIT_PATTERNS = [
  { kind: 'password', re: /(?:password|passphrase|passcode|mật khẩu|verification code|otp)[^\n]{0,60}[:?]\s*$/i },
  { kind: 'password', re: /\[sudo\] password for [^:]+:\s*$/i },
  { kind: 'confirm', re: /\(yes\/no(?:\/\[fingerprint\])?\)\??\s*$/i },
  { kind: 'confirm', re: /\[(?:y\/n|y\/N|Y\/n|Y\/N|yes\/no)\]\s*[:?]?\s*$/ },
  { kind: 'confirm', re: /\((?:y\/n|Y\/n|y\/N|Y\/N)\)\s*[:?]?\s*$/ },
  { kind: 'confirm', re: /(?:continue|proceed|overwrite|are you sure|do you want)[^\n]{0,80}\?\s*$/i },
  { kind: 'pager', re: /^(?:--More--.*|\(END\)|:)\s*$/ },
  { kind: 'key', re: /press any key|press enter to continue|hit enter to continue/i },
];

export function detectAwaiting(line) {
  const t = String(line ?? '').replace(/\s+$/, '');
  if (!t) return null;
  for (const p of AWAIT_PATTERNS) if (p.re.test(t)) return { kind: p.kind, line: t };
  return null;
}

export const AWAIT_HINTS = {
  password:
    'The terminal is asking for a secret. Do NOT type it yourself and do not ask the user to paste it into the chat. Ask the user to type it directly into the terminal window, then call wait_for.',
  confirm:
    'The terminal asks for a confirmation (e.g. SSH host key "yes/no"). Only answer (send_input text "yes" + enter) if it is clearly expected for the task; otherwise ask the user.',
  pager: 'A pager (more/less) is waiting. Send key "q" to quit it, or "space" to page down. Prefer re-running with a non-paging option (e.g. `| cat`, `--no-pager`).',
  key: 'The program waits for a key press. Send "enter" (or the key it asks for) with send_input.',
};

// ------------------------------------------------------------------ command block analysis
/** Index of the (last) line showing `command`, tolerant to OCR noise and line wrapping. */
export function findCommandLine(lines, command, minIndex = 0) {
  const target = fold(command);
  if (!target) return -1;
  const head = target.slice(0, 40);
  // Pass 1: a line that starts with a shell prompt followed by the command. This keeps
  // output such as "Windows IP Configuration" from matching the command "ipconfig".
  for (let i = lines.length - 1; i >= minIndex; i--) {
    const sp = splitPrompt(lines[i]);
    if (!sp) continue;
    const rest = fold(sp.rest);
    if (!rest) continue;
    if (rest.startsWith(head) || (rest.length >= Math.min(8, head.length) && head.startsWith(rest)) || similarity(rest.slice(0, head.length), head) >= 0.8) return i;
  }
  // Pass 2: prompt unknown / unusual - any line showing the command.
  for (let i = lines.length - 1; i >= minIndex; i--) {
    const l = fold(lines[i]);
    if (!l) continue;
    if (l.includes(head)) return i;
    const minOverlap = Math.min(head.length, 8);
    for (let k = Math.min(l.length, head.length); k >= minOverlap; k--) {
      if (l.endsWith(head.slice(0, k))) return i;
    }
    if (head.length >= 5) {
      const sp = splitPrompt(lines[i]);
      const rest = sp ? fold(sp.rest) : l;
      if (similarity(rest.slice(0, head.length), head) >= 0.8 || windowSimilarity(l, head) >= 0.84) return i;
    }
  }
  return -1;
}

/** Last row index occupied by a (possibly wrapped) command that starts at `cmdIndex`. */
export function commandEndLine(lines, command, cmdIndex, lastIdx) {
  const target = fold(command);
  let joined = '';
  for (let j = cmdIndex; j <= Math.min(lastIdx, cmdIndex + 12); j++) {
    joined += fold(lines[j]);
    if (joined.includes(target) || windowSimilarity(joined, target) >= 0.9) return j;
  }
  return cmdIndex;
}

function lastNonEmpty(lines, upTo = lines.length - 1) {
  let i = Math.min(upTo, lines.length - 1);
  while (i >= 0 && !String(lines[i] ?? '').trim()) i--;
  return i;
}

/**
 * Classify the screen after a command was sent.
 * state: 'done' (prompt returned), 'awaiting' (needs input), 'running', 'expect' (expect regex matched).
 */
export function analyzeScreen(lines, { command, promptRe, expectRe, minIndex = 0 } = {}) {
  const lastIdx = lastNonEmpty(lines);
  const cmdIndex = command ? findCommandLine(lines, command, minIndex) : -1;
  const cmdEnd = cmdIndex >= 0 ? commandEndLine(lines, command, cmdIndex, lastIdx) : -1;
  const lastLine = lastIdx >= 0 ? lines[lastIdx] : '';
  const result = { lastIdx, cmdIndex, cmdEnd, state: 'running', awaiting: null, output: [], truncatedTop: false };

  const scopeStart = cmdIndex >= 0 ? cmdEnd + 1 : 0;
  const scope = lines.slice(scopeStart, lastIdx + 1).join('\n');
  if (expectRe && expectRe.test(cmdIndex >= 0 ? scope : lines.join('\n'))) result.state = 'expect';
  else if (!command) {
    if (isPromptLine(lastLine, promptRe)) result.state = 'done';
    else {
      const aw = detectAwaiting(lastLine);
      if (aw) {
        result.state = 'awaiting';
        result.awaiting = aw;
      }
    }
    result.output = trimBlankEdges(lines.slice(0, lastIdx + 1).map((l) => String(l ?? '').replace(/\s+$/, '')));
    return result;
  } else if (lastIdx > cmdEnd && cmdIndex >= 0 && isPromptLine(lastLine, promptRe)) result.state = 'done';
  else if (cmdIndex < 0 && command && isPromptLine(lastLine, promptRe)) {
    // command line scrolled away (or the command cleared the screen) but a fresh prompt is shown
    result.state = 'done';
    result.truncatedTop = true;
  } else if (lastIdx >= (cmdIndex >= 0 ? cmdIndex : 0)) {
    const aw = detectAwaiting(lastLine);
    if (aw && (cmdIndex < 0 || lastIdx > cmdIndex || aw.kind === 'password')) {
      result.state = 'awaiting';
      result.awaiting = aw;
    }
  }

  const outStart = cmdIndex >= 0 ? cmdEnd + 1 : 0;
  const outEnd = result.state === 'done' ? lastIdx - 1 : lastIdx;
  result.output = trimBlankEdges(lines.slice(outStart, outEnd + 1).map((l) => String(l ?? '').replace(/\s+$/, '')));
  if (cmdIndex < 0) result.truncatedTop = true;
  return result;
}

export function trimBlankEdges(arr) {
  let a = 0;
  let b = arr.length;
  while (a < b && !arr[a].trim()) a++;
  while (b > a && !arr[b - 1].trim()) b--;
  return arr.slice(a, b);
}

// ------------------------------------------------------------------ OCR word spans
export const REDACT_PRESETS = {
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?\b/g,
  ipv6: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?:%\w+)?(?:\/\d{1,3})?/gi,
  mac: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi,
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  jwt: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  secret: /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})\b|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
  password_value: /(?<=(?:password|passwd|pwd|pass|token|secret|api[_-]?key)\s*[:=]\s*)\S+/gi,
  hostname: /\b[\w-]+(?:\.[\w-]+)+\.(?:com|net|org|io|vn|local|lan|internal|dev|app)\b/gi,
};

/** words: [[text,x,y,w,h], ...] -> { text, spans: [{start,end,box}] } with single-space joins. */
export function lineIndex(line) {
  const spans = [];
  let text = '';
  for (const w of line.w) {
    if (text) text += ' ';
    const start = text.length;
    text += w[0];
    spans.push({ start, end: text.length, x: w[1], y: w[2], w: w[3], h: w[4] });
  }
  return { text, spans };
}

function unionBoxes(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export { unionBoxes };

/** Box covering characters [a,b) of an indexed line; sub-word positions are interpolated (monospace friendly). */
export function spanBox(idx, a, b) {
  const parts = [];
  for (const s of idx.spans) {
    const ps = Math.max(a, s.start);
    const pe = Math.min(b, s.end);
    if (pe <= ps) continue;
    const len = Math.max(1, s.end - s.start);
    const x0 = s.x + (s.w * (ps - s.start)) / len;
    const x1 = s.x + (s.w * (pe - s.start)) / len;
    parts.push({ x: x0, y: s.y, w: x1 - x0, h: s.h });
  }
  const u = unionBoxes(parts);
  return u && { x: Math.round(u.x), y: Math.round(u.y), w: Math.max(1, Math.round(u.w)), h: Math.max(1, Math.round(u.h)) };
}

function toGlobal(re) {
  return re.global ? re : new RegExp(re.source, re.flags + 'g');
}

/**
 * Find text in OCR lines. matcher: { text } | { regex } | { preset }.
 * Returns [{ lineIndex, text, box }] in the OCR coordinate space.
 */
export function findText(ocrLines, matcher) {
  const hits = [];
  let re = null;
  if (matcher.preset) {
    re = REDACT_PRESETS[matcher.preset];
    if (!re) throw new Error(`Unknown preset '${matcher.preset}'. Available: ${Object.keys(REDACT_PRESETS).join(', ')}`);
  } else if (matcher.regex) {
    try {
      re = new RegExp(matcher.regex, 'gi');
    } catch (e) {
      throw new Error(`Invalid regex '${matcher.regex}': ${e.message}`);
    }
  }
  ocrLines.forEach((line, li) => {
    const idx = lineIndex(line);
    if (re) {
      for (const m of idx.text.matchAll(toGlobal(re))) {
        if (!m[0]) continue;
        const box = spanBox(idx, m.index, m.index + m[0].length);
        if (box) hits.push({ lineIndex: li, text: m[0], box });
      }
    } else if (matcher.text) {
      const needle = String(matcher.text).replace(/\s+/g, ' ').trim().toLowerCase();
      const hay = idx.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        const box = spanBox(idx, at, at + needle.length);
        if (box) hits.push({ lineIndex: li, text: idx.text.slice(at, at + needle.length), box });
        from = at + Math.max(1, needle.length);
      }
    }
  });
  if (!hits.length && matcher.text) {
    // OCR-tolerant fallback over word windows
    const target = fold(matcher.text);
    const nWords = String(matcher.text).trim().split(/\s+/).length;
    ocrLines.forEach((line, li) => {
      const idx = lineIndex(line);
      for (let i = 0; i < idx.spans.length; i++) {
        for (const k of [nWords - 1, nWords, nWords + 1]) {
          if (k <= 0 || i + k > idx.spans.length) continue;
          const a = idx.spans[i].start;
          const b = idx.spans[i + k - 1].end;
          const cand = idx.text.slice(a, b);
          if (similarity(fold(cand), target) >= 0.8) {
            hits.push({ lineIndex: li, text: cand, box: spanBox(idx, a, b), fuzzy: true });
            break;
          }
        }
      }
    });
  }
  return hits;
}

/** Choose hits by occurrence: 'first' | 'last' | 'all' | 1-based number. */
export function pickOccurrence(hits, occurrence = 'all') {
  if (!hits.length) return hits;
  if (occurrence === 'first') return [hits[0]];
  if (occurrence === 'last') return [hits[hits.length - 1]];
  if (typeof occurrence === 'number') return hits[occurrence - 1] ? [hits[occurrence - 1]] : [];
  return hits;
}

export function slug(s, max = 48) {
  const t = String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return t.slice(0, max).replace(/-+$/, '') || 'shot';
}
