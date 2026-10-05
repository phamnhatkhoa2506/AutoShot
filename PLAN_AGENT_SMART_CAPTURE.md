# Kế hoạch: Smart Capture cho Agent

> Trạng thái triển khai (2026-10-05): Milestone A hoàn thành; Milestone B hoàn thành cho crop từ shot và live re-capture từ screen shot trực tiếp; Milestone C hoàn thành cho crop OCR anchor + kiểm chứng text. Các hạng mục P1/P2 còn lại là backlog.

## Mục tiêu

Giúp Agent tự xác định và chụp đúng vùng giao diện cần làm bằng chứng, không cần người dùng kéo chọn vùng và không giới hạn ở terminal.

Nguyên tắc thiết kế:

- Agent làm phần suy luận ngữ nghĩa từ ảnh/OCR: *"kết quả quét Nmap"*, *"nút Deploy"*, *"bảng doanh thu"*.
- MCP làm phần cơ học, xác định tọa độ, kiểm chứng và xử lý ảnh theo cách đáng tin cậy.
- Luồng mặc định là `window-first`; chỉ chụp toàn desktop khi không xác định được cửa sổ mục tiêu.
- Toạ độ luôn phải có không gian tham chiếu rõ ràng, đặc biệt khi dùng nhiều màn hình/DPI khác nhau.

## Hiện trạng và vấn đề

`capture` đã chụp được cửa sổ, màn hình và `region` bất kỳ. `with_text` trả OCR boxes, còn `edit_shot` crop/highlight/redact theo pixel hoặc OCR text.

Tuy nhiên, để Agent tự chọn vùng, còn bốn khoảng trống chính:

1. OCR box là pixel tương đối trong ảnh (`shot`), trong khi `capture.region` là pixel tuyệt đối của Windows. Khi chụp virtual desktop có màn hình đặt bên trái/trên màn hình chính, Agent có thể tính sai offset.
2. Agent phải tự tính `{x,y,w,h}` và không có cách chuẩn để yêu cầu crop lại theo hệ toạ độ của một `shot` trước đó.
3. Crop xong không có bước xác minh rằng vùng mới thực sự chứa anchor/mục tiêu cần chứng minh.
4. Hướng dẫn server đang thiên về terminal nên Agent có thể chụp cả desktop thay vì tìm và chụp cửa sổ/app liên quan trước.

## Phạm vi phiên bản đầu

Không xây model thị giác mới, UI overlay, hay tự động click vào ứng dụng. Phiên bản đầu chỉ làm cho Agent dùng tốt hơn ảnh, OCR và toạ độ mà AutoShot đã có.

## Giải pháp đề xuất

### 1. Công bố đầy đủ không gian toạ độ của shot

**Vấn đề:** `CaptureResult` native đã có `ScreenX`/`ScreenY`, nhưng metadata shot hiện không lưu hai giá trị này.

**Thay đổi:** khi tạo shot từ `capture`, lưu và hiển thị:

```json
{
  "id": "s12",
  "width": 3840,
  "height": 1080,
  "coordinate_space": {
    "shot_pixels": "origin at top-left of s12",
    "absolute_screen_origin": { "x": -1920, "y": 0 },
    "dpi": 96
  }
}
```

Quy tắc chuyển đổi được ghi rõ trong tool description:

```text
absolute_screen.x = shot_pixel.x + absolute_screen_origin.x
absolute_screen.y = shot_pixel.y + absolute_screen_origin.y
```

**File dự kiến:** `src/server.js`, `src/shots.js`, có thể bổ sung test metadata tại `test/`.

**Tiêu chí hoàn thành:** một shot chụp `screen: -1` trả được origin âm/dương chính xác; Agent không cần đoán origin.

### 2. Thêm `capture_from_shot` để loại bỏ phép tính thủ công

Đây là cải thiện có hiệu quả cao nhất cho Agent. Thay vì Agent đổi toạ độ OCR/preview sang desktop coordinates, cho phép crop/chụp lại dựa vào một shot đã có.

API đề xuất:

```json
{
  "shot": "s12",
  "rect": { "x": 420, "y": 255, "w": 860, "h": 510 },
  "padding": 16,
  "fresh": true,
  "with_text": true,
  "label": "Nmap open ports"
}
```

Ý nghĩa:

- `rect` luôn là pixel trong shot `s12`, đúng cùng hệ với OCR boxes và grid.
- `padding` được clamp trong biên ảnh.
- `fresh: false` (mặc định): dùng `edit_shot crop`; nhanh và chính xác tuyệt đối với snapshot đã xem.
- `fresh: true`: chuyển `rect` từ shot space sang absolute screen space bằng origin của shot, rồi chụp lại màn hình. Chỉ dùng khi cần trạng thái mới; response trả `source_changed`/timestamp để Agent biết ảnh có thể đã thay đổi.

Với `fresh: true`, chỉ hỗ trợ shot có mapping 1:1 tới màn hình/cửa sổ. Shot đã scale, rotate hoặc compose phải trả lỗi hướng dẫn dùng crop thường.

**Lựa chọn triển khai:**

- Cách tối giản: bổ sung action `crop` theo `rect` cho `edit_shot`; phần lớn nhu cầu evidence đã được đáp ứng.
- Cách hoàn chỉnh: tool riêng `capture_from_shot`, tái dùng `capture_rect` và affine transform đã có trong `src/edit.js`.

Khuyến nghị: triển khai cách hoàn chỉnh nhưng giữ `fresh=false` làm mặc định để không tái chụp UI động một cách không cần thiết.

### 3. Thêm crop theo anchor và bước xác minh

API đề xuất: mở rộng `edit_shot` bằng operation `crop_anchor`, hoặc cung cấp wrapper `refine_capture`.

```json
{
  "shot": "s12",
  "anchor": { "text": "Nmap scan report", "occurrence": "last" },
  "include": { "to_text": "Nmap done" },
  "padding": { "top": 18, "right": 24, "bottom": 18, "left": 24 },
  "verify": {
    "must_include": ["Nmap scan report", "open"],
    "min_matches": 2
  }
}
```

Luồng:

1. Dùng OCR/console-grid tìm anchor; tận dụng matching tolerant hiện có.
2. Tạo rect từ `anchor` đến `include.to_text`, hoặc từ cluster OCR gần nhất nếu không có `include`.
3. Crop với padding và clamp.
4. OCR lại ảnh crop (hoặc transform OCR inherited khi an toàn).
5. Trả `verified`, danh sách điều kiện pass/fail, rect sử dụng và ảnh preview.

Ví dụ response:

```json
{
  "shot": "s13",
  "verified": true,
  "matches": ["Nmap scan report", "80/tcp open"],
  "rect_in_s12": { "x": 420, "y": 255, "w": 860, "h": 510 }
}
```

Nếu verification fail, tool vẫn có thể trả shot để Agent xem, nhưng phải đánh dấu rõ `verified: false`; không tự lưu evidence.

**Lưu ý:** đây là kiểm chứng text/OCR, không khẳng định được ý nghĩa hoàn toàn của icon, chart hay hình ảnh. Agent vẫn là thành phần quyết định ngữ nghĩa.

### 4. Cập nhật hướng dẫn orchestration cho Agent

Thêm vào `SERVER_INSTRUCTIONS` và integration skill một quy trình GUI-first:

```text
1. list_windows để tìm title/process phù hợp.
2. capture(handle, area: client, with_text: true) cho cửa sổ đó.
3. Chỉ capture(screen: -1) nếu không xác định được app/cửa sổ.
4. Agent đọc ảnh/OCR để chọn anchor hoặc rect trong shot space.
5. refine_capture / capture_from_shot để crop và verify.
6. Chỉ save_evidence nếu crop đã được xem hoặc verified.
7. Redact trước khi lưu/chia sẻ ảnh.
```

Mô tả tool cũng cần nhắc rõ rằng preview có thể bị scale, nhưng OCR boxes và `rect` luôn theo pixel gốc của shot.

## Các cải thiện nên làm sau phiên bản đầu

| Ưu tiên | Hạng mục | Lý do |
|---|---|---|
| P1 | OCR đa ngôn ngữ (`vi-VN`, auto fallback) | Giảm bỏ sót giao diện/báo cáo tiếng Việt. |
| P1 | `wait_stable` cho window/region | Tránh ảnh đang loading, animation hoặc popup chưa xuất hiện xong. |
| P1 | OCR clusters/blocks | Bố cục nhiều cột/bảng dễ chọn nhầm khi chỉ dựa vào thứ tự dòng. |
| P2 | UI Automation / accessibility tree | Định vị control không có text và giảm phụ thuộc OCR. |
| P2 | Chế độ privacy trước preview | Mask pattern bí mật trước khi ảnh/OCR được gửi cho Agent. |
| P2 | Visual grounding/model cục bộ | Hỗ trợ biểu đồ/icon; không cần thiết cho bản đầu. |

## Kế hoạch triển khai

### Milestone A — Toạ độ đáng tin cậy

1. Lưu `screenX`, `screenY`, `dpi`, dimensions và loại capture trong `captureInfo`.
2. Trả metadata này từ `capture`/`view_shot`.
3. Viết unit test cho chuyển đổi shot pixel → absolute screen, gồm origin âm.
4. Cập nhật README/tool descriptions.

### Milestone B — Crop theo shot

1. Thiết kế schema `capture_from_shot`.
2. Implement `fresh=false` qua edit pipeline hiện có.
3. Implement `fresh=true` chỉ cho shot có screen mapping; validation khi mapping không còn hợp lệ.
4. Test padding, clamp, origin âm, DPI 125% và crop từ client/window shot.

### Milestone C — Anchor + verify

1. Tái dùng matcher OCR trong `src/text.js` và crop resolver trong `src/edit.js`.
2. Implement `refine_capture`/`crop_anchor` và response `verified` có cấu trúc.
3. Test anchor trùng nhiều lần, OCR lỗi nhẹ, missing anchor, crop sát biên và verification fail.

### Milestone D — Hướng dẫn Agent và E2E

1. Cập nhật `src/instructions.js`, README và integration instructions.
2. Thêm E2E cho app/cửa sổ không phải terminal, 2 màn hình và content động.
3. Đo tỷ lệ Agent phải chụp lại/crop lỗi trên các kịch bản mẫu.

## Tiêu chí đánh giá

- Agent có thể đi từ ảnh tổng quan đến ảnh evidence gọn mà không tự tính offset màn hình.
- Mọi crop theo OCR đều trả tình trạng verification rõ ràng.
- Với desktop đa màn hình có origin âm, vùng chụp lại vẫn đúng sai số tối đa 1 px.
- Luồng GUI ưu tiên chụp cửa sổ cần thiết, không gửi toàn desktop nếu không cần.
- Không tự lưu evidence khi mục tiêu text bắt buộc không xuất hiện trong ảnh cuối.

## Quyết định khuyến nghị

Nên bắt đầu bằng Milestone A và B. Chúng xử lý lỗi toạ độ và giảm đáng kể số bước suy luận/công cụ Agent phải tự làm. Milestone C tạo độ tin cậy cho ảnh evidence. UI Automation hoặc model thị giác là hạng mục sau, vì tốn chi phí, phụ thuộc môi trường và không cần để giải quyết phần lớn tác vụ text-centric hiện tại.
