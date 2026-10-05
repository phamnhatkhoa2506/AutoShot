# AutoShot worker: a long-lived Windows PowerShell 5.1 process that hosts the compiled
# C# core (AutoShot.Native.cs) and Windows OCR. Protocol: one JSON object per line.
#   request : {"id": 1, "action": "capture_window", "params": {...}}
#   response: {"id": 1, "ok": true, "result": {...}}  |  {"id": 1, "ok": false, "error": "..."}
param([string]$CacheDir)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CacheDir) { $CacheDir = Join-Path $env:LOCALAPPDATA 'AutoShot\cache' }
$script:TempDir = Join-Path $CacheDir 'tmp'
New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null

$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

function Send-Message($obj) {
    $writer.WriteLine((ConvertTo-Json -InputObject $obj -Depth 12 -Compress))
}

function Get-ShortHash([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash($utf8.GetBytes($text))
    return ((($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16))
}

# Compile C# source once per content hash and reuse the cached binary afterwards.
function Get-CompiledBinary([string]$sourceFile, [string]$baseName, [string]$outputType, [string[]]$refs) {
    $src = [IO.File]::ReadAllText($sourceFile)
    $ext = if ($outputType -eq 'Library') { '.dll' } else { '.exe' }
    $target = Join-Path $CacheDir ($baseName + '.' + (Get-ShortHash $src) + $ext)
    if (-not (Test-Path -LiteralPath $target)) {
        $tmp = Join-Path $script:TempDir ($baseName + '.' + [guid]::NewGuid().ToString('N') + $ext)
        $params = @{ TypeDefinition = $src; OutputAssembly = $tmp; OutputType = $outputType; Language = 'CSharp' }
        if ($refs) { $params.ReferencedAssemblies = $refs }
        Add-Type @params
        try { Move-Item -LiteralPath $tmp -Destination $target -ErrorAction Stop }
        catch { if (-not (Test-Path -LiteralPath $target)) { throw } }
    }
    return $target
}

try {
    $nativeDll = Get-CompiledBinary (Join-Path $here 'AutoShot.Native.cs') 'AutoShot.Native' 'Library' @('System.Drawing', 'System.Windows.Forms')
    if (-not ('AutoShot.Native' -as [type])) { Add-Type -Path $nativeDll }
    $script:ConIO = Get-CompiledBinary (Join-Path $here 'ConIO.cs') 'ConIO' 'ConsoleApplication' $null
    $script:Dpi = [AutoShot.Native]::InitDpi()
}
catch {
    Send-Message @{ type = 'fatal'; error = ('Failed to build native core: ' + $_.Exception.Message) }
    exit 1
}

# ------------------------------------------------------------------ OCR (Windows.Media.Ocr)
$script:Ocr = $null

function Initialize-Ocr {
    if ($script:Ocr) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
        Select-Object -First 1
    $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    $engine = $null
    foreach ($tag in @($env:AUTOSHOT_OCR_LANG, 'en-US', 'en-GB')) {
        if ($tag -and ($langs -contains $tag)) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
            if ($engine) { break }
        }
    }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) { throw 'OCR_UNAVAILABLE: no Windows OCR language is installed (Settings > Time & language > Language & region > add English).' }
    $script:Ocr = @{
        engine    = $engine
        language  = $engine.RecognizerLanguage.LanguageTag
        available = $langs
        max       = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    }
}

function Wait-WinRt($operation, [Type]$type) {
    $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    return $task.Result
}

function Invoke-Ocr([string]$path, [double]$scale, [bool]$binarize) {
    Initialize-Ocr
    $size = [AutoShot.Native]::ImageSize($path)
    $longest = [Math]::Max($size[0], $size[1])
    if ($longest * $scale -gt $script:Ocr.max) { $scale = [Math]::Max(0.2, ($script:Ocr.max - 1) / $longest) }
    $prep = Join-Path $script:TempDir ('ocr_' + [guid]::NewGuid().ToString('N') + '.png')
    $inverted = [AutoShot.Native]::PrepareOcr($path, $prep, $scale, $binarize)
    try {
        $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($prep)) ([Windows.Storage.StorageFile])
        $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Wait-WinRt ($script:Ocr.engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $bitmap.Dispose()
        }
        finally { $stream.Dispose() }
    }
    finally { Remove-Item -LiteralPath $prep -Force -ErrorAction SilentlyContinue }

    $lines = New-Object System.Collections.ArrayList
    foreach ($ln in $result.Lines) {
        $words = New-Object System.Collections.ArrayList
        $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = -1.0; $y1 = -1.0
        foreach ($w in $ln.Words) {
            $r = $w.BoundingRect
            $wx = $r.X / $scale; $wy = $r.Y / $scale; $ww = $r.Width / $scale; $wh = $r.Height / $scale
            [void]$words.Add(@($w.Text, [int][Math]::Round($wx), [int][Math]::Round($wy), [int][Math]::Round($ww), [int][Math]::Round($wh)))
            $x0 = [Math]::Min($x0, $wx); $y0 = [Math]::Min($y0, $wy)
            $x1 = [Math]::Max($x1, $wx + $ww); $y1 = [Math]::Max($y1, $wy + $wh)
        }
        if ($words.Count -eq 0) { continue }
        [void]$lines.Add(@{
            t = $ln.Text
            b = @([int][Math]::Round($x0), [int][Math]::Round($y0), [int][Math]::Round($x1 - $x0), [int][Math]::Round($y1 - $y0))
            w = $words.ToArray()
        })
    }
    return @{ lines = $lines.ToArray(); language = $script:Ocr.language; inverted = $inverted; scale = $scale; width = $size[0]; height = $size[1] }
}

# ------------------------------------------------------------------ helpers
function Get-Param($p, [string]$name, $default) {
    if ($null -ne $p -and $p.PSObject.Properties[$name] -and $null -ne $p.$name) { return $p.$name }
    return $default
}

# Persistent ConIO.exe "serve" process; one request line -> one JSON response line (UTF-8).
$script:ConIOProc = $null

function Get-ConIOProcess {
    if ($script:ConIOProc -and -not $script:ConIOProc.HasExited) { return $script:ConIOProc }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:ConIO
    $psi.Arguments = 'serve'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.StandardOutputEncoding = $utf8
    $script:ConIOProc = [System.Diagnostics.Process]::Start($psi)
    return $script:ConIOProc
}

function Invoke-ConIO([string[]]$arguments) {
    $proc = Get-ConIOProcess
    # Arguments are ASCII only (numbers, chord names, base64), so the default stdin encoding is safe.
    $proc.StandardInput.WriteLine(($arguments -join ' '))
    $proc.StandardInput.Flush()
    $task = $proc.StandardOutput.ReadLineAsync()
    if (-not $task.Wait(20000)) {
        try { $proc.Kill() } catch { }
        $script:ConIOProc = $null
        throw 'CONSOLE_IO_TIMEOUT: console helper did not answer'
    }
    $out = $task.Result
    if (-not $out) { $script:ConIOProc = $null; throw 'CONSOLE_IO_FAILED: console helper exited' }
    return $out
}

function ConvertTo-ConIOSteps($steps) {
    $list = New-Object System.Collections.ArrayList
    foreach ($s in @($steps)) {
        if ($null -eq $s) { continue }
        $text = Get-Param $s 'text' $null
        if ($null -eq $text) { $text = Get-Param $s 'paste' $null }
        if ($null -ne $text) { [void]$list.Add('T:' + [Convert]::ToBase64String($utf8.GetBytes([string]$text))) }
        foreach ($k in @(Get-Param $s 'keys' @())) { if ($k) { [void]$list.Add('K:' + [string]$k) } }
        $sleep = [int](Get-Param $s 'sleep' 0)
        if ($sleep -gt 0) { [void]$list.Add('S:' + $sleep) }
    }
    return $list.ToArray()
}

function Invoke-InputSteps([long]$handle, $steps, [bool]$restoreFocus) {
    $prev = [AutoShot.Native]::Foreground()
    $focus = 'skipped'
    if ($handle -ne 0) {
        $focus = [AutoShot.Native]::Focus($handle)
        if ($focus -eq 'failed') {
            throw 'FOCUS_FAILED: Windows blocked bringing the window to the foreground. Ask the user to click the target window once, then retry.'
        }
        Start-Sleep -Milliseconds 60
    }
    $typed = 0
    foreach ($s in @($steps)) {
        if ($null -eq $s) { continue }
        $text = Get-Param $s 'text' $null
        $paste = Get-Param $s 'paste' $null
        $keys = Get-Param $s 'keys' $null
        $sleep = [int](Get-Param $s 'sleep' 0)
        if ($null -ne $text) { $typed += [AutoShot.Native]::TypeText([string]$text, 48, 8) }
        if ($null -ne $paste) {
            $old = [AutoShot.Native]::GetClipboardText()
            [AutoShot.Native]::SetClipboardText([string]$paste)
            Start-Sleep -Milliseconds 60
            [AutoShot.Native]::SendChord([string](Get-Param $s 'chord' 'shift+insert'))
            Start-Sleep -Milliseconds 300
            if ($null -ne $old) { [AutoShot.Native]::SetClipboardText($old) }
            $typed += ([string]$paste).Length
        }
        foreach ($k in @($keys)) {
            if ($k) { [AutoShot.Native]::SendChord([string]$k); Start-Sleep -Milliseconds 30 }
        }
        if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
    }
    if ($restoreFocus -and $prev -ne 0 -and $prev -ne $handle) {
        Start-Sleep -Milliseconds 80
        try { [void][AutoShot.Native]::Focus($prev) } catch { }
    }
    return @{ typed = $typed; focus = $focus }
}

# ------------------------------------------------------------------ actions
$H = @{}
$H['ping'] = { param($p) @{ pong = $true } }
$H['info'] = { param($p)
    $ocr = $null
    try { Initialize-Ocr; $ocr = @{ language = $script:Ocr.language; available = $script:Ocr.available; max = $script:Ocr.max } }
    catch { $ocr = @{ error = $_.Exception.Message } }
    @{
        dpi     = $script:Dpi
        ps      = $PSVersionTable.PSVersion.ToString()
        os      = [Environment]::OSVersion.VersionString
        screens = [AutoShot.Native]::Screens()
        ocr     = $ocr
        conio   = $script:ConIO
        cache   = $CacheDir
    }
}
$H['list_windows'] = { param($p) @{ windows = [AutoShot.Native]::ListWindows([bool](Get-Param $p 'includeAll' $false)) } }
$H['describe'] = { param($p) @{ window = [AutoShot.Native]::Describe([long]$p.handle) } }
$H['alive'] = { param($p) @{ alive = [AutoShot.Native]::Alive([long]$p.handle) } }
$H['foreground'] = { param($p) @{ handle = [AutoShot.Native]::Foreground() } }
$H['focus'] = { param($p) @{ method = [AutoShot.Native]::Focus([long]$p.handle) } }
$H['move'] = { param($p)
    $x = Get-Param $p 'x' $null; $y = Get-Param $p 'y' $null
    $xi = if ($null -eq $x) { [int]::MinValue } else { [int]$x }
    $yi = if ($null -eq $y) { [int]::MinValue } else { [int]$y }
    [AutoShot.Native]::MoveWindow([long]$p.handle, $xi, $yi, [int](Get-Param $p 'width' 0), [int](Get-Param $p 'height' 0))
    Start-Sleep -Milliseconds 120
    @{ window = [AutoShot.Native]::Describe([long]$p.handle) }
}
$H['close'] = { param($p) [AutoShot.Native]::CloseWindow([long]$p.handle); @{ ok = $true } }
$H['launch'] = { param($p) @{ pid = [AutoShot.Native]::Launch([string]$p.exe, [string](Get-Param $p 'args' ''), [string](Get-Param $p 'cwd' '')) } }
$H['find_process'] = { param($p)
    $name = [string]$p.name
    $marker = [string](Get-Param $p 'marker' '')
    $after = [long](Get-Param $p 'afterMs' 0)
    $procs = @(Get-CimInstance Win32_Process -Filter ("Name='" + $name.Replace("'", "''") + "'"))
    $hit = $null
    if ($marker) { $hit = $procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) } | Select-Object -First 1 }
    if (-not $hit -and $after -gt 0) {
        $afterDt = [DateTimeOffset]::FromUnixTimeMilliseconds($after).LocalDateTime.AddSeconds(-2)
        $hit = $procs | Where-Object { $_.CreationDate -ge $afterDt } | Sort-Object CreationDate -Descending | Select-Object -First 1
    }
    if ($hit) { @{ pid = [int]$hit.ProcessId; parent = [int]$hit.ParentProcessId } } else { @{ pid = 0 } }
}
$H['children'] = { param($p)
    $list = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + [int]$p.pid) | ForEach-Object { @{ pid = [int]$_.ProcessId; name = [string]$_.Name } })
    @{ children = $list }
}
$H['input'] = { param($p) Invoke-InputSteps ([long](Get-Param $p 'handle' 0)) (Get-Param $p 'steps' @()) ([bool](Get-Param $p 'restoreFocus' $false)) }
# Keystrokes straight into a console's input buffer: no focus, no IME, works inside ssh.
$H['console_input'] = { param($p)
    $steps = ConvertTo-ConIOSteps (Get-Param $p 'steps' @())
    $raw = Invoke-ConIO (@('write', [string][int]$p.pid) + $steps)
    $res = ConvertFrom-Json -InputObject $raw
    if (-not $res.ok) { throw ('CONSOLE_INPUT_FAILED: ' + $res.error) }
    @{ typed = [int]$res.typed; method = 'console-buffer' }
}
$H['capture_window'] = { param($p)
    @{ capture = [AutoShot.Native]::CaptureWindow([long]$p.handle, [string](Get-Param $p 'area' 'window'), [string](Get-Param $p 'method' 'auto'), [string]$p.out) }
}
$H['capture_rect'] = { param($p) @{ capture = [AutoShot.Native]::CaptureRect([int]$p.x, [int]$p.y, [int]$p.width, [int]$p.height, [string]$p.out) } }
$H['capture_screen'] = { param($p) @{ capture = [AutoShot.Native]::CaptureScreen([int](Get-Param $p 'index' 0), [string]$p.out) } }
$H['screens'] = { param($p) @{ screens = [AutoShot.Native]::Screens() } }
$H['probe'] = { param($p) @{ changed = [AutoShot.Native]::ProbeChange([long]$p.handle, [string]$p.key, [int](Get-Param $p 'threshold' 10)) } }
$H['probe_reset'] = { param($p) [AutoShot.Native]::ProbeReset([string]$p.key); @{ ok = $true } }
$H['console_read'] = { param($p)
    @{ raw = (Invoke-ConIO @('read', [string][int]$p.pid, [string][int](Get-Param $p 'extra' 0))) }
}
$H['ocr'] = { param($p) @{ ocr = (Invoke-Ocr ([string]$p.path) ([double](Get-Param $p 'scale' 2.0)) ([bool](Get-Param $p 'binarize' $true))) } }
$H['image_size'] = { param($p) @{ size = [AutoShot.Native]::ImageSize([string]$p.path) } }
$H['content_bounds'] = { param($p) @{ bounds = [AutoShot.Native]::ContentBoundsOf([string]$p.path, [int](Get-Param $p 'tolerance' 24)) } }
$H['row_extent'] = { param($p) @{ extent = [AutoShot.Native]::RowExtent([string]$p.path, [int]$p.y, [int]$p.x, [int](Get-Param $p 'tolerance' 18)) } }
$H['preview'] = { param($p)
    @{ scale = [AutoShot.Native]::MakePreview([string]$p.src, [string]$p.dst, [int](Get-Param $p 'maxWidth' 1280), [int](Get-Param $p 'maxHeight' 1280), [bool](Get-Param $p 'grid' $false)) }
}
$H['edit'] = { param($p)
    $t = Get-Param $p 'transform' $null
    $ed = New-Object AutoShot.ImageEditor([string]$p.src, [double](Get-Param $t 's' 1), [double](Get-Param $t 'tx' 0), [double](Get-Param $t 'ty' 0))
    try {
        foreach ($op in @($p.ops)) {
            switch ([string]$op.op) {
                'crop' { $ed.Crop([int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h) }
                'trim' { $ed.Trim([int](Get-Param $op 'tolerance' 24), [int](Get-Param $op 'padding' 10)) }
                'pad' { $ed.Pad([int]$op.top, [int]$op.right, [int]$op.bottom, [int]$op.left, [string](Get-Param $op 'color' '#FFFFFF')) }
                'scale' { $ed.Scale([double]$op.factor) }
                'box' { $ed.Box([int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h, [string](Get-Param $op 'color' ''), [single](Get-Param $op 'thickness' 3), [single](Get-Param $op 'radius' 4)) }
                'highlight' { $ed.Highlight([int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h, [string](Get-Param $op 'color' ''), [double](Get-Param $op 'opacity' 0.35)) }
                'redact' { $ed.Redact([int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h, [string](Get-Param $op 'style' 'pixelate'), [string](Get-Param $op 'color' '#000000')) }
                'arrow' { $ed.Arrow([int]$op.x1, [int]$op.y1, [int]$op.x2, [int]$op.y2, [string](Get-Param $op 'color' ''), [single](Get-Param $op 'thickness' 4)) }
                'label' { $ed.Label([string]$op.text, [int]$op.x, [int]$op.y, [string](Get-Param $op 'color' ''), [string](Get-Param $op 'bg' ''), [single](Get-Param $op 'size' 15), [string](Get-Param $op 'anchor' 'tl')) }
                'badge' { $ed.Badge([string]$op.text, [int]$op.x, [int]$op.y, [string](Get-Param $op 'color' ''), [single](Get-Param $op 'size' 26)) }
                'frame' { $ed.Frame([int](Get-Param $op 'margin' 24), [string](Get-Param $op 'bg' '#FFFFFF'), [bool](Get-Param $op 'shadow' $true), [single](Get-Param $op 'radius' 8)) }
                'prepend' { $ed.PrependRegion([string]$op.src, [int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h) }
                default { throw ("Unknown edit op '" + $op.op + "'") }
            }
        }
        @{ result = $ed.Save([string]$p.dst) }
    }
    finally { $ed.Dispose() }
}

# ------------------------------------------------------------------ main loop
Send-Message @{ type = 'ready'; dpi = $script:Dpi; pid = $PID; native = $nativeDll }
while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        $handler = $H[[string]$req.action]
        if (-not $handler) { throw ("Unknown action '" + $req.action + "'") }
        $result = & $handler $req.params
        if ($result -is [array]) { $result = $result[-1] }
        Send-Message @{ id = $id; ok = $true; result = $result }
    }
    catch {
        $e = $_.Exception
        while ($e.InnerException -and ($e -is [System.Management.Automation.MethodInvocationException] -or $e -is [System.Reflection.TargetInvocationException] -or $e -is [System.AggregateException])) {
            $e = $e.InnerException
        }
        Send-Message @{ id = $id; ok = $false; error = $e.Message }
    }
}
