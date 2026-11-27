using System.ComponentModel;
using System.Net.Http;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Nexus.Desktop;

public partial class MainWindow : Window
{
    private const string Address = "http://127.0.0.1:8769/";
    private const string LocalAppOrigin = "https://app.nexus.local/";
    private string _root = AppContext.BaseDirectory;
    private SettingsHost? _settings;
    private UpdateHost? _updates;
    private MonitorHost? _monitor;
    private TrayIconHost? _tray;
    private NexusView _view;
    private bool _messaging;
    private bool _exiting;

    internal MainWindow(NexusView view)
    {
        _view = view;
        InitializeComponent();
        _tray = new TrayIconHost(this);
        Loaded += OnLoaded;
        StateChanged += (_, _) => { if (WindowState == WindowState.Minimized) Hide(); };
    }

    private Uri ViewAddress()
    {
        var hash = _view switch
        {
            NexusView.Inbox => "#/inbox",
            NexusView.Mail => "#/mail",
            NexusView.Devices => "#/devices",
            NexusView.Settings => "#/settings",
            NexusView.Updates => "#/updates",
            _ => ""
        };
        var baseUri = File.Exists(Path.Combine(_root, "desktop.html")) ? LocalAppOrigin + "desktop.html" : Address;
        return new Uri(baseUri + hash);
    }

    internal void OpenView(NexusView view)
    {
        if (view != NexusView.Current)
        {
            _view = view;
            if (Browser.CoreWebView2 is not null) Browser.Source = ViewAddress();
        }
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    internal void ExitApplication()
    {
        _exiting = true;
        _tray?.Dispose();
        _tray = null;
        Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_exiting)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _tray?.Dispose();
        _tray = null;
        base.OnClosing(e);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e) => await ConnectAsync();

    private async void RetryMonitor(object sender, RoutedEventArgs e) => await ConnectAsync();

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_settings is null || !Uri.TryCreate(e.Source, UriKind.Absolute, out var origin) ||
            !(origin.Host == "app.nexus.local" || (origin.Host == "127.0.0.1" && origin.Port == 8769))) return;
        using var request = JsonDocument.Parse(e.WebMessageAsJson);
        var type = request.RootElement.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
        JsonObject reply;
        if (type == "service.start" && _monitor is not null)
        {
            var id = request.RootElement.TryGetProperty("id", out var idEl) ? idEl.GetInt64() : 0;
            var ok = await _monitor.EnsureRunningAsync();
            reply = new JsonObject { ["id"] = id, ["ok"] = ok, ["message"] = ok ? "Service started." : "Could not start background service." };
        }
        else
        {
            reply = type.StartsWith("updates.", StringComparison.Ordinal) && _updates is not null
                ? await _updates.HandleAsync(request.RootElement, progress => Browser.CoreWebView2?.PostWebMessageAsJson(progress.ToJsonString()))
                : await _settings.HandleAsync(request.RootElement);
        }
        Browser.CoreWebView2.PostWebMessageAsJson(reply.ToJsonString());
    }

    // Looks for a new release on start, every 30 minutes, and right away when GitLab pushes a release or main pipeline event.
    private async Task WatchUpdatesAsync()
    {
        var updates = _updates;
        if (updates is null) return;
        var lastEvent = "";
        var due = DateTime.MinValue;
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        while (true)
        {
            var push = false;
            try
            {
                var events = JsonDocument.Parse(await http.GetStringAsync(Address + "webhook-events")).RootElement.GetProperty("events");
                var first = events.GetArrayLength() > 0 ? events[0] : (JsonElement?)null;
                var id = first?.GetProperty("id").GetString() ?? "";
                if (id != lastEvent) { push = lastEvent != "" && first!.Value.GetProperty("kind").GetString() is "release" or "pipeline"; lastEvent = id; }
            }
            catch { /* monitor offline; try again */ }
            if (push || DateTime.Now >= due)
            {
                due = DateTime.Now.AddMinutes(30);
                try
                {
                    if (await updates.CheckAsync() is { } tag)
                    {
                        Browser.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "updateAvailable", ["tag"] = tag }.ToJsonString());
                        NexusNotifications.Show("Nexus update available", $"Version {tag.TrimStart('v')} is ready to install.", NexusView.Updates);
                    }
                }
                catch { /* offline or not authorized yet; the Updates page explains */ }
            }
            await Task.Delay(TimeSpan.FromSeconds(10));
        }
    }

    internal Task<bool> RestartServiceAsync() => _monitor is not null ? _monitor.EnsureRunningAsync() : Task.FromResult(false);

    private async Task ConnectAsync()
    {
        try
        {
            _settings ??= new SettingsHost(_root);
            if (_updates is null) { _updates = new UpdateHost(_root); _ = WatchUpdatesAsync(); }
            _monitor ??= new MonitorHost(_root);
            _ = _monitor.EnsureRunningAsync();

            var dataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
            await Browser.EnsureCoreWebView2Async(environment);
            if (File.Exists(Path.Combine(_root, "desktop.html")))
                Browser.CoreWebView2.SetVirtualHostNameToFolderMapping("app.nexus.local", _root, CoreWebView2HostResourceAccessKind.Allow);
            Browser.CoreWebView2.NavigationStarting += RestrictNavigation;
            if (!_messaging) { Browser.CoreWebView2.WebMessageReceived += OnWebMessage; _messaging = true; }
            Browser.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            var settings = Browser.CoreWebView2.Settings;
            if (!settings.UserAgent.EndsWith("NexusDesktop/1.0", StringComparison.Ordinal))
                settings.UserAgent = (settings.UserAgent + " NexusDesktop/1.0").Trim();
            Browser.Source = ViewAddress();
            Unavailable.Visibility = Visibility.Collapsed;
            Browser.Visibility = Visibility.Visible;
        }
        catch (Exception ex)
        {
            Browser.Visibility = Visibility.Collapsed;
            ErrorText.Text = ex.Message;
            Unavailable.Visibility = Visibility.Visible;
        }
    }

    private static void RestrictNavigation(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) { e.Cancel = true; return; }
        var allowed = (uri.Scheme == "https" && uri.Host == "app.nexus.local") ||
                      (uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == 8769);
        if (!allowed) e.Cancel = true;
    }
}
