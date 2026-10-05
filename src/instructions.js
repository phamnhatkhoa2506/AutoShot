export const SERVER_INSTRUCTIONS = `AutoShot produces screenshot EVIDENCE of real work in real windows (local shells, SSH sessions, any app) and assembles it into reports.

Workflow for a task such as "do the lab in this docx and put screenshots in the report":
1. PLAN before touching the terminal. From the user's document/request, list the steps and, for each, what an image must PROVE (e.g. "service is active", "IP of eth0 is 10.0.0.5"). Capture only those moments - not every keystroke, not failed attempts (unless asked).
2. GET A WINDOW. Prefer list_windows then capture the relevant existing app window (handle/title/process, area="client") before capturing a whole monitor. open_terminal opens a real terminal (use ssh="user@host" for remote work); attach_window is for terminals/apps you need to operate.
3. RUN + CAPTURE. run_command types the command, waits until it truly finishes (prompt back / expect regex / input requested) and returns the exact output text. capture="block" auto-crops to "prompt + command + its output" (block_titled also keeps the window title bar; content = whole window minus empty space). Read the returned output first: if the step failed, fix it and re-run instead of saving a failure.
4. REFINE only when it adds value: use capture_from_shot with a rect in the overview shot's pixel space, or refine_capture to crop by OCR anchor and verify required text. Prefer these over manually converting to desktop coordinates. Use edit_shot for annotations. ALWAYS redact secrets (passwords, tokens, keys; ip/email presets when the user wants privacy). Coordinates in ops are pixels of the input shot (see the grid preview or OCR boxes).
5. SAVE with save_evidence (or evidence={caption,...} directly on run_command/capture). Captions state what the image proves, in the user's language (e.g. caption_prefix "Hình" for Vietnamese reports).
6. REPORT with build_report: new docx/markdown/html, or template=<user's .docx> to insert images after anchor paragraphs ("Câu 2", "Step 3") or at {{e1}} placeholders. Never overwrite the user's file.

Rules:
- Passwords/secrets: never type them. If status is awaiting_input(password), ask the user to type it into the window themselves, then call wait_for.
- Long output: one image should stay readable. Use clear_before=true for a clean screen, filter output (grep, Select-String, head) or split into several captures; widen the window with manage_session resize if lines wrap.
- Prefer exact console text (managed sessions) over OCR when reasoning about results; OCR can misread characters.
- For GUI work: first capture the smallest relevant window, then use its OCR/image to select a region. Use screen:-1 only when the relevant app is unknown. A shot may report an absolute screen origin; OCR boxes always remain relative to that shot.
- Long-running commands: raise timeout_ms or call wait_for; interrupt with send_input keys=["ctrl+c"].
- Keep the user's desktop tidy: close sessions you opened when finished (manage_session close).`;

export const EVIDENCE_PROMPT = ({ task, format, language }) => `You are producing screenshot evidence with the AutoShot tools.

Task from the user:
${task || '(read the user message / attached document)'}

Deliverable: a ${format || 'docx'} report${language ? ` written in ${language}` : ''}.

Do this:
1. Read the task/document and write a short plan: numbered steps, and for each the exact fact an image must prove. Mark which steps need no image.
2. Open or attach the right terminal (open_terminal / attach_window). For SSH use open_terminal(ssh="user@host"); if a password is requested, ask me to type it in the window.
3. For each step: run_command(capture="block" or "block_titled", clear_before when a clean screen helps). Check the returned output; if it failed, diagnose and retry. When correct, highlight the key value if useful, redact secrets, and save_evidence with a caption that states what it proves and a section named after the step.
4. Review manage_evidence(list): order, captions, no duplicates, no secrets.
5. build_report (or template=<the original .docx> with placements after each question/step heading). Report the file path and a one-line summary per image.`;
