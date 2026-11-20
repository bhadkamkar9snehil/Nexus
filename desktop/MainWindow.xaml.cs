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
    private string _root = AppContext.BaseDirectory;
    private SettingsHost? _settings;
    private UpdateHost? _updates;
    private System.Windows.Forms.NotifyIcon? _tray;
    private bool _messaging;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += (_, _) => _tray?.Dispose();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e) => await ConnectAsync();

    private async void RetryMonitor(object sender, RoutedEventArgs e) => await ConnectAsync();

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_settings is null || !Uri.TryCreate(e.Source, UriKind.Absolute, out var origin) || origin.Host != "127.0.0.1" || origin.Port != 8769) return;
        using var request = JsonDocument.Parse(e.WebMessageAsJson);
        var type = request.RootElement.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
        var reply = type.StartsWith("updates.", StringComparison.Ordinal) && _updates is not null
            ? await _updates.HandleAsync(request.RootElement)
            : await _settings.HandleAsync(request.RootElement);
        Browser.CoreWebView2.PostWebMessageAsJson(reply.ToJsonString());
    }

    // Looks for a new release on start, every 30 minutes, and right away when GitLab pushes a release or main pipeline event.
    private async Task WatchUpdatesAsync()
    {
        if (_updates is null) return;
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
                    if (await _updates.CheckAsync() is { } tag)
                    {
                        _tray ??= new System.Windows.Forms.NotifyIcon { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!), Visible = true, Text = "Nexus Harness" };
                        _tray.BalloonTipClicked += (_, _) => Dispatcher.Invoke(() => { Show(); Activate(); Browser.CoreWebView2.Navigate(Address + "#/updates"); });
                        _tray.ShowBalloonTip(10000, "Nexus update available", $"Version {tag.TrimStart('v')} is ready. Open Updates to install it.", System.Windows.Forms.ToolTipIcon.Info);
                        Browser.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "updateAvailable", ["tag"] = tag }.ToJsonString());
                    }
                }
                catch { /* offline or not authorized yet; the Updates page explains */ }
            }
            await Task.Delay(TimeSpan.FromSeconds(10));
        }
    }

    private async Task ConnectAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            JsonDocument status;
            try { status = JsonDocument.Parse(await http.GetStringAsync(Address + "monitor-status")); }
            catch (HttpRequestException)
            {
                using var process = Process.Start(new ProcessStartInfo("schtasks.exe", "/run /tn SharedHarness-Monitor") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true }) ?? throw new InvalidOperationException("Unable to start the Nexus monitor task.");
                await process.WaitForExitAsync();
                if (process.ExitCode != 0) throw new InvalidOperationException("The Nexus monitor task is not installed or could not be started. Run Nexus setup first.");
                status = await WaitForMonitorAsync(http);
            }
            using (status)
            {
                if (status.RootElement.GetProperty("application").GetString() != "shared-computer-use-monitor")
                    throw new InvalidOperationException("Port 8769 is not serving the Nexus monitor.");
                var runningRoot = status.RootElement.GetProperty("root").GetString();
                _settings = new SettingsHost(string.IsNullOrEmpty(runningRoot) ? _root : runningRoot);
                if (_updates is null) { _updates = new UpdateHost(string.IsNullOrEmpty(runningRoot) ? _root : runningRoot); _ = WatchUpdatesAsync(); }
                if (File.Exists(Path.Combine(_root, "Setup.ps1")) &&
                    !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(_root)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(runningRoot ?? "")), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Another Nexus installation owns the monitor. Its settings were not changed.");
            }
            var dataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
            await Browser.EnsureCoreWebView2Async(environment);
            Browser.CoreWebView2.NavigationStarting += RestrictNavigation;
            if (!_messaging) { Browser.CoreWebView2.WebMessageReceived += OnWebMessage; _messaging = true; }
            Browser.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            Browser.Source = new Uri(Address);
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

    private static async Task<JsonDocument> WaitForMonitorAsync(HttpClient http)
    {
        for (var attempt = 0; attempt < 60; attempt++)
        {
            try { return JsonDocument.Parse(await http.GetStringAsync(Address + "monitor-status")); }
            catch (HttpRequestException) { await Task.Delay(500); }
        }
        throw new TimeoutException("The Nexus monitor did not start. Check the SharedHarness-Monitor task.");
    }

    private static void RestrictNavigation(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port != 8769)
            e.Cancel = true;
    }
}
