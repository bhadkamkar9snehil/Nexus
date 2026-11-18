using System.Net.Http;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Nexus.Desktop;

public partial class MainWindow : Window
{
    private const string Address = "http://127.0.0.1:8769/";
    private string _root = AppContext.BaseDirectory;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await ConnectAsync();
        if (!File.Exists(Path.Combine(_root, "secrets", "computeruse_1.xml")))
            new SettingsWindow(_root) { Owner = this }.ShowDialog();
    }

    private async void RetryMonitor(object sender, RoutedEventArgs e) => await ConnectAsync();

    private void OpenSettings(object sender, RoutedEventArgs e) => new SettingsWindow(_root) { Owner = this }.ShowDialog();

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
                if (File.Exists(Path.Combine(_root, "Setup.ps1")) &&
                    !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(_root)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(runningRoot ?? "")), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Another Nexus installation owns the monitor. Its settings were not changed.");
            }
            var dataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
            await Browser.EnsureCoreWebView2Async(environment);
            Browser.CoreWebView2.NavigationStarting += RestrictNavigation;
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
