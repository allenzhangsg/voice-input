using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class StatusWindow : Form
{
    // ── Win32 ───────────────────────────────────────────────────────
    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst,
        ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc,
        ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObj);
    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr hObj);
    [DllImport("gdi32.dll")]
    static extern bool DeleteDC(IntPtr hdc);
    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("gdi32.dll")]
    static extern int GetDeviceCaps(IntPtr hdc, int nIndex);

    const int LOGPIXELSX = 88;

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct SIZE { public int CX, CY; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct BLENDFUNCTION { public byte Op, Flags, Alpha, Format; }

    const int GWL_EXSTYLE = -20;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int ULW_ALPHA = 2;
    const byte AC_SRC_OVER = 0;
    const byte AC_SRC_ALPHA = 1;

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    // ── Layout (scaled at runtime by DPI) ─────────────────────────
    float dpiScale = 1f;
    int PillHeight;
    int PadH;  // renamed to avoid hiding Control.Padding
    int DotSize;
    int Gap;
    float FontSize;
    int BottomMargin;
    int ExtraPad;
    int CloseBtnSize;

    // ── State ───────────────────────────────────────────────────────
    string currentState = "idle";
    string modeText = "";
    string statusText = "";
    Color dotColor = Color.FromArgb(255, 59, 48);
    bool pulseVisible = false;
    bool pulseOn = true;

    System.Windows.Forms.Timer pulseTimer;
    System.Windows.Forms.Timer flashTimer;
    System.Windows.Forms.Timer fadeTimer;
    System.Windows.Forms.Timer orphanTimer;
    RectangleF closeBtnRect = RectangleF.Empty;
    bool closeBtnVisible = false;
    IntPtr prevForegroundWindow = IntPtr.Zero;

    double targetOpacity = 0;
    double currentOpacity = 0;
    int parentPid;
    Stream stdinStream;

    static readonly Color BgColor = Color.FromArgb(255, 245, 245, 245);
    static readonly Color TextColor = Color.FromArgb(255, 38, 38, 38);
    static readonly Color ModeColor = Color.FromArgb(255, 120, 120, 120);

    StatusWindow(Stream stdin)
    {
        stdinStream = stdin;

        // Query system DPI
        IntPtr dc = GetDC(IntPtr.Zero);
        int dpi = GetDeviceCaps(dc, LOGPIXELSX);
        ReleaseDC(IntPtr.Zero, dc);
        dpiScale = dpi / 96f;

        // Scale layout constants
        PillHeight  = (int)(32 * dpiScale);
        PadH        = (int)(14 * dpiScale);
        DotSize     = (int)(10 * dpiScale);
        Gap         = (int)(6 * dpiScale);
        FontSize    = 12f * dpiScale;
        BottomMargin = (int)(24 * dpiScale);
        ExtraPad    = (int)(20 * dpiScale);
        CloseBtnSize = (int)(16 * dpiScale);

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(200, PillHeight + ExtraPad);

        parentPid = GetParentPid();

        pulseTimer = new System.Windows.Forms.Timer();
        pulseTimer.Interval = 600;
        pulseTimer.Tick += delegate { pulseOn = !pulseOn; PaintLayered(); };

        flashTimer = new System.Windows.Forms.Timer();
        flashTimer.Tick += delegate { flashTimer.Stop(); FadeOut(); };

        fadeTimer = new System.Windows.Forms.Timer();
        fadeTimer.Interval = 16;
        fadeTimer.Tick += delegate { FadeTick(); };

        orphanTimer = new System.Windows.Forms.Timer();
        orphanTimer.Interval = 2000;
        orphanTimer.Tick += delegate { if (!IsParentAlive()) Close(); };

        Load += delegate {
            orphanTimer.Start();
            var t = new Thread(ReadStdin);
            t.IsBackground = true;
            t.Start();
        };
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    const int WM_NCHITTEST = 0x0084;
    const int WM_LBUTTONDOWN = 0x0201;
    const int HTCLIENT = 1;
    const int HTTRANSPARENT = -1;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCHITTEST && closeBtnVisible)
        {
            var pt = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, m.LParam.ToInt32() >> 16));
            if (closeBtnRect.Contains(pt.X, pt.Y))
            {
                m.Result = (IntPtr)HTCLIENT;
                return;
            }
            m.Result = (IntPtr)HTTRANSPARENT;
            return;
        }
        if (m.Msg == WM_LBUTTONDOWN && closeBtnVisible)
        {
            var pt = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, m.LParam.ToInt32() >> 16));
            var hitArea = RectangleF.Inflate(closeBtnRect, 4, 4);
            if (hitArea.Contains(pt.X, pt.Y))
            {
                Console.WriteLine("CANCEL");
                Console.Out.Flush();
                // Restore focus to previous foreground window
                if (prevForegroundWindow != IntPtr.Zero)
                    SetForegroundWindow(prevForegroundWindow);
                base.WndProc(ref m);
                return;
            }
        }
        base.WndProc(ref m);
    }

    // ── Per-pixel alpha rendering via UpdateLayeredWindow ────────────
    void PaintLayered()
    {
        int w = Width;
        int h = Height;
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.FromArgb(0, 0, 0, 0));
                RenderContent(g, w, h);
            }
            SetLayeredBitmap(bmp, (byte)(currentOpacity * 255));
        }
    }

    void RenderContent(Graphics g, int w, int h)
    {
        var font = new Font("Segoe UI", FontSize, FontStyle.Regular, GraphicsUnit.Pixel);
        var fontMedium = new Font("Segoe UI", FontSize, FontStyle.Bold, GraphicsUnit.Pixel);
        var modeSz = !string.IsNullOrEmpty(modeText) ? g.MeasureString(modeText, font) : SizeF.Empty;
        var statusSz = !string.IsNullOrEmpty(statusText) ? g.MeasureString(statusText, fontMedium) : SizeF.Empty;

        float sepGap = (modeSz.Width > 0 && statusSz.Width > 0) ? Gap : 0;
        float labelX = PadH + DotSize + Gap;
        float closeGap = closeBtnVisible ? Gap : 0;
        float closeW = closeBtnVisible ? CloseBtnSize : 0;
        float totalWidth = labelX + modeSz.Width + sepGap + statusSz.Width + closeGap + closeW + PadH;

        // Reposition window on screen containing the cursor
        POINT cursorPos;
        GetCursorPos(out cursorPos);
        var cursorScreen = Screen.FromPoint(new Point(cursorPos.X, cursorPos.Y));
        var screen = cursorScreen.WorkingArea;
        int winWidth = (int)Math.Ceiling(totalWidth) + ExtraPad;
        int newLeft = screen.Left + (screen.Width - winWidth) / 2;
        int newTop = screen.Bottom - PillHeight - BottomMargin;

        if (Width != winWidth || Left != newLeft)
        {
            Width = winWidth;
            Left = newLeft;
            Top = newTop;
        }

        int offsetX = ExtraPad / 2;
        int offsetY = (Height - PillHeight) / 2;

        // Draw shadow
        var shadowRect = new RectangleF(offsetX + 1, offsetY + 2, totalWidth, PillHeight);
        using (var sp = RoundedRect(shadowRect, PillHeight / 2f))
        using (var sb = new SolidBrush(Color.FromArgb(30, 0, 0, 0)))
            g.FillPath(sb, sp);

        // Pill background
        var pillRect = new RectangleF(offsetX, offsetY, totalWidth, PillHeight);
        using (var path = RoundedRect(pillRect, PillHeight / 2f))
        using (var brush = new SolidBrush(BgColor))
            g.FillPath(brush, path);

        float cy = offsetY + PillHeight / 2f;

        // Pulse glow
        if (pulseVisible && pulseOn)
        {
            var pa = Color.FromArgb(76, dotColor.R, dotColor.G, dotColor.B);
            using (var brush = new SolidBrush(pa))
                g.FillEllipse(brush, offsetX + PadH - 2, cy - (DotSize / 2f + 2), DotSize + 4, DotSize + 4);
        }

        // Dot
        using (var brush = new SolidBrush(dotColor))
            g.FillEllipse(brush, offsetX + PadH, cy - DotSize / 2f, DotSize, DotSize);

        // Text
        float textY = cy - (modeSz.Height > 0 ? modeSz.Height : statusSz.Height) / 2f;
        float curX = offsetX + labelX;
        if (modeSz.Width > 0)
        {
            using (var brush = new SolidBrush(ModeColor))
                g.DrawString(modeText, font, brush, curX, textY);
            curX += modeSz.Width + sepGap;
        }
        if (statusSz.Width > 0)
        {
            using (var brush = new SolidBrush(TextColor))
                g.DrawString(statusText, fontMedium, brush, curX, textY);
            curX += statusSz.Width;
        }

        // Close button (X with circle)
        if (closeBtnVisible)
        {
            float cbX = curX + closeGap;
            float cbY = cy - CloseBtnSize / 2f;
            float inset = 4.5f * dpiScale;
            float penW = 1.5f * dpiScale;
            // Store absolute position for hit testing (relative to form)
            closeBtnRect = new RectangleF(cbX, cbY, CloseBtnSize, CloseBtnSize);
            // Circle background
            float circleInset = 0.5f * dpiScale;
            var circleColor = Color.FromArgb(76, ModeColor.R, ModeColor.G, ModeColor.B);
            using (var brush = new SolidBrush(circleColor))
                g.FillEllipse(brush, cbX + circleInset, cbY + circleInset, CloseBtnSize - circleInset * 2, CloseBtnSize - circleInset * 2);
            using (var pen = new Pen(ModeColor, 1f * dpiScale))
                g.DrawEllipse(pen, cbX + circleInset, cbY + circleInset, CloseBtnSize - circleInset * 2, CloseBtnSize - circleInset * 2);
            // Cross
            using (var pen = new Pen(ModeColor, penW))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawLine(pen, cbX + inset, cbY + inset, cbX + CloseBtnSize - inset, cbY + CloseBtnSize - inset);
                g.DrawLine(pen, cbX + CloseBtnSize - inset, cbY + inset, cbX + inset, cbY + CloseBtnSize - inset);
            }
        }
        else
        {
            closeBtnRect = RectangleF.Empty;
        }

        font.Dispose();
        fontMedium.Dispose();
    }

    void SetLayeredBitmap(Bitmap bmp, byte opacity)
    {
        IntPtr screenDC = GetDC(IntPtr.Zero);
        IntPtr memDC = CreateCompatibleDC(screenDC);
        IntPtr hBmp = bmp.GetHbitmap(Color.FromArgb(0));
        IntPtr prev = SelectObject(memDC, hBmp);
        try
        {
            var blend = new BLENDFUNCTION();
            blend.Op = AC_SRC_OVER;
            blend.Alpha = opacity;
            blend.Format = AC_SRC_ALPHA;
            var ptDst = new POINT(); ptDst.X = Left; ptDst.Y = Top;
            var sz = new SIZE(); sz.CX = bmp.Width; sz.CY = bmp.Height;
            var ptSrc = new POINT(); ptSrc.X = 0; ptSrc.Y = 0;
            UpdateLayeredWindow(Handle, screenDC, ref ptDst, ref sz, memDC, ref ptSrc, 0, ref blend, ULW_ALPHA);
        }
        finally
        {
            SelectObject(memDC, prev);
            DeleteObject(hBmp);
            DeleteDC(memDC);
            ReleaseDC(IntPtr.Zero, screenDC);
        }
    }

    static GraphicsPath RoundedRect(RectangleF rect, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2;
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // ── Fade animation ──────────────────────────────────────────────
    void FadeIn()
    {
        targetOpacity = 1.0;
        Show();
        fadeTimer.Start();
        PaintLayered();
    }

    void FadeOut()
    {
        targetOpacity = 0.0;
        fadeTimer.Start();
    }

    void FadeTick()
    {
        double step = 0.08;
        if (targetOpacity > currentOpacity)
            currentOpacity = Math.Min(currentOpacity + step, targetOpacity);
        else
            currentOpacity = Math.Max(currentOpacity - step, targetOpacity);

        if (Math.Abs(currentOpacity - targetOpacity) < 0.01)
        {
            currentOpacity = targetOpacity;
            fadeTimer.Stop();
            if (targetOpacity == 0) { Hide(); return; }
        }

        PaintLayered();
    }

    // ── Command handling ────────────────────────────────────────────
    void HandleCommand(string cmd)
    {
        if (cmd.StartsWith("STATE:"))
        {
            var state = cmd.Substring(6);
            currentState = state;
            switch (state)
            {
                case "idle":
                    closeBtnVisible = false;
                    StopPulse();
                    FadeOut();
                    break;
                case "recording":
                    closeBtnVisible = true;
                    prevForegroundWindow = GetForegroundWindow();
                    dotColor = Color.FromArgb(255, 59, 48);
                    StartPulse();
                    statusText = "Recording\u2026";
                    PaintLayered();
                    FadeIn();
                    break;
                case "processing":
                    closeBtnVisible = true;
                    dotColor = Color.FromArgb(255, 149, 0);
                    statusText = "Processing\u2026";
                    PaintLayered();
                    FadeIn();
                    break;
            }
        }
        else if (cmd.StartsWith("MODE:"))
        {
            var mode = cmd.Substring(5);
            if (mode == "transcribe")
                modeText = "";
            else if (mode.StartsWith("translate:"))
                modeText = "\u2192 " + mode.Substring(10);
            PaintLayered();
        }
        else if (cmd.StartsWith("FLASH:"))
        {
            var text = cmd.Substring(6);
            flashTimer.Stop();
            StopPulse();
            dotColor = Color.FromArgb(52, 199, 89);
            statusText = text;
            PaintLayered();
            FadeIn();
            flashTimer.Interval = 1500;
            flashTimer.Start();
        }
        else if (cmd.StartsWith("TEXT:"))
        {
            statusText = cmd.Substring(5);
            PaintLayered();
        }
    }

    void StartPulse()
    {
        pulseVisible = true;
        pulseOn = true;
        pulseTimer.Start();
    }

    void StopPulse()
    {
        pulseTimer.Stop();
        pulseVisible = false;
    }

    // ── Stdin reader ────────────────────────────────────────────────
    void ReadStdin()
    {
        try
        {
            using (var reader = new StreamReader(stdinStream))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    var trimmed = line.Trim();
                    if (trimmed == "QUIT")
                    {
                        Invoke((Action)delegate { Close(); });
                        return;
                    }
                    if (trimmed.Length > 0)
                    {
                        var cmd = trimmed;
                        try { Invoke((Action)delegate { HandleCommand(cmd); }); }
                        catch { return; }
                    }
                }
            }
            try { Invoke((Action)delegate { Close(); }); } catch { }
        }
        catch { }
    }

    // ── Orphan detection ────────────────────────────────────────────
    static int GetParentPid()
    {
        try
        {
            var proc = System.Diagnostics.Process.GetCurrentProcess();
            var query = "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + proc.Id;
            var searcher = new System.Management.ManagementObjectSearcher(query);
            foreach (var obj in searcher.Get())
                return Convert.ToInt32(obj["ParentProcessId"]);
        }
        catch { }
        return -1;
    }

    bool IsParentAlive()
    {
        if (parentPid <= 0) return true;
        try
        {
            System.Diagnostics.Process.GetProcessById(parentPid);
            return true;
        }
        catch { return false; }
    }

    // ── Entry point ─────────────────────────────────────────────────
    [STAThread]
    static void Main()
    {
        SetProcessDPIAware();
        var stdin = Console.OpenStandardInput();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new StatusWindow(stdin));
    }
}
