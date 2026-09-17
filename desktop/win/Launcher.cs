using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HoldVue
{
    static class Program
    {
        private const int Port = 18990;
        private static string _root;
        private static NotifyIcon _tray;
        private static Mutex _mutex;
        private static MainForm _form;

        [STAThread]
        static void Main()
        {
            bool created;
            _mutex = new Mutex(true, @"Local\HoldVue.SingleInstance", out created);
            if (!created)
            {
                NativeMethods.PostShowExisting();
                return;
            }

            ApplicationConfiguration.Initialize();
            var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory)
                ?? AppDomain.CurrentDomain.BaseDirectory;
            _root = EnsureApplicationRoot(exeDir.TrimEnd('\\', '/'));

            EnsureServices();
            _form = new MainForm(_root, Port);
            BuildTray();
            Application.ApplicationExit += (s, e) =>
            {
                try { if (_tray != null) _tray.Visible = false; } catch { }
            };
            Application.Run(_form);
        }

        static string ResolveRoot(string start)
        {
            var dir = new DirectoryInfo(start);
            for (int i = 0; i < 6 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "services", "core.js")))
                    return dir.FullName;
                if (File.Exists(Path.Combine(dir.FullName, "app", "index.html")) &&
                    File.Exists(Path.Combine(dir.FullName, "package.json")))
                    return dir.FullName;
                dir = dir.Parent;
            }
            return start;
        }

        static string EnsureApplicationRoot(string exeDir)
        {
            var fromTree = ResolveRoot(exeDir);
            if (File.Exists(Path.Combine(fromTree, "services", "core.js")))
                return fromTree;
            return ExtractEmbeddedPayload(exeDir);
        }

        static string ExtractEmbeddedPayload(string exeDir)
        {
            var asm = Assembly.GetExecutingAssembly();
            string resourceName = null;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase))
                {
                    resourceName = name;
                    break;
                }
            }
            if (resourceName == null)
                return ResolveRoot(exeDir);

            byte[] zipBytes;
            using (var stream = asm.GetManifestResourceStream(resourceName))
            {
                if (stream == null) return ResolveRoot(exeDir);
                using (var ms = new MemoryStream())
                {
                    stream.CopyTo(ms);
                    zipBytes = ms.ToArray();
                }
            }

            string hash;
            using (var sha = SHA256.Create())
                hash = BitConverter.ToString(sha.ComputeHash(zipBytes)).Replace("-", "").Substring(0, 16).ToLowerInvariant();

            var dest = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "HoldVue", "runtime", hash);
            var marker = Path.Combine(dest, ".payload.ok");
            if (File.Exists(marker) && File.Exists(Path.Combine(dest, "services", "core.js")))
                return dest;

            try
            {
                if (Directory.Exists(dest))
                    Directory.Delete(dest, true);
                Directory.CreateDirectory(dest);
                var zipPath = Path.Combine(Path.GetTempPath(), "holdvue-payload-" + hash + ".zip");
                File.WriteAllBytes(zipPath, zipBytes);
                ZipFile.ExtractToDirectory(zipPath, dest, true);
                try { File.Delete(zipPath); } catch { }
                File.WriteAllText(marker, DateTime.UtcNow.ToString("O"));
                return dest;
            }
            catch
            {
                return ResolveRoot(exeDir);
            }
        }

        static string ResolveNodeExe(string root)
        {
            var bundled = Path.Combine(root, "node", "node.exe");
            if (File.Exists(bundled)) return bundled;
            return "node";
        }

        static void BuildTray()
        {
            var iconPath = Path.Combine(_root, "assets", "holdvue.ico");
            Icon icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;

            _tray = new NotifyIcon
            {
                Icon = icon,
                Text = "HoldVue",
                Visible = true
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add("顯示小視窗", null, (s, e) => ShowWindow());
            var throughItem = new ToolStripMenuItem("左鍵穿透") { CheckOnClick = true };
            throughItem.Click += (s, e) =>
            {
                if (_form == null || _form.IsDisposed) return;
                _form.SetClickThrough(throughItem.Checked);
            };
            menu.Opening += (s, e) =>
            {
                throughItem.Checked = _form != null && !_form.IsDisposed && _form.ClickThrough;
            };
            menu.Items.Add(throughItem);
            menu.Items.Add("重新整理", null, (s, e) => _form?.Reload());
            menu.Items.Add("重啟服務", null, (s, e) =>
            {
                StopServices();
                Thread.Sleep(800);
                EnsureServices();
                _form?.Reload();
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("結束", null, (s, e) =>
            {
                StopServices();
                _tray.Visible = false;
                Application.Exit();
            });
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (s, e) => ShowWindow();
            _tray.ShowBalloonTip(1600, "HoldVue", "極簡浮動視窗已啟動", ToolTipIcon.Info);
        }

        static void ShowWindow()
        {
            if (_form == null || _form.IsDisposed) return;
            _form.ShowFromTray();
        }

        static bool PortOpen()
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var ar = client.BeginConnect("127.0.0.1", Port, null, null);
                    bool ok = ar.AsyncWaitHandle.WaitOne(350);
                    if (!ok) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        static void EnsureServices()
        {
            if (PortOpen()) return;
            var script = Path.Combine(_root, "services", "core.js");
            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "找不到 HoldVue 程式資料（services/core.js）。\n請重新下載官方 Release 的 Windows 安裝檔。",
                    "HoldVue",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }
            StartNodeService();
            for (int i = 0; i < 50; i++)
            {
                if (PortOpen()) return;
                Thread.Sleep(200);
            }
            if (!PortOpen())
            {
                MessageBox.Show(
                    "無法啟動 HoldVue 背景服務（127.0.0.1:18990）。\n若為舊版單檔，請改下載含內建 Node 的新版 Release。",
                    "HoldVue",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }

        static void StartNodeService()
        {
            var script = Path.Combine(_root, "services", "core.js");
            if (!File.Exists(script)) return;
            var nodeExe = ResolveNodeExe(_root);
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + script + "\"",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            try { Process.Start(psi); } catch { }
        }

        static void KillPidFile(string name)
        {
            var path = Path.Combine(_root, "app", name);
            if (!File.Exists(path)) return;
            try
            {
                int pid;
                if (int.TryParse(File.ReadAllText(path).Trim(), out pid))
                {
                    try
                    {
                        var p = Process.GetProcessById(pid);
                        p.Kill();
                        p.WaitForExit(1500);
                    }
                    catch { }
                }
            }
            catch { }
            try { File.Delete(path); } catch { }
        }

        public static void StopServicesPublic()
        {
            KillPidFile("server.pid");
            KillPidFile("updater.pid");
        }

        static void StopServices()
        {
            StopServicesPublic();
        }
    }

    sealed class MainForm : Form
    {
        private readonly string _root;
        private readonly int _port;
        private readonly string _boundsPath;
        private WebView2 _web;
        private bool _topMost = true;
        private bool _clickThrough;
        private bool _chrome;
        private double _opacity = 1.0;
        private string _resizeEdge;
        private Point _resizeStartCursor;
        private Rectangle _resizeStartBounds;
        private ContextMenuStrip _widgetMenu;
        private ToolStripMenuItem _pinItem;
        private ToolStripMenuItem _clickThroughItem;
        private ToolStripMenuItem _lowContrastItem;
        private ToolStripMenuItem _opacityRoot;
        private ToolStripMenuItem _itemToggle;
        private ToolStripMenuItem _itemStockSize;
        private ToolStripMenuItem _itemFull;
        private ToolStripSeparator _sepStock;
        private ToolStripLabel _statusItem;

        public MainForm(string root, int port)
        {
            _root = root;
            _port = port;
            _boundsPath = Path.Combine(_root, "app", "window.json");

            Text = "HoldVue";
            Name = "HoldVueMain";
            StartPosition = FormStartPosition.Manual;
            FormBorderStyle = FormBorderStyle.None;
            // 尺寸由前端 CSS 像素直接指定，關閉 WinForms 自動縮放以免高 DPI 被放大一截
            AutoScaleMode = AutoScaleMode.None;
            // 極簡模式：不在工作列顯示，僅系統匣（Mac 版 Electron 維持 Dock 行為）
            ShowInTaskbar = false;
            TopMost = true;
            MinimumSize = new Size(120, 48);
            ClientSize = new Size(300, 78);
            BackColor = Color.FromArgb(28, 28, 30);
            Padding = Padding.Empty;

            var iconPath = Path.Combine(_root, "assets", "holdvue.ico");
            if (File.Exists(iconPath))
            {
                try { Icon = new Icon(iconPath); } catch { }
            }

            LoadBounds();
            BuildChrome();
            Shown += async (s, e) =>
            {
                ApplyClickThroughStyle();
                await InitWebAsync();
            };
            FormClosing += OnFormClosing;
            ResizeEnd += (s, e) => SaveBounds();
            Move += (s, e) => { if (WindowState == FormWindowState.Normal) SaveBounds(); };
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style |= 0x00040000; // WS_THICKFRAME — borderless but resizable
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_NCHITTEST = 0x0084;
            const int HTCLIENT = 1;
            const int HTBOTTOMLEFT = 16;
            const int HTBOTTOMRIGHT = 17;
            if (m.Msg == WM_NCHITTEST && !_chrome)
            {
                base.WndProc(ref m);
                var p = PointToClient(Cursor.Position);
                const int grip = 14;
                bool bottom = p.Y >= ClientSize.Height - grip;
                bool left = p.X <= grip;
                bool right = p.X >= ClientSize.Width - grip;
                if (bottom && left)
                {
                    m.Result = (IntPtr)HTBOTTOMLEFT;
                    return;
                }
                if (bottom && right)
                {
                    m.Result = (IntPtr)HTBOTTOMRIGHT;
                    return;
                }
                // 其餘邊緣命中改回 client，避免拖移時被當成縮放
                int hit = m.Result.ToInt32();
                if (hit >= 10 && hit <= 17)
                {
                    m.Result = (IntPtr)HTCLIENT;
                    return;
                }
                return;
            }
            base.WndProc(ref m);
        }

        void BuildChrome()
        {
            _web = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(28, 28, 30)
            };
            Controls.Add(_web);
            BuildWidgetMenu();
        }

        void BuildWidgetMenu()
        {
            _widgetMenu = new ContextMenuStrip();
            _widgetMenu.Font = new Font("Microsoft JhengHei UI", 9f);
            _statusItem = new ToolStripLabel("極簡浮動視窗") { Enabled = false };
            _widgetMenu.Items.Add(_statusItem);
            _widgetMenu.Items.Add(new ToolStripSeparator());

            _itemToggle = new ToolStripMenuItem("切換顯示", null, (s, e) => EvalJs("holdvueMenu('toggle')"));
            _widgetMenu.Items.Add(_itemToggle);
            _widgetMenu.Items.Add("切換深淺色", null, (s, e) => EvalJs("holdvueMenu('theme')"));
            _pinItem = new ToolStripMenuItem("永遠置頂") { Checked = _topMost, CheckOnClick = true };
            _pinItem.CheckedChanged += (s, e) =>
            {
                _topMost = _pinItem.Checked;
                TopMost = _topMost;
                SaveBounds();
            };
            _widgetMenu.Items.Add(_pinItem);
            _clickThroughItem = new ToolStripMenuItem("左鍵穿透") { Checked = _clickThrough, CheckOnClick = true };
            _clickThroughItem.CheckedChanged += (s, e) =>
            {
                if (_clickThroughItem.Checked == _clickThrough) return;
                SetClickThrough(_clickThroughItem.Checked);
            };
            _widgetMenu.Items.Add(_clickThroughItem);
            _lowContrastItem = new ToolStripMenuItem("低對比") { CheckOnClick = true };
            _lowContrastItem.Click += (s, e) =>
                EvalJs("holdvueMenu('lowcontrast'," + (_lowContrastItem.Checked ? "true" : "false") + ")");
            _widgetMenu.Items.Add(_lowContrastItem);
            _opacityRoot = new ToolStripMenuItem("透明度");
            int[] levels = { 100, 90, 80, 70, 60, 50, 40 };
            foreach (int pct in levels)
            {
                int capture = pct;
                var item = new ToolStripMenuItem(capture + "%") { Tag = capture };
                item.Click += (s, e) => ApplyOpacity(capture / 100.0);
                _opacityRoot.DropDownItems.Add(item);
            }
            _widgetMenu.Items.Add(_opacityRoot);
            _widgetMenu.Items.Add(new ToolStripSeparator());
            _widgetMenu.Items.Add("尺寸：系統列", null, (s, e) => EvalJs("holdvueMenu('size-sys')"));
            _itemStockSize = new ToolStripMenuItem("尺寸：股票列", null, (s, e) => EvalJs("holdvueMenu('size-stock')"));
            _widgetMenu.Items.Add(_itemStockSize);
            _itemFull = new ToolStripMenuItem("完整介面 / 設定", null, (s, e) => EvalJs("holdvueMenu('full')"));
            _widgetMenu.Items.Add(_itemFull);
            _sepStock = new ToolStripSeparator();
            _widgetMenu.Items.Add(_sepStock);
            _widgetMenu.Items.Add("重新整理", null, (s, e) => EvalJs("holdvueMenu('reload')"));
            _widgetMenu.Items.Add(new ToolStripSeparator());
            _widgetMenu.Items.Add("隱藏到系統匣", null, (s, e) => { SaveBounds(); Hide(); });
            _widgetMenu.Items.Add("結束 HoldVue", null, (s, e) =>
            {
                Program.StopServicesPublic();
                Application.Exit();
            });
        }

        void ShowWidgetMenu(bool locked)
        {
            if (_widgetMenu == null) return;
            if (_statusItem != null)
                _statusItem.Text = locked ? "系統監控" : "極簡浮動視窗";
            if (_pinItem != null)
                _pinItem.Checked = _topMost;
            if (_clickThroughItem != null)
                _clickThroughItem.Checked = _clickThrough;
            SyncOpacityMenuChecks();

            // 鎖定時隱藏股票相關選項
            if (_itemToggle != null) _itemToggle.Visible = !locked;
            if (_itemStockSize != null) _itemStockSize.Visible = !locked;
            if (_itemFull != null) _itemFull.Visible = !locked;
            if (_sepStock != null) _sepStock.Visible = !locked;

            TopMost = true;
            void OnClosed(object s, ToolStripDropDownClosedEventArgs e)
            {
                _widgetMenu.Closed -= OnClosed;
                TopMost = _topMost;
            }
            _widgetMenu.Closed += OnClosed;
            _widgetMenu.Show(Cursor.Position);
        }

        void EvalJs(string code)
        {
            try
            {
                if (_web?.CoreWebView2 != null)
                    _ = _web.CoreWebView2.ExecuteScriptAsync(code);
            }
            catch { }
        }

        public bool ClickThrough => _clickThrough;

        public void SetClickThrough(bool on)
        {
            if (_chrome && on) on = false;
            _clickThrough = on;
            ApplyClickThroughStyle();
            if (_clickThroughItem != null)
                _clickThroughItem.Checked = _clickThrough;
            SaveBounds();
        }

        void ApplyClickThroughStyle()
        {
            if (!IsHandleCreated) return;
            int style = NativeMethods.GetWindowLong(Handle, NativeMethods.GWL_EXSTYLE);
            if (_clickThrough)
                style |= NativeMethods.WS_EX_LAYERED | NativeMethods.WS_EX_TRANSPARENT;
            else
                style &= ~NativeMethods.WS_EX_TRANSPARENT;
            NativeMethods.SetWindowLong(Handle, NativeMethods.GWL_EXSTYLE, style);
        }

        void ApplyOpacity(double opacity)
        {
            if (opacity < 0.35) opacity = 0.35;
            if (opacity > 1.0) opacity = 1.0;
            _opacity = opacity;
            Opacity = opacity;
            SyncOpacityMenuChecks();
            SaveBounds();
        }

        void SyncOpacityMenuChecks()
        {
            if (_opacityRoot == null) return;
            int cur = (int)Math.Round(_opacity * 100);
            foreach (ToolStripItem ti in _opacityRoot.DropDownItems)
            {
                var mi = ti as ToolStripMenuItem;
                if (mi == null || mi.Tag == null) continue;
                mi.Checked = (int)mi.Tag == cur;
            }
        }

        void PushPrefs()
        {
            try
            {
                int opacityPct = (int)Math.Round(_opacity * 100);
                string json = "{\"topMost\":" + (_topMost ? "true" : "false")
                    + ",\"clickThrough\":" + (_clickThrough ? "true" : "false")
                    + ",\"opacity\":" + opacityPct + "}";
                EvalJs("holdvuePrefs(" + json + ")");
            }
            catch { }
        }

        void ApplySize(int w, int h)
        {
            WindowState = FormWindowState.Normal;
            int cw = Math.Max(MinimumSize.Width, w);
            int ch = Math.Max(MinimumSize.Height, h);
            // 一律套用（等同 Electron setContentSize），避免殘留過高客戶區
            SuspendLayout();
            try
            {
                ClientSize = new Size(cw, ch);
                try
                {
                    if (_web != null && Math.Abs(_web.ZoomFactor - 1.0) > 0.01)
                        _web.ZoomFactor = 1.0;
                }
                catch { }
            }
            finally
            {
                ResumeLayout(true);
            }
            SaveBounds();
        }

        void SetChrome(bool on)
        {
            _chrome = on;
            if (on)
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                MaximizeBox = true;
                MinimizeBox = true;
                ShowInTaskbar = true;
                if (_clickThrough) SetClickThrough(false);
            }
            else
            {
                // 記下目前客戶區，避免拿掉標題列後客戶區被撐大
                int cw = ClientSize.Width;
                int ch = ClientSize.Height;
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                ApplyClickThroughStyle();
                // 強制維持原客戶區，之後由前端再貼齊內容
                if (cw > 0 && ch > 0)
                    ClientSize = new Size(cw, ch);
            }
        }

        async Task InitWebAsync()
        {
            try
            {
                var userData = Path.Combine(_root, "app", "webview2");
                Directory.CreateDirectory(userData);
                var env = await CoreWebView2Environment.CreateAsync(null, userData);
                await _web.EnsureCoreWebView2Async(env);
                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                try { _web.ZoomFactor = 1.0; } catch { }
                _web.CoreWebView2.WebMessageReceived += OnWebMessage;
                _web.CoreWebView2.Navigate("http://127.0.0.1:" + _port + "/?widget=1");
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "無法載入小視窗引擎（WebView2）。\n請確認已安裝 Edge WebView2 Runtime。\n\n" + ex.Message,
                    "HoldVue",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string raw;
            try { raw = e.TryGetWebMessageAsString(); }
            catch { return; }
            if (string.IsNullOrWhiteSpace(raw)) return;

            BeginInvoke(new Action(() => HandleMessage(raw)));
        }

        void HandleMessage(string raw)
        {
            try
            {
                if (raw == "drag" || raw.IndexOf("\"cmd\":\"drag\"", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    NativeMethods.ReleaseCapture();
                    NativeMethods.SendMessage(Handle, NativeMethods.WM_NCLBUTTONDOWN, NativeMethods.HT_CAPTION, 0);
                    return;
                }

                string cmd = ReadStr(raw, "cmd");
                if (string.IsNullOrEmpty(cmd)) return;

                if (cmd == "resize")
                {
                    int w = ReadInt(raw, "w", Width);
                    int h = ReadInt(raw, "h", Height);
                    bool chrome = ReadBool(raw, "chrome", false);
                    if (chrome) SetChrome(true);
                    ApplySize(w, h);
                }
                else if (cmd == "chrome")
                {
                    SetChrome(ReadBool(raw, "on", false));
                    // 尺寸交由前端依模式重算，避免固定 300x78 蓋掉最佳尺寸
                }
                else if (cmd == "topmost")
                {
                    if (raw.IndexOf("\"on\"", StringComparison.OrdinalIgnoreCase) >= 0)
                        _topMost = ReadBool(raw, "on", _topMost);
                    else
                        _topMost = !_topMost;
                    TopMost = _topMost;
                    if (_pinItem != null) _pinItem.Checked = _topMost;
                    SaveBounds();
                    PushPrefs();
                }
                else if (cmd == "clickthrough")
                {
                    if (raw.IndexOf("\"on\"", StringComparison.OrdinalIgnoreCase) >= 0)
                        SetClickThrough(ReadBool(raw, "on", _clickThrough));
                    else
                        SetClickThrough(!_clickThrough);
                    PushPrefs();
                }
                else if (cmd == "opacity")
                {
                    ApplyOpacity(ReadInt(raw, "pct", 100) / 100.0);
                    PushPrefs();
                }
                else if (cmd == "prefs")
                {
                    PushPrefs();
                }
                else if (cmd == "resizeStart")
                {
                    string edge = ReadStr(raw, "edge");
                    if (edge != "se" && edge != "sw" && edge != "s") return;
                    _resizeEdge = edge;
                    _resizeStartCursor = Cursor.Position;
                    _resizeStartBounds = Bounds;
                }
                else if (cmd == "resizeMove")
                {
                    if (string.IsNullOrEmpty(_resizeEdge)) return;
                    int dx = Cursor.Position.X - _resizeStartCursor.X;
                    int dy = Cursor.Position.Y - _resizeStartCursor.Y;
                    var b = _resizeStartBounds;
                    int w = b.Width;
                    int h = b.Height;
                    int x = b.X;
                    int y = b.Y;
                    if (_resizeEdge == "se")
                    {
                        w = Math.Max(MinimumSize.Width, b.Width + dx);
                        h = Math.Max(MinimumSize.Height, b.Height + dy);
                    }
                    else if (_resizeEdge == "sw")
                    {
                        w = Math.Max(MinimumSize.Width, b.Width - dx);
                        h = Math.Max(MinimumSize.Height, b.Height + dy);
                        x = b.X + (b.Width - w);
                    }
                    else // s：底邊只調高度
                    {
                        h = Math.Max(MinimumSize.Height, b.Height + dy);
                    }
                    Bounds = new Rectangle(x, y, w, h);
                }
                else if (cmd == "resizeEnd")
                {
                    _resizeEdge = null;
                    SaveBounds();
                }
                else if (cmd == "hide")
                {
                    SaveBounds();
                    Hide();
                }
                else if (cmd == "exit")
                {
                    Program.StopServicesPublic();
                    Application.Exit();
                }
                else if (cmd == "menu")
                {
                    bool locked = ReadInt(raw, "locked", 0) == 1 || ReadBool(raw, "locked", false);
                    ShowWidgetMenu(locked);
                }
                else if (cmd == "ready")
                {
                    // 啟動後交由前端依內容重算，避免沿用 window.json 殘留大窗
                    BeginInvoke(new Action(() =>
                    {
                        try { EvalJs("sizeFitDone=false;if(typeof resizeForMode==='function')resizeForMode(true);"); } catch { }
                    }));
                }
            }
            catch { }
        }

        public void Reload()
        {
            try
            {
                if (_web?.CoreWebView2 != null)
                    _web.CoreWebView2.Navigate("http://127.0.0.1:" + _port + "/?widget=1&t=" + DateTimeOffset.Now.ToUnixTimeSeconds());
            }
            catch { }
        }

        public void ShowFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized)
                WindowState = FormWindowState.Normal;
            Activate();
            TopMost = _topMost;
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason != CloseReason.UserClosing)
            {
                SaveBounds();
                return;
            }
            e.Cancel = true;
            SaveBounds();
            Hide();
        }

        void LoadBounds()
        {
            try
            {
                if (!File.Exists(_boundsPath)) return;
                var json = File.ReadAllText(_boundsPath);
                int x = ReadInt(json, "x", Left);
                int y = ReadInt(json, "y", Top);
                int w = ReadInt(json, "w", 300);
                int h = ReadInt(json, "h", 78);
                _topMost = ReadBool(json, "topMost", true);
                TopMost = _topMost;
                _clickThrough = ReadBool(json, "clickThrough", false);
                int opacityPct = ReadInt(json, "opacity", 100);
                if (opacityPct < 35) opacityPct = 35;
                if (opacityPct > 100) opacityPct = 100;
                _opacity = opacityPct / 100.0;
                Opacity = _opacity;
                // 尺寸交給前端依內容決定（對齊本機 Electron）；這裡只還原位置與偏好
                w = 300;
                h = 78;
                w = Math.Max(MinimumSize.Width, w);
                h = Math.Max(MinimumSize.Height, h);
                var area = Screen.FromPoint(new Point(x, y)).WorkingArea;
                if (!area.Contains(x + 20, y + 20))
                {
                    x = area.Left + 40;
                    y = area.Top + 40;
                }
                // 用 Location + ClientSize，與 ApplySize／前端量測一致
                Location = new Point(x, y);
                ClientSize = new Size(w, h);
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                if (WindowState != FormWindowState.Normal) return;
                Directory.CreateDirectory(Path.GetDirectoryName(_boundsPath));
                int opacityPct = (int)Math.Round(_opacity * 100);
                // 存客戶區尺寸（對齊 JS innerWidth/Height），不要存含邊框的 Bounds
                var json = "{\"x\":" + Left + ",\"y\":" + Top
                    + ",\"w\":" + ClientSize.Width + ",\"h\":" + ClientSize.Height
                    + ",\"topMost\":" + (_topMost ? "true" : "false")
                    + ",\"clickThrough\":" + (_clickThrough ? "true" : "false")
                    + ",\"opacity\":" + opacityPct + "}";
                File.WriteAllText(_boundsPath, json);
            }
            catch { }
        }

        static int ReadInt(string json, string key, int fallback)
        {
            try
            {
                var token = "\"" + key + "\":";
                int i = json.IndexOf(token, StringComparison.OrdinalIgnoreCase);
                if (i < 0) return fallback;
                i += token.Length;
                while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
                int j = i;
                while (j < json.Length && (char.IsDigit(json[j]) || json[j] == '-')) j++;
                return int.Parse(json.Substring(i, j - i));
            }
            catch { return fallback; }
        }

        static bool ReadBool(string json, string key, bool fallback)
        {
            try
            {
                var token = "\"" + key + "\":";
                int i = json.IndexOf(token, StringComparison.OrdinalIgnoreCase);
                if (i < 0) return fallback;
                i += token.Length;
                return json.Substring(i).TrimStart().StartsWith("true", StringComparison.OrdinalIgnoreCase);
            }
            catch { return fallback; }
        }

        static string ReadStr(string json, string key)
        {
            try
            {
                var token = "\"" + key + "\":\"";
                int i = json.IndexOf(token, StringComparison.OrdinalIgnoreCase);
                if (i < 0) return null;
                i += token.Length;
                int j = json.IndexOf('"', i);
                if (j < 0) return null;
                return json.Substring(i, j - i);
            }
            catch { return null; }
        }
    }

    static class NativeMethods
    {
        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HT_CAPTION = 0x2;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_LAYERED = 0x80000;
        public const int WS_EX_TRANSPARENT = 0x20;

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        private const int SW_RESTORE = 9;

        public static void PostShowExisting()
        {
            EnumWindows((hWnd, l) =>
            {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, sb.Capacity);
                if (sb.ToString() == "HoldVue")
                {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
    }
}
