---
name: autoshot-evidence
description: Produce screenshot evidence of terminal/SSH work with the AutoShot MCP tools and assemble it into a report (docx/markdown/html or inserted into the user's own .docx). Use when the user asks to do a lab/exercise/task on a real machine and "chụp màn hình", capture results, prove steps with images, or fill screenshots into a document.
---

# Screenshot evidence with AutoShot

The AutoShot MCP server (`mcp__autoshot__*`) runs commands in REAL terminal windows and captures precisely cropped screenshots. Your job is to decide WHAT deserves an image and make every image prove something.

## 1. Plan first
- Read the task / document (e.g. the lab .docx) completely.
- Write a numbered plan: step → command(s) → the fact an image must prove (e.g. "eth0 has IP 10.0.0.5", "nginx is active (running)"). Mark steps that need no image.
- Decide the report form: new docx, or insert into the user's document after each question heading (keep their file untouched; write a copy).

## 2. Get a terminal
- New local shell: `open_terminal` (Windows Terminal, PowerShell by default; `shell: "cmd"` / `"wsl"`).
- Remote Linux: `open_terminal` with `ssh: "user@host"`. If the result says it waits for a password, ask the user to type it into the window (never ask for it in chat, never type it), then `wait_for`.
- Existing window (MobaXterm, PuTTY…): `list_windows` → `attach_window` (text comes from OCR there; double-check critical values).

## 3. Run, verify, capture
- `run_command` with `capture: "block"` (or `"block_titled"` to show the window title, e.g. the SSH host) and `clear_before: true` when a clean screen helps.
- Read the returned output BEFORE saving. If the step failed, fix and re-run; do not save failures unless asked.
- Add `evidence: { caption, section }` in the same call when the image is final, or save later with `save_evidence`.
- Long-running/server commands: `expect: "<regex of the ready line>"`; stop them with `send_input` keys `["ctrl+c"]`.

## 4. Make the image say it
- `edit_shot` ops (coordinates = pixels of the input shot; OCR boxes from `view_shot` / `capture with_text`):
  - `{"op":"crop","from_text":"<command>","to_text":"<last relevant line>"}` for a tight block
  - `{"op":"highlight","text":"10.0.0.5"}`, `{"op":"box","regex":"active \\(running\\)","label":"OK"}`
  - `{"op":"redact","preset":"password_value"}` / `"secret"` / `"ipv4"` (privacy) — always redact secrets
  - `{"op":"frame"}` for a polished look
- One image = one fact. Keep text readable (≈ ≤ 30 lines); split long output or filter it (`grep`, `head`, `Select-String`).

## 5. Report
- `manage_evidence` `list` → fix order/captions (captions in the report language; for Vietnamese use `caption_prefix: "Hình"`).
- `build_report`:
  - new document: `{ "format": "docx", "title": "...", "caption_prefix": "Hình", "include_commands": true }`
  - into the user's file: `{ "template": "<de-bai.docx>", "output": "<bai-lam.docx>", "placements": [{ "anchor": "Câu 1", "evidence": ["e1"] }] }`
- Close the terminals you opened (`manage_session` `close`) and tell the user the report path plus one line per image.
