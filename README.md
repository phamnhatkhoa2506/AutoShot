# AutoShot — screenshot evidence cho coding agent

AutoShot là một **MCP server** giúp các coding agent (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, …) **tự làm bài thực hành trên terminal thật và chụp ảnh bằng chứng** — chỉ chụp đúng phần cần chứng minh, tự crop, tô sáng, che thông tin nhạy cảm, rồi ghép vào báo cáo `.docx` / Markdown / HTML hoặc **chèn thẳng vào file Word đề bài** của bạn.

```
Bạn: "Làm bài lab trong de-bai.docx, chụp kết quả từng câu, chèn vào file Word"
Agent: đọc đề → lập kế hoạch → mở terminal thật (hoặc SSH) → chạy lệnh → kiểm tra kết quả
       → chụp đúng khối "prompt + lệnh + output" → tô sáng giá trị đề hỏi → lưu bằng chứng
       → chèn ảnh ngay dưới "Câu 1", "Câu 2"… trong bản sao của de-bai.docx
```

## Vì sao nó "xịn"

| Vấn đề khi tự làm | AutoShot giải quyết thế nào |
|---|---|
| Gõ lệnh bị bộ gõ tiếng Việt (Telex) biến `w` → `ư` | Ghi phím **thẳng vào console input buffer** — không qua bàn phím/IME, không cần focus cửa sổ |
| Không biết lệnh chạy xong chưa | Đọc **chính xác text trong console** + nhận biết prompt quay lại, lệnh đang đợi mật khẩu / yes-no / pager, hoặc regex `expect` |
| Ảnh chụp cả màn hình, thừa khoảng trống | `capture="block"` tự cắt đúng **prompt + lệnh + output**, không lẹm dòng bên cạnh |
| Cửa sổ bị che thì chụp ra cửa sổ khác | Chụp bằng `PrintWindow` — **chụp được cả khi cửa sổ bị che**, không giành focus |
| Muốn tô đậm IP / che token trước khi nộp | `edit_shot`: crop theo chữ, `highlight`, `box`, `arrow`, `label`, `redact` (preset `ipv4`, `secret`, `password_value`…) |
| Chữ OCR sai lệch | Với terminal do AutoShot mở: **text chính xác từ console được căn lên lưới ký tự** → toạ độ từng chữ chuẩn tới pixel. Với app khác (MobaXterm, PuTTY): OCR 2 lượt (thường + nhị phân hoá) để không sót chữ màu |
| Dán ảnh vào Word mất thời gian | `build_report`: docx/markdown/html có chú thích đánh số "Hình 1…", hoặc chèn vào file Word có sẵn theo tiêu đề câu hỏi / placeholder `{{e1}}` |

## Yêu cầu

- Windows 10/11 (máy chạy agent). Máy đích có thể là Linux/thiết bị mạng qua **SSH**.
- Node.js ≥ 18, Windows PowerShell 5.1 (có sẵn).
- Windows Terminal (tuỳ chọn — không có thì dùng console cổ điển).
- Gói OCR tiếng Anh của Windows (thường có sẵn; `npm run doctor` sẽ kiểm tra).

## Cài đặt

```powershell
cd D:\Programming\AutoShot
npm install
npm run doctor      # kiểm tra worker, DPI, màn hình, OCR, chụp màn hình
```

Lần chạy đầu worker biên dịch phần lõi C# (~5–10 s) và cache lại ở `%LOCALAPPDATA%\AutoShot\cache`.

## Tích hợp vào agent

Thay đường dẫn cho đúng máy bạn.

**Claude Code**
```powershell
claude mcp add autoshot --scope user -- node D:\Programming\AutoShot\src\index.js
# tuỳ chọn: nơi lưu ảnh/báo cáo cố định
claude mcp add autoshot --scope user -e AUTOSHOT_DIR=D:\LabReports -- node D:\Programming\AutoShot\src\index.js
```
Thêm skill hướng dẫn quy trình: copy thư mục `integrations/claude-code/autoshot-evidence` vào `%USERPROFILE%\.claude\skills\`.
Prompt có sẵn: gõ `/mcp__autoshot__evidence_report`.

**Codex CLI** — `%USERPROFILE%\.codex\config.toml`
```toml
[mcp_servers.autoshot]
command = "node"
args = ["D:\\Programming\\AutoShot\\src\\index.js"]
startup_timeout_sec = 60
tool_timeout_sec = 180
```

**OpenCode** — `opencode.json` (project) hoặc `~/.config/opencode/opencode.json`
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "autoshot": { "type": "local", "command": ["node", "D:\\Programming\\AutoShot\\src\\index.js"], "enabled": true }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) / **Gemini CLI** (`~/.gemini/settings.json`) / Claude Desktop
```json
{ "mcpServers": { "autoshot": { "command": "node", "args": ["D:\\Programming\\AutoShot\\src\\index.js"] } } }
```

Với Codex / OpenCode, chép nội dung `integrations/AGENTS.md` vào `AGENTS.md` của project để agent dùng đúng quy trình.

## Công cụ (14)

| Tool | Dùng để |
|---|---|
| `list_windows` | Liệt kê cửa sổ, màn hình, session đang mở |
| `open_terminal` | Mở terminal thật (Windows Terminal / console cổ điển; PowerShell, pwsh, cmd, WSL); `ssh="user@host"` để SSH ngay |
| `attach_window` | Gắn vào cửa sổ có sẵn (MobaXterm, PuTTY, VS Code…) |
| `manage_session` | list / info / focus / resize / move / rename / close / detach |
| `run_command` | Gõ lệnh, **đợi tới khi xong thật**, trả output; `capture="block" \| "block_titled" \| "content" \| "window"`; kèm `ops` và `evidence` trong 1 lần gọi |
| `send_input` | Gửi chữ / phím (`ctrl+c`, `y`, `enter`, `q`, `up`…) cho chương trình tương tác |
| `wait_for` | Đợi prompt hoặc regex (sau khi người dùng tự gõ mật khẩu, build lâu…) |
| `read_screen` | Đọc chữ đang hiển thị (không tốn ảnh) |
| `capture` | Chụp session / cửa sổ / màn hình / vùng; `with_text` trả OCR kèm toạ độ, `grid` vẽ thước pixel |
| `view_shot` | Xem lại ảnh + OCR trước khi crop |
| `edit_shot` | crop · trim · pad · scale · frame · box · highlight · redact · label · badge · arrow |
| `save_evidence` | Lưu ảnh làm bằng chứng + chú thích + mục (section) |
| `manage_evidence` | list / update / remove / reorder / clear |
| `build_report` | Xuất docx / markdown / html, hoặc chèn vào file .docx có sẵn |

Ví dụ ops cho `edit_shot` / `run_command.ops`:
```json
[
  { "op": "crop", "from_text": "ip a", "to_text": "inet6" },
  { "op": "highlight", "regex": "inet 10\\.\\d+\\.\\d+\\.\\d+" },
  { "op": "box", "text": "active (running)", "label": "đang chạy" },
  { "op": "redact", "preset": "password_value" },
  { "op": "frame", "margin": 20 }
]
```
Mọi toạ độ (`rect`, `at`, `from`) là pixel của **ảnh đầu vào** — cùng hệ toạ độ với OCR (`L01 [x,y,w,h]`) và lưới `grid`.

Chèn vào file Word đề bài (ghi ra bản sao, không ghi đè file gốc):
```json
{
  "template": "D:\\Lab\\de-bai.docx",
  "output": "D:\\Lab\\bai-lam.docx",
  "caption_prefix": "Hình",
  "placements": [
    { "anchor": "Câu 1", "evidence": ["e1"] },
    { "anchor": "Câu 2", "evidence": ["e2", "e3"] }
  ]
}
```
Hoặc đặt dòng `{{e4}}` thành một đoạn riêng trong file Word — AutoShot sẽ thay bằng ảnh e4. Chú thích được đánh số theo thứ tự xuất hiện trong tài liệu.

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AUTOSHOT_DIR` | `<thư mục làm việc>\autoshot-output` | Nơi lưu `shots/`, `evidence/`, `evidence.json`, báo cáo |
| `AUTOSHOT_HOST` | `auto` | `wt` / `conhost` / `auto` |
| `AUTOSHOT_INLINE_IMAGES` | `1` | Trả ảnh preview cho agent (tắt nếu client không hỗ trợ ảnh MCP; agent vẫn có đường dẫn file) |
| `AUTOSHOT_PREVIEW_MAX` | `1920` | Cạnh dài tối đa của preview |
| `AUTOSHOT_RESTORE_FOCUS` | `1` | Trả focus về cửa sổ cũ sau khi phải gõ phím vào app khác |
| `AUTOSHOT_OCR_LANG` | `en-US` | Ngôn ngữ OCR của Windows |
| `AUTOSHOT_OCR_SCALE` | `2` | Phóng to ảnh trước khi OCR |
| `AUTOSHOT_COMMAND_TIMEOUT_MS` | `45000` | Thời gian chờ mặc định của `run_command` |
| `AUTOSHOT_DEBUG` | `0` | Ghi log ra stderr |

## Kiến trúc

```
agent ──MCP stdio──> src/index.js ─ server.js (14 tools + prompt + hướng dẫn cho agent)
                        │  terminal.js  chạy lệnh, đợi hoàn tất, tính vùng crop "block"
                        │  sessions.js  mở/gắn cửa sổ, chọn cách nhập & đọc chữ
                        │  shots.js     kho ảnh, OCR (2 lượt), căn text console lên lưới ký tự
                        │  edit.js      pipeline chỉnh ảnh theo chữ/regex/dòng/toạ độ
                        │  evidence.js  danh sách bằng chứng   report/  docx · md · html · chèn Word
                        └─JSON lines──> native/worker.ps1 (PowerShell 5.1 chạy lâu dài)
                                           ├─ AutoShot.Native.cs  Win32: cửa sổ, focus, SendInput,
                                           │                      PrintWindow, xử lý ảnh (GDI+)
                                           ├─ Windows.Media.Ocr   OCR có toạ độ từng chữ
                                           └─ ConIO.exe (serve)   AttachConsole: đọc buffer chính xác,
                                                                  WriteConsoleInput: gõ phím không cần focus
```

## Kiểm thử

```powershell
npm test        # unit test (nhận diện prompt/lệnh, tìm chữ OCR, báo cáo docx/md/html, chèn Word)
npm run e2e     # mở cửa sổ thật, gọi toàn bộ tool qua giao thức MCP, xuất báo cáo
```

## Giới hạn & mẹo

- Máy chạy agent phải là Windows có desktop (không chạy dưới service/phiên không có màn hình).
- **Mật khẩu**: AutoShot không bao giờ gõ mật khẩu hộ. Khi gặp prompt mật khẩu, agent sẽ nhờ bạn tự gõ vào cửa sổ rồi gọi `wait_for`. Dùng SSH key để tự động hoàn toàn.
- Output dài hơn cửa sổ: dùng `clear_before`, lọc output (`grep`, `head`, `Select-String`), chia nhỏ, hoặc `manage_session resize`.
- App không phải console (MobaXterm, PuTTY): nhập bằng clipboard (`Shift+Insert`, đổi bằng `paste_chord`) và đọc bằng OCR — kém chính xác hơn terminal do AutoShot tự mở.
- Cửa sổ chạy quyền Administrator: tiến trình thường không gửi phím vào được (Windows UIPI) — chạy agent cùng quyền.
