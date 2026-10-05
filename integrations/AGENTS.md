<!-- Paste this section into your project's AGENTS.md (Codex, OpenCode, Cursor, Gemini CLI...). -->

## Screenshot evidence (AutoShot MCP)

When a task asks for screenshots / proof of work on a real machine ("chụp màn hình", lab reports, evidence), use the `autoshot` MCP tools instead of describing results in text.

1. **Plan**: list each step, its command(s) and the fact its image must prove. Only capture what proves a step.
2. **Terminal**: `open_terminal` (add `ssh: "user@host"` for remote work) or `list_windows` + `attach_window` for an existing window. If a password prompt appears, ask the user to type it in the window, then `wait_for`. Never type or request secrets.
3. **Run + capture**: `run_command` with `capture: "block"` (`"block_titled"` to include the window title) and `clear_before: true` for clean shots. Check the returned output; fix failures before saving.
4. **Refine**: `edit_shot` ops — crop by `from_text`/`to_text` or OCR `lines`, `highlight`/`box` the value that matters, `redact` secrets (`preset: "password_value" | "secret" | "ipv4"`), optional `frame`.
5. **Save**: `evidence: { caption, section }` on the capture call, or `save_evidence`. Captions state what the image proves, in the report's language.
6. **Report**: `build_report` (`format: "docx" | "markdown" | "html"`, `caption_prefix: "Hình"` for Vietnamese) or `template` = the user's .docx with `placements` after each question heading. Never overwrite the user's original file.
7. Close the terminals you opened (`manage_session action: "close"`).
