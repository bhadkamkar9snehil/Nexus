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

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
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
            if (status.RootElement.GetProperty("application").GetString() != "shared-computer-use-monitor")
                throw new InvalidOperationException("Port 8769 is not serving the Nexus monitor.");
            var dataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
            await Browser.EnsureCoreWebView2Async(environment);
            Browser.CoreWebView2.NavigationStarting += RestrictNavigation;
            Browser.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            Browser.Source = new Uri(Address);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Nexus could not open its monitor. Start the Nexus monitor and try again.\n\n{ex.Message}", "Nexus", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
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
