using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

namespace Nexus.Desktop;

internal sealed class TrayIconHost : IDisposable
{
    private const string BaseUrl = "http://127.0.0.1:8769";
    private readonly MainWindow _window;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    internal TrayIconHost(MainWindow window)
    {
        _window = window;
        _menu = new Forms.ContextMenuStrip();
        _menu.Opening += async (_, _) => await RefreshMenuAsync();

        _icon = new Forms.NotifyIcon
        {
            Text = "Nexus Harness",
            Icon = LoadIcon(),
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == Forms.MouseButtons.Left) _window.OpenView(NexusView.Current);
        };
        _icon.DoubleClick += (_, _) => _window.OpenView(NexusView.Current);
        BuildMenu(null, null, null);
    }

    private static Drawing.Icon LoadIcon()
    {
        try
        {
            var stream = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Nexus.ico"))?.Stream;
            if (stream is not null) return new Drawing.Icon(stream);
        }
        catch { /* fallback below */ }
        var onDisk = Path.Combine(AppContext.BaseDirectory, "Assets", "Nexus.ico");
        return File.Exists(onDisk) ? new Drawing.Icon(onDisk) : Drawing.SystemIcons.Application;
    }

    private async Task RefreshMenuAsync()
    {
        JsonElement? peersData = null;
        JsonElement? sessionsData = null;
        JsonElement? mailData = null;
        string? versionText = null;
        try
        {
            var t1 = _http.GetStringAsync(BaseUrl + "/api/peers");
            var t2 = _http.GetStringAsync(BaseUrl + "/api/sessions");
            var t3 = _http.GetStringAsync(BaseUrl + "/api/mail?summary=1");
            var t4 = _http.GetStringAsync(BaseUrl + "/version");
            await Task.WhenAll(
                t1.ContinueWith(t => { if (t.IsCompletedSuccessfully) peersData = JsonDocument.Parse(t.Result).RootElement.Clone(); }),
                t2.ContinueWith(t => { if (t.IsCompletedSuccessfully) sessionsData = JsonDocument.Parse(t.Result).RootElement.Clone(); }),
                t3.ContinueWith(t => { if (t.IsCompletedSuccessfully) mailData = JsonDocument.Parse(t.Result).RootElement.Clone(); }),
                t4.ContinueWith(t => { if (t.IsCompletedSuccessfully) versionText = JsonDocument.Parse(t.Result).RootElement.GetProperty("version").GetString(); }));
        }
        catch { /* monitor offline */ }

        _window.Dispatcher.Invoke(() => BuildMenu(peersData, sessionsData, mailData, versionText));
    }

    private void BuildMenu(JsonElement? peersData, JsonElement? sessionsData, JsonElement? mailData, string? version = null)
    {
        _menu.Items.Clear();

        var online = peersData is not null;
        var selfName = peersData?.TryGetProperty("self", out var self) == true && self.TryGetProperty("name", out var n) ? n.GetString() : Environment.MachineName;
        var title = online ? $"Nexus Harness{(version is not null ? " v" + version : "")} — Online ({selfName})" : "Nexus Harness — Monitor Offline";
        var header = new Forms.ToolStripMenuItem(title) { Enabled = false };
        _menu.Items.Add(header);
        _menu.Items.Add(new Forms.ToolStripSeparator());

        var openItem = new Forms.ToolStripMenuItem("Open Nexus", null, (_, _) => _window.OpenView(NexusView.Current))
        {
            Font = new Drawing.Font(_menu.Font, Drawing.FontStyle.Bold)
        };
        _menu.Items.Add(openItem);

        // Agent Chats & Inbox
        var chatsMenu = new Forms.ToolStripMenuItem("Agent Chats & Inbox");
        chatsMenu.DropDownItems.Add("Open Inbox", null, (_, _) => _window.OpenView(NexusView.Inbox));
        chatsMenu.DropDownItems.Add("Open Mail", null, (_, _) => _window.OpenView(NexusView.Mail));
        if (mailData?.TryGetProperty("threads", out var threads) == true && threads.ValueKind == JsonValueKind.Array && threads.GetArrayLength() > 0)
        {
            chatsMenu.DropDownItems.Add(new Forms.ToolStripSeparator());
            var count = 0;
            foreach (var th in threads.EnumerateArray())
            {
                if (count++ >= 6) break;
                var peer = th.TryGetProperty("peer", out var p) ? p.GetString() ?? "peer" : "peer";
                var unread = th.TryGetProperty("unread", out var u) ? u.GetInt32() : 0;
                var preview = th.TryGetProperty("preview", out var pr) ? pr.GetString() ?? "" : "";
                if (preview.Length > 45) preview = preview[..45] + "...";
                var label = unread > 0 ? $"[{unread} new] {peer}: {preview}" : $"{peer}: {preview}";
                chatsMenu.DropDownItems.Add(label, null, (_, _) => _window.OpenView(NexusView.Inbox));
            }
        }
        _menu.Items.Add(chatsMenu);

        // Active Sessions across Antigravity, Claude, Codex
        var sessionCount = sessionsData?.TryGetProperty("sessions", out var sessArr) == true && sessArr.ValueKind == JsonValueKind.Array
            ? sessArr.GetArrayLength() : 0;
        var sessionsMenu = new Forms.ToolStripMenuItem($"Active Sessions ({sessionCount})");
        if (sessionCount > 0 && sessionsData is not null)
        {
            var shown = 0;
            foreach (var s in sessionsData.Value.GetProperty("sessions").EnumerateArray())
            {
                if (shown++ >= 8) break;
                var host = s.TryGetProperty("host", out var h) ? h.GetString() ?? "agent" : "agent";
                var folder = s.TryGetProperty("folder", out var f) ? f.GetString() ?? "" : "";
                var topic = s.TryGetProperty("claim", out var cl) && !string.IsNullOrEmpty(cl.GetString())
                    ? cl.GetString()!
                    : (s.TryGetProperty("topic", out var tp) ? tp.GetString() ?? "" : "");
                if (topic.Length > 48) topic = topic[..48] + "...";
                var label = $"[{host}] {(string.IsNullOrEmpty(folder) ? "" : folder + " — ")}{topic}";
                sessionsMenu.DropDownItems.Add(label, null, (_, _) => _window.OpenView(NexusView.Current));
            }
        }
        else
        {
            sessionsMenu.DropDownItems.Add(new Forms.ToolStripMenuItem("No active sessions") { Enabled = false });
        }
        _menu.Items.Add(sessionsMenu);

        _menu.Items.Add(new Forms.ToolStripSeparator());

        // Important Configurations
        var configMenu = new Forms.ToolStripMenuItem("Configuration");
        if (peersData?.TryGetProperty("responder", out var resp) == true)
        {
            var enabled = resp.TryGetProperty("enabled", out var en) && en.GetBoolean();
            var autonomy = resp.TryGetProperty("autonomy", out var au) ? au.GetString() ?? "safe" : "safe";
            configMenu.DropDownItems.Add($"Auto-reply: {(enabled ? "On" : "Off")} (toggle)", null,
                async (_, _) => await PostResponderAsync(new JsonObject { ["enabled"] = !enabled }));
            configMenu.DropDownItems.Add($"Autonomy: {autonomy} (switch to {(autonomy == "safe" ? "full" : "safe")})", null,
                async (_, _) => await PostResponderAsync(new JsonObject { ["autonomy"] = autonomy == "safe" ? "full" : "safe" }));
            configMenu.DropDownItems.Add(new Forms.ToolStripSeparator());
        }
        configMenu.DropDownItems.Add("Devices & Peers", null, (_, _) => _window.OpenView(NexusView.Devices));
        configMenu.DropDownItems.Add("Settings", null, (_, _) => _window.OpenView(NexusView.Settings));
        configMenu.DropDownItems.Add("Check for Updates", null, (_, _) => _window.OpenView(NexusView.Updates));
        configMenu.DropDownItems.Add("Start / Restart Service", null, async (_, _) => await _window.RestartServiceAsync());
        _menu.Items.Add(configMenu);

        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add("Exit Nexus", null, (_, _) => _window.ExitApplication());
    }

    private async Task PostResponderAsync(JsonObject payload)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/api/responder")
            {
                Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
            };
            req.Headers.Add("X-Nexus", "1");
            await _http.SendAsync(req);
        }
        catch { /* monitor offline */ }
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Dispose();
        _http.Dispose();
    }
}
