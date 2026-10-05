// AutoShot native core. Compiled once by worker.ps1 (Add-Type, C# 5 / .NET Framework 4.x)
// and cached as a DLL. Keep to C# 5 syntax: no string interpolation, no ?. , no out var.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AutoShot
{
    public class WindowInfo
    {
        public long Handle { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
        public int Pid { get; set; }
        public string Process { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int ClientX { get; set; }
        public int ClientY { get; set; }
        public int ClientWidth { get; set; }
        public int ClientHeight { get; set; }
        public int Dpi { get; set; }
        public bool Minimized { get; set; }
        public bool Foreground { get; set; }
    }

    public class CaptureResult
    {
        public string Path { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public string Method { get; set; }
        public int ScreenX { get; set; }
        public int ScreenY { get; set; }
        public int ClientX { get; set; }
        public int ClientY { get; set; }
        public int ClientWidth { get; set; }
        public int ClientHeight { get; set; }
        public int Dpi { get; set; }
    }

    public class ScreenInfo
    {
        public int Index { get; set; }
        public string Name { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Primary { get; set; }
    }

    public class EditResult
    {
        public int Width { get; set; }
        public int Height { get; set; }
        public double S { get; set; }
        public double Tx { get; set; }
        public double Ty { get; set; }
    }

    public static class Native
    {
        // ---------------------------------------------------------------- interop
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion U; }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern short VkKeyScan(char c);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

        const uint GW_OWNER = 4;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        const int DWMWA_CLOAKED = 14;
        const int SW_RESTORE = 9;
        const uint PW_RENDERFULLCONTENT = 2;
        const uint WM_CLOSE = 0x0010;
        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_EXTENDEDKEY = 0x1;
        const uint KEYEVENTF_KEYUP = 0x2;
        const uint KEYEVENTF_UNICODE = 0x4;
        const uint MOUSEEVENTF_MOVE = 0x1;
        const uint SWP_NOZORDER = 0x4;
        const uint SWP_NOACTIVATE = 0x10;

        static string dpiMode;

        public static string InitDpi()
        {
            if (dpiMode != null) return dpiMode;
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { dpiMode = "per-monitor-v2"; return dpiMode; }
            }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); dpiMode = "system"; } catch { dpiMode = "unaware"; }
            return dpiMode;
        }

        // ---------------------------------------------------------------- windows
        static readonly Dictionary<uint, string> processNames = new Dictionary<uint, string>();

        static string ProcessName(uint pid)
        {
            string name;
            if (processNames.TryGetValue(pid, out name)) return name;
            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
            catch { name = ""; }
            processNames[pid] = name;
            return name;
        }

        public static RECT FrameBounds(IntPtr h)
        {
            RECT r;
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0 || r.Right <= r.Left)
            {
                GetWindowRect(h, out r);
            }
            return r;
        }

        public static WindowInfo Describe(long handle)
        {
            IntPtr h = new IntPtr(handle);
            if (!IsWindow(h)) throw new ArgumentException("Window " + handle + " no longer exists");
            return DescribeInternal(h, GetForegroundWindow());
        }

        static WindowInfo DescribeInternal(IntPtr h, IntPtr fg)
        {
            var info = new WindowInfo();
            info.Handle = h.ToInt64();
            int len = GetWindowTextLength(h);
            var sb = new StringBuilder(Math.Max(len + 1, 2));
            GetWindowText(h, sb, sb.Capacity);
            info.Title = sb.ToString();
            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            info.ClassName = cls.ToString();
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            info.Pid = (int)pid;
            info.Process = ProcessName(pid);
            RECT fr = FrameBounds(h);
            info.X = fr.Left; info.Y = fr.Top;
            info.Width = fr.Right - fr.Left; info.Height = fr.Bottom - fr.Top;
            RECT cr;
            GetClientRect(h, out cr);
            var p = new POINT();
            ClientToScreen(h, ref p);
            info.ClientX = p.X - fr.Left; info.ClientY = p.Y - fr.Top;
            info.ClientWidth = cr.Right - cr.Left; info.ClientHeight = cr.Bottom - cr.Top;
            try { info.Dpi = (int)GetDpiForWindow(h); } catch { info.Dpi = 96; }
            info.Minimized = IsIconic(h);
            info.Foreground = h == fg;
            return info;
        }

        public static WindowInfo[] ListWindows(bool includeAll)
        {
            var list = new List<WindowInfo>();
            IntPtr fg = GetForegroundWindow();
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h)) return true;
                if (!includeAll)
                {
                    if (GetWindowTextLength(h) == 0) return true;
                    if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
                    if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
                    int cloaked;
                    if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                }
                list.Add(DescribeInternal(h, fg));
                return true;
            }, IntPtr.Zero);
            return list.ToArray();
        }

        public static long Foreground() { return GetForegroundWindow().ToInt64(); }

        public static bool Alive(long handle) { return IsWindow(new IntPtr(handle)); }

        static bool WaitForeground(IntPtr h, int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                if (GetForegroundWindow() == h) return true;
                Thread.Sleep(15);
            }
            return GetForegroundWindow() == h;
        }

        // Windows refuses SetForegroundWindow from background processes; escalate
        // through progressively stronger (but still well-behaved) techniques.
        public static string Focus(long handle)
        {
            IntPtr h = new IntPtr(handle);
            if (!IsWindow(h)) throw new ArgumentException("Window " + handle + " no longer exists");
            if (IsIconic(h)) { ShowWindow(h, SW_RESTORE); Thread.Sleep(250); }
            if (GetForegroundWindow() == h) return "already";

            SetForegroundWindow(h);
            if (WaitForeground(h, 120)) return "direct";

            SendZeroMouseMove();
            SetForegroundWindow(h);
            if (WaitForeground(h, 120)) return "input";

            uint dummy;
            IntPtr fg = GetForegroundWindow();
            uint fgThread = GetWindowThreadProcessId(fg, out dummy);
            uint me = GetCurrentThreadId();
            if (fgThread != 0 && fgThread != me)
            {
                AttachThreadInput(me, fgThread, true);
                BringWindowToTop(h);
                SetForegroundWindow(h);
                AttachThreadInput(me, fgThread, false);
                if (WaitForeground(h, 200)) return "attach-thread";
            }

            TapKey(0x12); // Alt
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (WaitForeground(h, 250)) return "alt";
            return "failed";
        }

        public static void MoveWindow(long handle, int x, int y, int w, int h)
        {
            IntPtr hw = new IntPtr(handle);
            if (IsIconic(hw)) { ShowWindow(hw, SW_RESTORE); Thread.Sleep(200); }
            RECT fr = FrameBounds(hw);
            RECT wr;
            GetWindowRect(hw, out wr);
            // Callers think in visible-frame coordinates; compensate the invisible resize borders.
            int dl = fr.Left - wr.Left, dt = fr.Top - wr.Top, dr = wr.Right - fr.Right, db = wr.Bottom - fr.Bottom;
            int nx = x == int.MinValue ? fr.Left : x;
            int ny = y == int.MinValue ? fr.Top : y;
            int nw = w <= 0 ? fr.Right - fr.Left : w;
            int nh = h <= 0 ? fr.Bottom - fr.Top : h;
            SetWindowPos(hw, IntPtr.Zero, nx - dl, ny - dt, nw + dl + dr, nh + dt + db, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        public static void CloseWindow(long handle)
        {
            PostMessage(new IntPtr(handle), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }

        public static int Launch(string exe, string args, string cwd)
        {
            var psi = new ProcessStartInfo(exe, args ?? "");
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Normal;
            if (!string.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;
            var p = System.Diagnostics.Process.Start(psi);
            if (p == null) return 0;
            try { return p.Id; } catch { return 0; }
        }

        // ---------------------------------------------------------------- input
        static INPUT KeyInput(ushort vk, ushort scan, uint flags)
        {
            var i = new INPUT();
            i.type = INPUT_KEYBOARD;
            i.U.ki.wVk = vk;
            i.U.ki.wScan = scan;
            i.U.ki.dwFlags = flags;
            return i;
        }

        static void Send(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Count) throw new InvalidOperationException("SendInput was blocked (sent " + sent + "/" + inputs.Count + "). Is an elevated window in the foreground?");
        }

        static void SendZeroMouseMove()
        {
            var i = new INPUT();
            i.type = INPUT_MOUSE;
            i.U.mi.dwFlags = MOUSEEVENTF_MOVE;
            SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
        }

        static bool IsExtended(ushort vk)
        {
            switch (vk)
            {
                case 0x21: case 0x22: case 0x23: case 0x24: // pgup pgdn end home
                case 0x25: case 0x26: case 0x27: case 0x28: // arrows
                case 0x2D: case 0x2E: // insert delete
                case 0x5B: case 0x5C: // win
                    return true;
            }
            return false;
        }

        static void AddVk(List<INPUT> list, ushort vk, bool up)
        {
            uint flags = up ? KEYEVENTF_KEYUP : 0;
            if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            list.Add(KeyInput(vk, (ushort)MapVirtualKey(vk, 0), flags));
        }

        static void TapKey(ushort vk)
        {
            var list = new List<INPUT>();
            AddVk(list, vk, false);
            AddVk(list, vk, true);
            Send(list);
        }

        // Unicode injection (VK_PACKET) bypasses keyboard layouts and IMEs such as
        // Vietnamese Telex, so "whoami" never turns into "ưhoami".
        public static int TypeText(string text, int chunkChars, int delayMs)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            if (chunkChars <= 0) chunkChars = 48;
            var batch = new List<INPUT>();
            int count = 0, inChunk = 0;
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n') { AddVk(batch, 0x0D, false); AddVk(batch, 0x0D, true); }
                else if (c == '\t') { AddVk(batch, 0x09, false); AddVk(batch, 0x09, true); }
                else
                {
                    batch.Add(KeyInput(0, c, KEYEVENTF_UNICODE));
                    batch.Add(KeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
                count++;
                inChunk++;
                if (inChunk >= chunkChars)
                {
                    Send(batch);
                    batch.Clear();
                    inChunk = 0;
                    if (delayMs > 0) Thread.Sleep(delayMs);
                }
            }
            Send(batch);
            return count;
        }

        static ushort NamedKey(string name)
        {
            switch (name)
            {
                case "enter": case "return": return 0x0D;
                case "tab": return 0x09;
                case "esc": case "escape": return 0x1B;
                case "space": return 0x20;
                case "backspace": case "bs": return 0x08;
                case "delete": case "del": return 0x2E;
                case "insert": case "ins": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": case "pgup": return 0x21;
                case "pagedown": case "pgdn": return 0x22;
                case "up": return 0x26;
                case "down": return 0x28;
                case "left": return 0x25;
                case "right": return 0x27;
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": return 0x12;
                case "win": case "meta": case "cmd": return 0x5B;
            }
            if (name.Length >= 2 && name[0] == 'f')
            {
                int n;
                if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
            }
            return 0;
        }

        // chord examples: "enter", "ctrl+c", "shift+insert", "ctrl+shift+t", "y", "alt+f4"
        public static void SendChord(string chord)
        {
            if (string.IsNullOrEmpty(chord)) return;
            string[] parts = chord.ToLowerInvariant().Split('+');
            var mods = new List<ushort>();
            ushort key = 0;
            bool keyShift = false;
            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i].Trim();
                if (p.Length == 0 && i == parts.Length - 1) p = "+";
                ushort vk = NamedKey(p);
                bool isLast = i == parts.Length - 1;
                if (!isLast)
                {
                    if (vk == 0) throw new ArgumentException("Unknown modifier '" + p + "' in chord '" + chord + "'");
                    mods.Add(vk);
                    continue;
                }
                if (vk != 0) { key = vk; continue; }
                if (p.Length == 1)
                {
                    short scan = VkKeyScan(p[0]);
                    if (scan == -1) throw new ArgumentException("Cannot map key '" + p + "'");
                    key = (ushort)(scan & 0xFF);
                    keyShift = (scan & 0x100) != 0;
                    continue;
                }
                throw new ArgumentException("Unknown key '" + p + "' in chord '" + chord + "'");
            }
            if (keyShift && !mods.Contains(0x10)) mods.Add(0x10);
            var list = new List<INPUT>();
            foreach (var m in mods) AddVk(list, m, false);
            AddVk(list, key, false);
            AddVk(list, key, true);
            for (int i = mods.Count - 1; i >= 0; i--) AddVk(list, mods[i], true);
            Send(list);
        }

        static void RunSta(ThreadStart fn)
        {
            Exception err = null;
            var t = new Thread(delegate()
            {
                try { fn(); } catch (Exception e) { err = e; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            if (err != null) throw err;
        }

        public static void SetClipboardText(string text)
        {
            RunSta(delegate { Clipboard.SetDataObject(text, true, 10, 50); });
        }

        public static string GetClipboardText()
        {
            string r = null;
            RunSta(delegate
            {
                try { if (Clipboard.ContainsText()) r = Clipboard.GetText(); } catch { r = null; }
            });
            return r;
        }

        // ---------------------------------------------------------------- capture
        static Bitmap PrintWindowBitmap(IntPtr h)
        {
            RECT wr;
            if (!GetWindowRect(h, out wr)) return null;
            int w = wr.Right - wr.Left, hh = wr.Bottom - wr.Top;
            if (w <= 0 || hh <= 0) return null;
            var bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
            bool ok;
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
            }
            if (!ok) { bmp.Dispose(); return null; }
            RECT fr = FrameBounds(h);
            var crop = new Rectangle(fr.Left - wr.Left, fr.Top - wr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top);
            crop.Intersect(new Rectangle(0, 0, w, hh));
            if (crop.Width <= 0 || crop.Height <= 0 || (crop.Width == w && crop.Height == hh)) return bmp;
            Bitmap c = bmp.Clone(crop, PixelFormat.Format24bppRgb);
            bmp.Dispose();
            return c;
        }

        static Bitmap ScreenBitmap(int x, int y, int w, int h)
        {
            var bmp = new Bitmap(Math.Max(1, w), Math.Max(1, h), PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            return bmp;
        }

        static bool IsUniform(Bitmap bmp)
        {
            int stepX = Math.Max(1, bmp.Width / 40), stepY = Math.Max(1, bmp.Height / 40);
            Color first = bmp.GetPixel(0, 0);
            for (int y = 0; y < bmp.Height; y += stepY)
                for (int x = 0; x < bmp.Width; x += stepX)
                    if (bmp.GetPixel(x, y).ToArgb() != first.ToArgb()) return false;
            return true;
        }

        static void EnsureDir(string path)
        {
            string dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        }

        public static void SavePng(Bitmap bmp, string path)
        {
            EnsureDir(path);
            string tmp = path + ".tmp";
            bmp.Save(tmp, ImageFormat.Png);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        // method: auto (PrintWindow, falls back to screen copy), print, screen
        // area: window (visible frame incl. title bar) or client
        public static CaptureResult CaptureWindow(long handle, string area, string method, string outPath)
        {
            IntPtr h = new IntPtr(handle);
            if (!IsWindow(h)) throw new ArgumentException("Window " + handle + " no longer exists");
            if (IsIconic(h)) { ShowWindow(h, SW_RESTORE); Thread.Sleep(300); }
            RECT fr = FrameBounds(h);
            Bitmap bmp = null;
            string used = null;
            if (method != "screen")
            {
                bmp = PrintWindowBitmap(h);
                if (bmp != null && IsUniform(bmp)) { bmp.Dispose(); bmp = null; }
                if (bmp != null) used = "printwindow";
            }
            if (bmp == null)
            {
                if (method == "print") throw new InvalidOperationException("PrintWindow could not render this window");
                Focus(handle);
                Thread.Sleep(150);
                fr = FrameBounds(h);
                bmp = ScreenBitmap(fr.Left, fr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top);
                used = "screen";
            }
            WindowInfo info = DescribeInternal(h, GetForegroundWindow());
            var res = new CaptureResult();
            res.Method = used;
            res.ScreenX = fr.Left; res.ScreenY = fr.Top;
            res.ClientX = info.ClientX; res.ClientY = info.ClientY;
            res.ClientWidth = info.ClientWidth; res.ClientHeight = info.ClientHeight;
            res.Dpi = info.Dpi;
            if (area == "client")
            {
                var cr = new Rectangle(info.ClientX, info.ClientY, info.ClientWidth, info.ClientHeight);
                cr.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
                if (cr.Width > 0 && cr.Height > 0)
                {
                    Bitmap c = bmp.Clone(cr, PixelFormat.Format24bppRgb);
                    bmp.Dispose();
                    bmp = c;
                    res.ScreenX += cr.X; res.ScreenY += cr.Y;
                    res.ClientX = 0; res.ClientY = 0;
                }
            }
            res.Width = bmp.Width; res.Height = bmp.Height;
            SavePng(bmp, outPath);
            bmp.Dispose();
            res.Path = outPath;
            return res;
        }

        public static CaptureResult CaptureRect(int x, int y, int w, int h, string outPath)
        {
            if (w <= 0 || h <= 0) throw new ArgumentException("Region width/height must be positive");
            using (var bmp = ScreenBitmap(x, y, w, h))
            {
                SavePng(bmp, outPath);
            }
            var r = new CaptureResult();
            r.Path = outPath; r.Width = w; r.Height = h; r.Method = "screen"; r.ScreenX = x; r.ScreenY = y;
            r.ClientWidth = w; r.ClientHeight = h; r.Dpi = 96;
            return r;
        }

        public static ScreenInfo[] Screens()
        {
            var screens = Screen.AllScreens;
            var list = new ScreenInfo[screens.Length];
            for (int i = 0; i < screens.Length; i++)
            {
                var s = new ScreenInfo();
                s.Index = i; s.Name = screens[i].DeviceName; s.Primary = screens[i].Primary;
                s.X = screens[i].Bounds.X; s.Y = screens[i].Bounds.Y;
                s.Width = screens[i].Bounds.Width; s.Height = screens[i].Bounds.Height;
                list[i] = s;
            }
            return list;
        }

        // index -1 = the whole virtual desktop (all monitors)
        public static CaptureResult CaptureScreen(int index, string outPath)
        {
            Rectangle b;
            if (index < 0) b = SystemInformation.VirtualScreen;
            else
            {
                var screens = Screen.AllScreens;
                if (index >= screens.Length) throw new ArgumentException("Monitor index " + index + " out of range (0.." + (screens.Length - 1) + ")");
                b = screens[index].Bounds;
            }
            return CaptureRect(b.X, b.Y, b.Width, b.Height, outPath);
        }

        // ---------------------------------------------------------------- change detection
        static readonly Dictionary<string, byte[]> probes = new Dictionary<string, byte[]>();

        static byte[] Signature(Bitmap src, int gw, int gh)
        {
            using (var small = new Bitmap(gw, gh, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(small))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(src, new Rectangle(0, 0, gw, gh));
                }
                var sig = new byte[gw * gh];
                var data = small.LockBits(new Rectangle(0, 0, gw, gh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    var row = new byte[data.Stride];
                    for (int y = 0; y < gh; y++)
                    {
                        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, data.Stride);
                        for (int x = 0; x < gw; x++)
                        {
                            int o = x * 3;
                            sig[y * gw + x] = (byte)((row[o] * 29 + row[o + 1] * 150 + row[o + 2] * 77) >> 8);
                        }
                    }
                }
                finally { small.UnlockBits(data); }
                return sig;
            }
        }

        // Returns how many cells of a 96x54 luminance grid changed since the previous probe
        // with the same key (-1 on the first probe). Uses PrintWindow so the window does not
        // need to be visible or focused.
        public static int ProbeChange(long handle, string key, int threshold)
        {
            IntPtr h = new IntPtr(handle);
            if (!IsWindow(h)) throw new ArgumentException("Window " + handle + " no longer exists");
            Bitmap bmp = PrintWindowBitmap(h);
            if (bmp == null || IsUniform(bmp))
            {
                if (bmp != null) bmp.Dispose();
                RECT fr = FrameBounds(h);
                bmp = ScreenBitmap(fr.Left, fr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top);
            }
            byte[] sig;
            using (bmp) { sig = Signature(bmp, 96, 54); }
            byte[] prev;
            int changed = -1;
            if (probes.TryGetValue(key, out prev) && prev.Length == sig.Length)
            {
                changed = 0;
                for (int i = 0; i < sig.Length; i++) if (Math.Abs(sig[i] - prev[i]) > threshold) changed++;
            }
            probes[key] = sig;
            return changed;
        }

        public static void ProbeReset(string key) { probes.Remove(key); }

        // ---------------------------------------------------------------- image helpers
        public static Bitmap LoadBitmap(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var img = Image.FromStream(fs))
            {
                var b = new Bitmap(img.Width, img.Height, PixelFormat.Format24bppRgb);
                b.SetResolution(96, 96);
                using (var g = Graphics.FromImage(b))
                {
                    g.DrawImage(img, new Rectangle(0, 0, img.Width, img.Height));
                }
                return b;
            }
        }

        public static int[] ImageSize(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var img = Image.FromStream(fs, false, false))
            {
                return new int[] { img.Width, img.Height };
            }
        }

        public static Color ParseColor(string s, Color fallback)
        {
            if (string.IsNullOrEmpty(s)) return fallback;
            try
            {
                s = s.Trim();
                if (s.StartsWith("#") && s.Length == 9)
                {
                    int r = Convert.ToInt32(s.Substring(1, 2), 16), g = Convert.ToInt32(s.Substring(3, 2), 16);
                    int b = Convert.ToInt32(s.Substring(5, 2), 16), a = Convert.ToInt32(s.Substring(7, 2), 16);
                    return Color.FromArgb(a, r, g, b);
                }
                return ColorTranslator.FromHtml(s);
            }
            catch { return fallback; }
        }

        internal static byte[] ReadPixels(Bitmap bmp, out int stride)
        {
            var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                stride = data.Stride;
                var buf = new byte[data.Stride * bmp.Height];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                return buf;
            }
            finally { bmp.UnlockBits(data); }
        }

        static int Diff(byte[] px, int a, int b)
        {
            return Math.Abs(px[a] - px[b]) + Math.Abs(px[a + 1] - px[b + 1]) + Math.Abs(px[a + 2] - px[b + 2]);
        }

        // Bounding box {x,y,w,h} of everything that differs from the dominant border colour.
        internal static int[] ContentBounds(Bitmap bmp, int tol)
        {
            int stride;
            byte[] px = ReadPixels(bmp, out stride);
            int w = bmp.Width, h = bmp.Height;
            var counts = new Dictionary<int, int>();
            var sample = new Dictionary<int, int>();
            Action<int, int> vote = delegate(int x, int y)
            {
                int o = y * stride + x * 3;
                int key = ((px[o + 2] >> 3) << 10) | ((px[o + 1] >> 3) << 5) | (px[o] >> 3);
                int c;
                counts.TryGetValue(key, out c);
                counts[key] = c + 1;
                if (!sample.ContainsKey(key)) sample[key] = o;
            };
            for (int x = 0; x < w; x += Math.Max(1, w / 200)) { vote(x, 0); vote(x, h - 1); }
            for (int y = 0; y < h; y += Math.Max(1, h / 200)) { vote(0, y); vote(w - 1, y); }
            int bestKey = 0, best = -1;
            foreach (var kv in counts) if (kv.Value > best) { best = kv.Value; bestKey = kv.Key; }
            int bg = sample[bestKey];
            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int ro = y * stride;
                for (int x = 0; x < w; x++)
                {
                    if (Diff(px, ro + x * 3, bg) > tol)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return null;
            return new int[] { minX, minY, maxX - minX + 1, maxY - minY + 1 };
        }

        public static int[] ContentBoundsOf(string path, int tol)
        {
            using (var bmp = LoadBitmap(path)) { return ContentBounds(bmp, tol); }
        }

        // Horizontal extent of the uniform background run that contains (seedX, y):
        // used to find the terminal pane inside apps with sidebars (MobaXterm etc.).
        public static int[] RowExtent(string path, int y, int seedX, int tol)
        {
            using (var bmp = LoadBitmap(path))
            {
                int stride;
                byte[] px = ReadPixels(bmp, out stride);
                y = Math.Max(0, Math.Min(bmp.Height - 1, y));
                seedX = Math.Max(0, Math.Min(bmp.Width - 1, seedX));
                int ro = y * stride, seed = ro + seedX * 3;
                int left = seedX, right = seedX;
                while (left > 0 && Diff(px, ro + (left - 1) * 3, seed) <= tol) left--;
                while (right < bmp.Width - 1 && Diff(px, ro + (right + 1) * 3, seed) <= tol) right++;
                return new int[] { left, right };
            }
        }

        // Otsu threshold over a grayscale 24bpp bitmap: every pixel becomes black or white.
        // Coloured / dim text (syntax highlighting, prompts) otherwise often gets skipped by OCR.
        static void Binarize(Bitmap bmp)
        {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
            try
            {
                var buf = new byte[data.Stride * bmp.Height];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                var hist = new long[256];
                for (int y = 0; y < bmp.Height; y++)
                {
                    int ro = y * data.Stride;
                    for (int x = 0; x < bmp.Width; x++) hist[buf[ro + x * 3]]++;
                }
                long total = (long)bmp.Width * bmp.Height, sumAll = 0;
                for (int i = 0; i < 256; i++) sumAll += i * hist[i];
                long wB = 0, sumB = 0;
                double best = -1;
                int thr = 128;
                for (int t = 0; t < 256; t++)
                {
                    wB += hist[t];
                    if (wB == 0) continue;
                    long wF = total - wB;
                    if (wF == 0) break;
                    sumB += t * hist[t];
                    double mB = (double)sumB / wB, mF = (double)(sumAll - sumB) / wF;
                    double between = (double)wB * wF * (mB - mF) * (mB - mF);
                    if (between > best) { best = between; thr = t; }
                }
                // bias towards keeping faint strokes as ink
                thr = Math.Min(250, thr + 12);
                for (int y = 0; y < bmp.Height; y++)
                {
                    int ro = y * data.Stride;
                    for (int x = 0; x < bmp.Width; x++)
                    {
                        int o = ro + x * 3;
                        byte v = buf[o] <= thr ? (byte)0 : (byte)255;
                        buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
                    }
                }
                Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            }
            finally { bmp.UnlockBits(data); }
        }

        // Upscale + grayscale (+ invert dark themes, + optional binarize) so Windows OCR reads terminal fonts well.
        public static bool PrepareOcr(string src, string dst, double scale, bool binarize)
        {
            using (var bmp = LoadBitmap(src))
            {
                int stride;
                byte[] px = ReadPixels(bmp, out stride);
                long sum = 0; int n = 0;
                for (int y = 0; y < bmp.Height; y += 3)
                    for (int x = 0; x < bmp.Width; x += 3)
                    {
                        int o = y * stride + x * 3;
                        sum += (px[o] * 29 + px[o + 1] * 150 + px[o + 2] * 77) >> 8;
                        n++;
                    }
                bool invert = n > 0 && sum / n < 110;
                int w = Math.Max(1, (int)Math.Round(bmp.Width * scale)), h = Math.Max(1, (int)Math.Round(bmp.Height * scale));
                using (var outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(outBmp))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        float k = invert ? -1f : 1f, o = invert ? 1f : 0f;
                        var cm = new ColorMatrix(new float[][] {
                            new float[] { 0.299f * k, 0.299f * k, 0.299f * k, 0, 0 },
                            new float[] { 0.587f * k, 0.587f * k, 0.587f * k, 0, 0 },
                            new float[] { 0.114f * k, 0.114f * k, 0.114f * k, 0, 0 },
                            new float[] { 0, 0, 0, 1, 0 },
                            new float[] { o, o, o, 0, 1 }
                        });
                        using (var ia = new ImageAttributes())
                        {
                            ia.SetColorMatrix(cm);
                            g.DrawImage(bmp, new Rectangle(0, 0, w, h), 0, 0, bmp.Width, bmp.Height, GraphicsUnit.Pixel, ia);
                        }
                    }
                    if (binarize) Binarize(outBmp);
                    SavePng(outBmp, dst);
                }
                return invert;
            }
        }

        // Downscaled copy for the agent to look at; optional coordinate grid in ORIGINAL pixels.
        public static double MakePreview(string src, string dst, int maxW, int maxH, bool grid)
        {
            using (var bmp = LoadBitmap(src))
            {
                double scale = Math.Min(1.0, Math.Min((double)maxW / bmp.Width, (double)maxH / bmp.Height));
                int w = Math.Max(1, (int)Math.Round(bmp.Width * scale)), h = Math.Max(1, (int)Math.Round(bmp.Height * scale));
                using (var outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(outBmp))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(bmp, new Rectangle(0, 0, w, h));
                        if (grid) DrawGrid(g, bmp.Width, bmp.Height, scale);
                    }
                    SavePng(outBmp, dst);
                }
                return scale;
            }
        }

        static void DrawGrid(Graphics g, int ow, int oh, double scale)
        {
            int step = Math.Max(ow, oh) > 2400 ? 200 : 100;
            g.SmoothingMode = SmoothingMode.None;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (var pen = new Pen(Color.FromArgb(110, 0, 200, 255), 1))
            using (var font = new Font("Consolas", 9f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var fg = new SolidBrush(Color.FromArgb(255, 255, 255, 0)))
            using (var bgb = new SolidBrush(Color.FromArgb(170, 0, 0, 0)))
            {
                for (int x = step; x < ow; x += step)
                {
                    float sx = (float)(x * scale);
                    g.DrawLine(pen, sx, 0, sx, (float)(oh * scale));
                    string t = x.ToString();
                    var sz = g.MeasureString(t, font);
                    g.FillRectangle(bgb, sx + 1, 0, sz.Width, sz.Height);
                    g.DrawString(t, font, fg, sx + 1, 0);
                }
                for (int y = step; y < oh; y += step)
                {
                    float sy = (float)(y * scale);
                    g.DrawLine(pen, 0, sy, (float)(ow * scale), sy);
                    string t = y.ToString();
                    var sz = g.MeasureString(t, font);
                    g.FillRectangle(bgb, 0, sy + 1, sz.Width, sz.Height);
                    g.DrawString(t, font, fg, 0, sy + 1);
                }
            }
        }
    }

    // Sequential, in-memory image editing. Tracks the affine map original->current
    // (x' = x*S + Tx) so the caller can keep resolving OCR boxes after crops/pads/scales.
    public class ImageEditor : IDisposable
    {
        Bitmap bmp;
        public double S { get; private set; }
        public double Tx { get; private set; }
        public double Ty { get; private set; }

        public ImageEditor(string path, double s, double tx, double ty)
        {
            bmp = Native.LoadBitmap(path);
            S = s <= 0 ? 1 : s; Tx = tx; Ty = ty;
        }

        public int Width { get { return bmp.Width; } }
        public int Height { get { return bmp.Height; } }

        void Replace(Bitmap b) { bmp.Dispose(); bmp = b; }

        Graphics G()
        {
            var g = Graphics.FromImage(bmp);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            return g;
        }

        Rectangle Clamp(int x, int y, int w, int h)
        {
            var r = new Rectangle(x, y, w, h);
            r.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
            return r;
        }

        public void Crop(int x, int y, int w, int h)
        {
            Rectangle r = Clamp(x, y, w, h);
            if (r.Width <= 0 || r.Height <= 0) throw new ArgumentException("Crop rectangle lies outside the image (" + bmp.Width + "x" + bmp.Height + ")");
            Replace(bmp.Clone(r, PixelFormat.Format24bppRgb));
            Tx -= r.X; Ty -= r.Y;
        }

        public void Trim(int tol, int pad)
        {
            int[] b = Native.ContentBounds(bmp, tol);
            if (b == null) return;
            Crop(b[0] - pad, b[1] - pad, b[2] + 2 * pad, b[3] + 2 * pad);
        }

        public void Pad(int top, int right, int bottom, int left, string color)
        {
            Color bg = Native.ParseColor(color, Color.White);
            var nb = new Bitmap(bmp.Width + left + right, bmp.Height + top + bottom, PixelFormat.Format24bppRgb);
            nb.SetResolution(96, 96);
            using (var g = Graphics.FromImage(nb))
            {
                g.Clear(bg);
                g.DrawImageUnscaled(bmp, left, top);
            }
            Replace(nb);
            Tx += left; Ty += top;
        }

        public void Scale(double f)
        {
            if (f <= 0) throw new ArgumentException("Scale factor must be positive");
            int w = Math.Max(1, (int)Math.Round(bmp.Width * f)), h = Math.Max(1, (int)Math.Round(bmp.Height * f));
            var nb = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            nb.SetResolution(96, 96);
            using (var g = Graphics.FromImage(nb))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(bmp, new Rectangle(0, 0, w, h));
            }
            Replace(nb);
            S *= f; Tx *= f; Ty *= f;
        }

        static GraphicsPath RoundRect(RectangleF r, float radius)
        {
            var p = new GraphicsPath();
            if (radius <= 0) { p.AddRectangle(r); return p; }
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public void Box(int x, int y, int w, int h, string color, float thickness, float radius)
        {
            Color c = Native.ParseColor(color, Color.FromArgb(255, 229, 57, 53));
            using (var g = G())
            using (var halo = new Pen(Color.FromArgb(150, 255, 255, 255), thickness + 2))
            using (var pen = new Pen(c, thickness))
            using (var path = RoundRect(new RectangleF(x, y, w, h), radius))
            {
                halo.LineJoin = LineJoin.Round;
                pen.LineJoin = LineJoin.Round;
                g.DrawPath(halo, path);
                g.DrawPath(pen, path);
            }
        }

        public void Highlight(int x, int y, int w, int h, string color, double opacity)
        {
            Color c = Native.ParseColor(color, Color.FromArgb(255, 255, 235, 59));
            int a = (int)Math.Round(Math.Max(0, Math.Min(1, opacity)) * 255);
            using (var g = G())
            using (var br = new SolidBrush(Color.FromArgb(a, c.R, c.G, c.B)))
            using (var path = RoundRect(new RectangleF(x, y, w, h), 3))
            {
                g.FillPath(br, path);
            }
        }

        // style: pixelate | blur | solid
        public void Redact(int x, int y, int w, int h, string style, string color)
        {
            Rectangle r = Clamp(x, y, w, h);
            if (r.Width <= 0 || r.Height <= 0) return;
            if (style == "solid")
            {
                using (var g = Graphics.FromImage(bmp))
                using (var br = new SolidBrush(Native.ParseColor(color, Color.Black)))
                    g.FillRectangle(br, r);
                return;
            }
            int factor = style == "blur" ? Math.Max(4, r.Height / 2) : Math.Max(5, r.Height / 2);
            int sw = Math.Max(1, r.Width / factor), sh = Math.Max(1, r.Height / factor);
            using (var small = new Bitmap(sw, sh, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(small))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(bmp, new Rectangle(0, 0, sw, sh), r, GraphicsUnit.Pixel);
                }
                using (var g = Graphics.FromImage(bmp))
                {
                    g.InterpolationMode = style == "blur" ? InterpolationMode.HighQualityBilinear : InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = PixelOffsetMode.Half;
                    g.DrawImage(small, r, new Rectangle(0, 0, sw, sh), GraphicsUnit.Pixel);
                }
            }
        }

        public void Arrow(int x1, int y1, int x2, int y2, string color, float thickness)
        {
            Color c = Native.ParseColor(color, Color.FromArgb(255, 229, 57, 53));
            using (var g = G())
            using (var halo = new Pen(Color.FromArgb(150, 255, 255, 255), thickness + 2))
            using (var pen = new Pen(c, thickness))
            {
                var cap = new AdjustableArrowCap(4, 4, true);
                pen.CustomEndCap = cap;
                halo.CustomEndCap = new AdjustableArrowCap(4, 4, true);
                pen.StartCap = LineCap.Round;
                halo.StartCap = LineCap.Round;
                g.DrawLine(halo, x1, y1, x2, y2);
                g.DrawLine(pen, x1, y1, x2, y2);
            }
        }

        // anchor: tl (x,y = top-left) | ml (x = left, y = vertical centre) | bl | tr | mr
        public void Label(string text, int x, int y, string color, string bg, float size, string anchor)
        {
            if (string.IsNullOrEmpty(text)) return;
            Color fg = Native.ParseColor(color, Color.White);
            Color bc = Native.ParseColor(bg, Color.FromArgb(235, 229, 57, 53));
            using (var g = G())
            using (var font = new Font("Segoe UI", size <= 0 ? 14f : size, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                SizeF sz = g.MeasureString(text, font);
                float padX = font.Size * 0.55f, padY = font.Size * 0.25f;
                float w = sz.Width + padX * 2, h = sz.Height + padY * 2;
                float lx = x, ly = y;
                switch (anchor)
                {
                    case "ml": ly = y - h / 2; break;
                    case "bl": ly = y - h; break;
                    case "tr": lx = x - w; break;
                    case "mr": lx = x - w; ly = y - h / 2; break;
                }
                lx = Math.Max(2, Math.Min(bmp.Width - w - 2, lx));
                ly = Math.Max(2, Math.Min(bmp.Height - h - 2, ly));
                using (var br = new SolidBrush(bc))
                using (var path = RoundRect(new RectangleF(lx, ly, w, h), h / 3))
                using (var tb = new SolidBrush(fg))
                {
                    g.FillPath(br, path);
                    g.DrawString(text, font, tb, lx + padX, ly + padY);
                }
            }
        }

        public void Badge(string text, int cx, int cy, string color, float diameter)
        {
            Color c = Native.ParseColor(color, Color.FromArgb(255, 229, 57, 53));
            float d = diameter <= 0 ? 26 : diameter;
            using (var g = G())
            using (var br = new SolidBrush(c))
            using (var ring = new Pen(Color.White, 2))
            using (var font = new Font("Segoe UI", d * 0.55f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var tb = new SolidBrush(Color.White))
            {
                var r = new RectangleF(cx - d / 2, cy - d / 2, d, d);
                g.FillEllipse(br, r);
                g.DrawEllipse(ring, r);
                var fmt = new StringFormat();
                fmt.Alignment = StringAlignment.Center;
                fmt.LineAlignment = StringAlignment.Center;
                g.DrawString(text, font, tb, r, fmt);
            }
        }

        // Presentation frame: margin + soft drop shadow + rounded corners.
        public void Frame(int margin, string bg, bool shadow, float radius)
        {
            Color bc = Native.ParseColor(bg, Color.White);
            int m = Math.Max(0, margin);
            var nb = new Bitmap(bmp.Width + 2 * m, bmp.Height + 2 * m, PixelFormat.Format24bppRgb);
            nb.SetResolution(96, 96);
            using (var g = Graphics.FromImage(nb))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(bc);
                var target = new RectangleF(m, m, bmp.Width, bmp.Height);
                if (shadow && m > 0)
                {
                    int layers = Math.Min(m, 14);
                    for (int i = layers; i >= 1; i--)
                    {
                        int alpha = (int)(40.0 * (layers - i + 1) / layers / 3.0) + 2;
                        using (var br = new SolidBrush(Color.FromArgb(alpha, 0, 0, 0)))
                        using (var p = RoundRect(new RectangleF(m - i, m - i + 3, bmp.Width + 2 * i, bmp.Height + 2 * i), radius + i))
                            g.FillPath(br, p);
                    }
                }
                using (var tex = new TextureBrush(bmp))
                using (var p = RoundRect(target, radius))
                {
                    tex.TranslateTransform(m, m);
                    g.FillPath(tex, p);
                }
            }
            Replace(nb);
            Tx += m; Ty += m;
        }

        // Stack a region of another image (e.g. the window title bar) on top of this one.
        public void PrependRegion(string srcPath, int x, int y, int w, int h)
        {
            using (var src = Native.LoadBitmap(srcPath))
            {
                var r = new Rectangle(x, y, w, h);
                r.Intersect(new Rectangle(0, 0, src.Width, src.Height));
                if (r.Width <= 0 || r.Height <= 0) return;
                int nw = Math.Max(bmp.Width, r.Width);
                var nb = new Bitmap(nw, bmp.Height + r.Height, PixelFormat.Format24bppRgb);
                nb.SetResolution(96, 96);
                using (var g = Graphics.FromImage(nb))
                {
                    g.Clear(Color.Black);
                    g.DrawImage(src, new Rectangle(0, 0, r.Width, r.Height), r, GraphicsUnit.Pixel);
                    g.DrawImageUnscaled(bmp, 0, r.Height);
                }
                Replace(nb);
                Ty += r.Height;
            }
        }

        public EditResult Save(string path)
        {
            Native.SavePng(bmp, path);
            var r = new EditResult();
            r.Width = bmp.Width; r.Height = bmp.Height; r.S = S; r.Tx = Tx; r.Ty = Ty;
            return r;
        }

        public void Dispose()
        {
            if (bmp != null) { bmp.Dispose(); bmp = null; }
        }
    }
}
