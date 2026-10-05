// Console I/O helper: attaches to another process's console and
//   read  <pid> [extraRows]            -> JSON with the visible screen text (exact characters, no OCR)
//   write <pid> <step> [<step> ...]    -> injects keystrokes straight into the console input buffer
//        step = T:<base64 utf-8 text> | K:<chord e.g. enter, ctrl+c, up> | S:<sleep ms>
// Writing to the input buffer needs no window focus and bypasses keyboard layouts / IMEs.
// Compiled by worker.ps1 as a console application; C# 5 syntax only.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class ConIO
{
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public ushort wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct KEY_EVENT_RECORD
    {
        [FieldOffset(0)] public int bKeyDown;
        [FieldOffset(4)] public ushort wRepeatCount;
        [FieldOffset(6)] public ushort wVirtualKeyCode;
        [FieldOffset(8)] public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacter(IntPtr h, [Out] char[] buffer, uint length, COORD coord, out uint read);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] records, uint length, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder sb, uint size);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const ushort KEY_EVENT = 1;
    const uint SHIFT_PRESSED = 0x10, LEFT_CTRL_PRESSED = 0x08, LEFT_ALT_PRESSED = 0x02, ENHANCED_KEY = 0x100;
    const uint ENABLE_PROCESSED_INPUT = 0x1;

    static string Esc(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static IntPtr Open(string name)
    {
        IntPtr h = CreateFile(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) throw new InvalidOperationException("Cannot open " + name + ", error " + Marshal.GetLastWin32Error());
        return h;
    }

    static string Read(int extra)
    {
        IntPtr h = Open("CONOUT$");
        try
        {
            CONSOLE_SCREEN_BUFFER_INFO info;
            if (!GetConsoleScreenBufferInfo(h, out info)) throw new InvalidOperationException("GetConsoleScreenBufferInfo failed, error " + Marshal.GetLastWin32Error());
            int cols = info.dwSize.X;
            int top = info.srWindow.Top;
            int bottom = Math.Max(info.srWindow.Bottom, info.dwCursorPosition.Y);
            int start = Math.Max(0, top - Math.Max(0, extra));
            var title = new StringBuilder(1024);
            GetConsoleTitle(title, 1024);
            var sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"cols\":").Append(cols)
              .Append(",\"bufferRows\":").Append(info.dwSize.Y)
              .Append(",\"cursorX\":").Append(info.dwCursorPosition.X)
              .Append(",\"cursorY\":").Append(info.dwCursorPosition.Y)
              .Append(",\"top\":").Append(top)
              .Append(",\"bottom\":").Append(info.srWindow.Bottom)
              .Append(",\"start\":").Append(start)
              .Append(",\"title\":\"").Append(Esc(title.ToString())).Append("\",\"lines\":[");
            var buf = new char[cols];
            for (int row = start; row <= bottom; row++)
            {
                uint read;
                var c = new COORD();
                c.X = 0; c.Y = (short)row;
                string line = "";
                if (ReadConsoleOutputCharacter(h, buf, (uint)cols, c, out read)) line = new string(buf, 0, (int)read).TrimEnd();
                if (row > start) sb.Append(',');
                sb.Append('"').Append(Esc(line)).Append('"');
            }
            sb.Append("]}");
            return sb.ToString();
        }
        finally { CloseHandle(h); }
    }

    static INPUT_RECORD Key(bool down, ushort vk, char ch, uint state)
    {
        var r = new INPUT_RECORD();
        r.EventType = KEY_EVENT;
        r.KeyEvent.bKeyDown = down ? 1 : 0;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.wVirtualKeyCode = vk;
        r.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0);
        r.KeyEvent.UnicodeChar = ch;
        r.KeyEvent.dwControlKeyState = state;
        return r;
    }

    static void AddPress(List<INPUT_RECORD> list, ushort vk, char ch, uint state)
    {
        list.Add(Key(true, vk, ch, state));
        list.Add(Key(false, vk, ch, state));
    }

    static void AddText(List<INPUT_RECORD> list, string text)
    {
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n') { AddPress(list, 0x0D, '\r', 0); continue; }
            if (c == '\t') { AddPress(list, 0x09, '\t', 0); continue; }
            short scan = VkKeyScan(c);
            ushort vk = 0;
            uint state = 0;
            if (scan != -1)
            {
                int mods = (scan >> 8) & 0xFF;
                if (mods == 0 || mods == 1)
                {
                    vk = (ushort)(scan & 0xFF);
                    if (mods == 1) state = SHIFT_PRESSED;
                }
            }
            AddPress(list, vk, c, state);
        }
    }

    static ushort NamedKey(string name, out char ch, out bool enhanced)
    {
        ch = '\0';
        enhanced = false;
        switch (name)
        {
            case "enter": case "return": ch = '\r'; return 0x0D;
            case "tab": ch = '\t'; return 0x09;
            case "esc": case "escape": ch = (char)27; return 0x1B;
            case "space": ch = ' '; return 0x20;
            case "backspace": case "bs": ch = (char)8; return 0x08;
            case "delete": case "del": enhanced = true; return 0x2E;
            case "insert": case "ins": enhanced = true; return 0x2D;
            case "home": enhanced = true; return 0x24;
            case "end": enhanced = true; return 0x23;
            case "pageup": case "pgup": enhanced = true; return 0x21;
            case "pagedown": case "pgdn": enhanced = true; return 0x22;
            case "up": enhanced = true; return 0x26;
            case "down": enhanced = true; return 0x28;
            case "left": enhanced = true; return 0x25;
            case "right": enhanced = true; return 0x27;
        }
        if (name.Length >= 2 && name[0] == 'f')
        {
            int n;
            if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 12) return (ushort)(0x70 + n - 1);
        }
        return 0;
    }

    // Returns true when the chord is Ctrl+C and the console currently processes it as a signal.
    static bool AddChord(List<INPUT_RECORD> list, string chord, IntPtr hin)
    {
        string[] parts = chord.ToLowerInvariant().Split('+');
        uint state = 0;
        for (int i = 0; i < parts.Length - 1; i++)
        {
            string m = parts[i].Trim();
            if (m == "ctrl" || m == "control") state |= LEFT_CTRL_PRESSED;
            else if (m == "shift") state |= SHIFT_PRESSED;
            else if (m == "alt") state |= LEFT_ALT_PRESSED;
            else throw new ArgumentException("Unknown modifier '" + m + "' in '" + chord + "'");
        }
        string k = parts[parts.Length - 1].Trim();
        if (k.Length == 0) k = "+";
        char ch;
        bool enhanced;
        ushort vk = NamedKey(k, out ch, out enhanced);
        if (vk == 0)
        {
            if (k.Length != 1) throw new ArgumentException("Unknown key '" + k + "' in '" + chord + "'");
            ch = k[0];
            short scan = VkKeyScan(ch);
            vk = scan == -1 ? (ushort)0 : (ushort)(scan & 0xFF);
            if (scan != -1 && ((scan >> 8) & 1) == 1) state |= SHIFT_PRESSED;
            if ((state & LEFT_CTRL_PRESSED) != 0 && char.IsLetter(ch)) ch = (char)(char.ToLowerInvariant(ch) - 'a' + 1);
        }
        if (enhanced) state |= ENHANCED_KEY;
        bool isCtrlC = (state & LEFT_CTRL_PRESSED) != 0 && vk == 0x43;
        if (isCtrlC)
        {
            uint mode;
            if (GetConsoleMode(hin, out mode) && (mode & ENABLE_PROCESSED_INPUT) != 0) return true;
        }
        AddPress(list, vk, ch, state);
        return false;
    }

    static void Flush(IntPtr hin, List<INPUT_RECORD> list)
    {
        if (list.Count == 0) return;
        uint written;
        var arr = list.ToArray();
        if (!WriteConsoleInput(hin, arr, (uint)arr.Length, out written)) throw new InvalidOperationException("WriteConsoleInput failed, error " + Marshal.GetLastWin32Error());
        list.Clear();
    }

    static string Write(string[] steps, int from)
    {
        IntPtr hin = Open("CONIN$");
        int typed = 0;
        try
        {
            var list = new List<INPUT_RECORD>();
            for (int i = from; i < steps.Length; i++)
            {
                string s = steps[i];
                if (s.Length < 2 || s[1] != ':') throw new ArgumentException("Bad step '" + s + "'");
                string v = s.Substring(2);
                switch (s[0])
                {
                    case 'T':
                        string text = Encoding.UTF8.GetString(Convert.FromBase64String(v));
                        AddText(list, text);
                        typed += text.Length;
                        break;
                    case 'K':
                        if (AddChord(list, v, hin))
                        {
                            Flush(hin, list);
                            SetConsoleCtrlHandler(IntPtr.Zero, true);
                            GenerateConsoleCtrlEvent(0, 0);
                            Thread.Sleep(50);
                        }
                        break;
                    case 'S':
                        Flush(hin, list);
                        Thread.Sleep(int.Parse(v));
                        break;
                    default:
                        throw new ArgumentException("Bad step '" + s + "'");
                }
            }
            Flush(hin, list);
        }
        finally { CloseHandle(hin); }
        return "{\"ok\":true,\"typed\":" + typed + "}";
    }

    static string Execute(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("usage: read <pid> [extra] | write <pid> <steps...>");
            uint pid = uint.Parse(args[1]);
            FreeConsole();
            if (!AttachConsole(pid)) throw new InvalidOperationException("AttachConsole(" + pid + ") failed, error " + Marshal.GetLastWin32Error() + " (process gone or not a console app)");
            try
            {
                if (args[0] == "read") return Read(args.Length > 2 ? int.Parse(args[2]) : 0);
                if (args[0] == "write") return Write(args, 2);
                throw new ArgumentException("Unknown mode '" + args[0] + "'");
            }
            finally { FreeConsole(); }
        }
        catch (Exception e)
        {
            return "{\"ok\":false,\"error\":\"" + Esc(e.Message) + "\"}";
        }
    }

    // "serve" keeps one process alive and answers one request per stdin line, which avoids
    // paying .NET process start-up on every read (seconds on a busy machine).
    static int Main(string[] args)
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        if (args.Length >= 1 && args[0] == "serve")
        {
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            FreeConsole();
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                string[] a = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (a.Length == 0) continue;
                stdout.WriteLine(Execute(a));
                stdout.Flush();
            }
            return 0;
        }
        string result = Execute(args);
        stdout.Write(result);
        stdout.Flush();
        return result.StartsWith("{\"ok\":true") ? 0 : 1;
    }
}
