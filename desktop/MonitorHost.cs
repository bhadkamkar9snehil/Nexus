using System.Diagnostics;
using System.IO;
using System.Net.Http;

namespace Nexus.Desktop;

/// <summary>Ensures the local Nexus background service (monitor.mjs) is running, starting it directly if no scheduled task is available.</summary>
internal sealed class MonitorHost(string root)
{
    private const string StatusUrl = "http://127.0.0.1:8769/monitor-status";
    private readonly string _root = Path.GetFullPath(root);
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal async Task<bool> IsHealthyAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            var body = await http.GetStringAsync(StatusUrl);
            return body.Contains("shared-computer-use-monitor", StringComparison.Ordinal);
        }
        catch { return false; }
    }

    internal async Task<bool> EnsureRunningAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (await IsHealthyAsync()) return true;

            // 1. Try the managed scheduled task if present.
            try
            {
                using var task = Process.Start(new ProcessStartInfo("schtasks.exe", "/run /tn SharedHarness-Monitor")
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                });
                if (task is not null)
                {
                    await task.WaitForExitAsync();
                    if (task.ExitCode == 0 && await WaitHealthyAsync(TimeSpan.FromSeconds(4))) return true;
                }
            }
            catch { /* fall through to direct launch */ }

            // 2. Launch monitor.mjs directly as a hidden background process (no terminal window).
            var script = Path.Combine(_root, "monitor.mjs");
            if (!File.Exists(script)) return false;
            var bundledNode = Path.Combine(_root, "runtime", "node.exe");
            var node = File.Exists(bundledNode) ? bundledNode : "node";
            var info = new ProcessStartInfo(node, $"\"{script}\"")
            {
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            info.Environment["HARNESS_MONITOR_MANAGED"] = "1";
            Process.Start(info);
            return await WaitHealthyAsync(TimeSpan.FromSeconds(6));
        }
        catch { return false; }
        finally { _gate.Release(); }
    }

    private async Task<bool> WaitHealthyAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsHealthyAsync()) return true;
            await Task.Delay(300);
        }
        return false;
    }
}
