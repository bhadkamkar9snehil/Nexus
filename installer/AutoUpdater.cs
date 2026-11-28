using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Nexus.Installation;

internal static partial class AutoUpdater
{
    private const string UninstallSubkey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1";
    private const string GitHubReleasesUrl = "https://api.github.com/repos/bhadkamkar9snehil/Nexus/releases?per_page=10";
    private const string GitHubDownloadPrefix = "https://github.com/bhadkamkar9snehil/Nexus/releases/download/";
    private static readonly string[] GitLabHosts = ["http://10.2.6.112:8080", "http://100.110.236.122:8080"];
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly HttpClient DownloadHttp = new(new HttpClientHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromMinutes(15) };

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DataBlob dataIn, IntPtr description, IntPtr optionalEntropy, IntPtr reserved, IntPtr promptStruct, int flags, out DataBlob dataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [GeneratedRegex(@"^v?\d+\.\d+\.\d+$")]
    private static partial Regex SafeVersionRegex();

    internal static async Task<int> RunAsync(string[] args, string logsFolder)
    {
        var installMode = false;
        var dryRun = false;
        var noRecovery = false;
        string? file = null;
        string? version = null;
        string? releasesJson = null;
        string? runsJson = null;
        string? installedVersion = null;
        int? idleSeconds = null;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--install": installMode = true; break;
                case "--dry-run": dryRun = true; break;
                case "--no-recovery": noRecovery = true; break;
                case "--current-user": break; // accepted from an older scheduled task; there is only one kind of install
                case "--file" when i + 1 < args.Length: file = args[++i]; break;
                case "--version" when i + 1 < args.Length: version = args[++i]; break;
                case "--releases-json" when i + 1 < args.Length: releasesJson = args[++i]; break;
                case "--runs-json" when i + 1 < args.Length: runsJson = args[++i]; break;
                case "--installed-version" when i + 1 < args.Length: installedVersion = args[++i]; break;
                case "--idle-seconds" when i + 1 < args.Length && int.TryParse(args[++i], out var parsedIdle): idleSeconds = parsedIdle; break;
                default: throw new ArgumentException($"Unknown auto-update option: {args[i]}");
            }
        }

        Directory.CreateDirectory(logsFolder);
        var logFile = Path.Combine(logsFolder, "auto-update.log");
        var root = SetupPath.Normalize(AppContext.BaseDirectory);

        if (installMode)
            return await ExecuteInstallAsync(root, logsFolder, logFile, file, version, noRecovery);

        return await CheckAndScheduleAsync(root, logsFolder, logFile, dryRun, releasesJson, runsJson, installedVersion, idleSeconds);
    }

    private static void Log(string logFile, string message)
    {
        try
        {
            File.AppendAllText(logFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static int Done(bool dryRun, string action, string reason, JsonObject? extra = null)
    {
        if (dryRun)
        {
            var obj = new JsonObject { ["action"] = action, ["reason"] = reason };
            if (extra is not null)
            {
                foreach (var kv in extra) obj[kv.Key] = kv.Value?.DeepClone();
            }
            Console.WriteLine(obj.ToJsonString());
        }
        return 0;
    }

    private static (string? Version, string? Location) GetUninstallInfo(string? installRoot)
    {
        (string? Version, string? Location, Version Parsed, bool Matches) best = (null, null, new Version(0, 0, 0), false);
        var normalizedRoot = installRoot is not null && Path.IsPathFullyQualified(installRoot)
            ? SetupPath.Normalize(installRoot)
            : null;
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            using var key = hive.OpenSubKey(UninstallSubkey);
            if (key is null) continue;
            var ver = key.GetValue("DisplayVersion") as string;
            var loc = key.GetValue("InstallLocation") as string;
            var matches = normalizedRoot is not null && !string.IsNullOrWhiteSpace(loc) && Path.IsPathFullyQualified(loc) &&
                SetupPath.Normalize(loc).Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase);
            var parsed = Version.TryParse(ver?.Split('-')[0], out var v) ? v : new Version(0, 0, 0);
            var take = best.Version is null
                || (matches && !best.Matches)
                || (matches == best.Matches && parsed > best.Parsed);
            if (take) best = (ver, loc, parsed, matches);
        }
        return (best.Version, best.Location);
    }

    private static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static string? ReadGitLabToken(string logsFolder)
    {
        try
        {
            var tokenFile = Path.Combine(logsFolder, "gitlab-token.bin");
            if (!File.Exists(tokenFile)) return null;
            var encrypted = File.ReadAllBytes(tokenFile);
            var handle = GCHandle.Alloc(encrypted, GCHandleType.Pinned);
            try
            {
                var input = new DataBlob { cbData = encrypted.Length, pbData = handle.AddrOfPinnedObject() };
                if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out var output))
                    return null;
                try
                {
                    var plain = new byte[output.cbData];
                    Marshal.Copy(output.pbData, plain, 0, output.cbData);
                    return Encoding.UTF8.GetString(plain).Trim();
                }
                finally { LocalFree(output.pbData); }
            }
            finally { handle.Free(); }
        }
        catch { return null; }
    }

    private static async Task<List<JsonNode?>> FetchReleasesAsync(string? releasesJson, string? token)
    {
        var all = new List<JsonNode?>();
        if (!string.IsNullOrEmpty(releasesJson))
        {
            if (JsonNode.Parse(await File.ReadAllTextAsync(releasesJson)) is JsonArray arr)
                all.AddRange(arr);
            return all;
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(7));
        async Task<JsonArray?> FetchGitHub()
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, GitHubReleasesUrl);
                req.Headers.UserAgent.ParseAdd("Nexus-Harness-Updater");
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
                using var resp = await Http.SendAsync(req, cts.Token);
                if (!resp.IsSuccessStatusCode) return null;
                return JsonNode.Parse(await resp.Content.ReadAsStringAsync(cts.Token)) as JsonArray;
            }
            catch { return null; }
        }

        async Task<JsonArray?> FetchGitLab(string host)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, $"{host}/api/v4/projects/ssm%2Fshared-computer-use/releases?per_page=10");
                if (!string.IsNullOrEmpty(token)) req.Headers.TryAddWithoutValidation("PRIVATE-TOKEN", token);
                using var resp = await Http.SendAsync(req, cts.Token);
                if (!resp.IsSuccessStatusCode) return null;
                return JsonNode.Parse(await resp.Content.ReadAsStringAsync(cts.Token)) as JsonArray;
            }
            catch { return null; }
        }

        var ghTask = FetchGitHub();
        var glTasks = GitLabHosts.Select(FetchGitLab).ToArray();
        await Task.WhenAll(glTasks.Prepend(ghTask));

        if (await ghTask is { } ghArr) all.AddRange(ghArr);
        foreach (var t in glTasks)
        {
            if (await t is { } glArr) { all.AddRange(glArr); break; }
        }
        return all;
    }

    private sealed record CandidateRelease(string Tag, Version Version, string FileName, string Source, string UrlOrPath, string Sha256);

    private static CandidateRelease? SelectLatestRelease(IEnumerable<JsonNode?> releases)
    {
        CandidateRelease? best = null;
        foreach (var node in releases)
        {
            var tag = node?["tag_name"]?.GetValue<string>() ?? "";
            if (!SafeVersionRegex().IsMatch(tag)) continue;
            if (!Version.TryParse(tag.TrimStart('v'), out var parsed)) continue;
            var filename = $"Nexus-Harness-Setup-{tag.TrimStart('v')}-windows-x64.exe";
            var notes = node?["body"]?.GetValue<string>() ?? node?["description"]?.GetValue<string>() ?? "";
            var shaMatch = Regex.Match(notes, Regex.Escape(filename) + @": SHA256 ([0-9a-fA-F]{64})");
            if (!shaMatch.Success) continue;
            var sha = shaMatch.Groups[1].Value.ToLowerInvariant();

            CandidateRelease? candidate = null;
            if (node?["assets"] is JsonArray ghAssets)
            {
                var asset = ghAssets.FirstOrDefault(a => a?["name"]?.GetValue<string>() == filename);
                var url = asset?["browser_download_url"]?.GetValue<string>();
                var expected = $"{GitHubDownloadPrefix}{tag}/{filename}";
                var digest = asset?["digest"]?.GetValue<string>();
                if (url == expected && (string.IsNullOrEmpty(digest) || digest.Equals("sha256:" + sha, StringComparison.OrdinalIgnoreCase)))
                    candidate = new CandidateRelease(tag, parsed, filename, "github", expected, sha);
            }
            if (candidate is null && node?["assets"]?["links"] is JsonArray glLinks)
            {
                var link = glLinks.FirstOrDefault(l => l?["name"]?.GetValue<string>() == filename);
                var urlStr = link?["url"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(urlStr) && Uri.TryCreate(urlStr, UriKind.Absolute, out var uri))
                {
                    var authority = uri.GetLeftPart(UriPartial.Authority);
                    if (GitLabHosts.Contains(authority, StringComparer.OrdinalIgnoreCase))
                        candidate = new CandidateRelease(tag, parsed, filename, "gitlab", uri.PathAndQuery, sha);
                }
            }

            if (candidate is not null && (best is null || candidate.Version > best.Version))
                best = candidate;
        }
        return best;
    }

    private static async Task<string> FileSha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
    }

    private static async Task<bool> DownloadFileAsync(string url, string dest, string? token)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            if (!string.IsNullOrEmpty(token)) req.Headers.TryAddWithoutValidation("PRIVATE-TOKEN", token);
            using var resp = await DownloadHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            if (!resp.IsSuccessStatusCode) return false;
            await using var input = await resp.Content.ReadAsStreamAsync();
            await using var output = File.Create(dest);
            await input.CopyToAsync(output);
            return true;
        }
        catch { return false; }
    }

    private static async Task<int> CheckAndScheduleAsync(string root, string logsFolder, string logFile, bool dryRun,
        string? releasesJson, string? runsJson, string? installedVersion, int? idleSeconds)
    {
        var (regVer, regLoc) = GetUninstallInfo(root);
        var installed = !string.IsNullOrWhiteSpace(installedVersion) ? installedVersion : regVer;
        if (string.IsNullOrWhiteSpace(installed)) return Done(dryRun, "none", "not installed from an installer");
        if (string.IsNullOrWhiteSpace(installedVersion) && (string.IsNullOrWhiteSpace(regLoc) || !SetupPath.Normalize(regLoc).Equals(root, StringComparison.OrdinalIgnoreCase)))
            return Done(dryRun, "none", "this copy is not the installed one");

        try
        {
            var stateFile = Path.Combine(logsFolder, "updates.json");
            if (File.Exists(stateFile) && JsonNode.Parse(await File.ReadAllTextAsync(stateFile))?["autoUpdate"]?.GetValue<bool>() == false)
                return Done(dryRun, "none", "automatic updates are switched off");
        }
        catch { }

        var token = ReadGitLabToken(logsFolder);
        var releases = await FetchReleasesAsync(releasesJson, token);
        if (releases.Count == 0) return Done(dryRun, "none", "GitHub and GitLab releases are unreachable");

        var latest = SelectLatestRelease(releases);
        if (latest is null) return Done(dryRun, "none", "no release with an installer and a checksum");
        if (!Version.TryParse(installed.Split('-')[0], out var installedParsed) || latest.Version <= installedParsed)
            return Done(dryRun, "none", $"already on {installed}");

        var stagedDir = Path.Combine(logsFolder, "staged");
        var staged = Path.Combine(stagedDir, latest.FileName);
        if (!dryRun)
        {
            Directory.CreateDirectory(stagedDir);
            foreach (var oldExe in Directory.GetFiles(stagedDir, "Nexus-Harness-Setup-*.exe"))
            {
                if (!oldExe.Equals(staged, StringComparison.OrdinalIgnoreCase))
                    try { File.Delete(oldExe); } catch { }
            }
            if (!File.Exists(staged) || await FileSha256Async(staged) != latest.Sha256)
            {
                var ok = false;
                if (latest.Source == "github" && !string.IsNullOrEmpty(token))
                {
                    var lanAsset = $"{GitLabHosts[0]}/api/v4/projects/ssm%2Fshared-computer-use/packages/generic/nexus-harness/{latest.Tag[1..]}/{latest.FileName}";
                    ok = await DownloadFileAsync(lanAsset, staged, token) && await FileSha256Async(staged) == latest.Sha256;
                }
                if (!ok && latest.Source == "github")
                {
                    ok = await DownloadFileAsync(latest.UrlOrPath, staged, null);
                }
                else if (!ok)
                {
                    foreach (var host in GitLabHosts)
                    {
                        if (await DownloadFileAsync(host + latest.UrlOrPath, staged, token)) { ok = true; break; }
                    }
                }
                if (ok && await FileSha256Async(staged) != latest.Sha256)
                {
                    try { File.Delete(staged); } catch { }
                    ok = false;
                    Log(logFile, $"Discarded a download that did not match the published checksum for {latest.Tag}");
                }
                if (!ok) return Done(dryRun, "none", "download failed; will retry");
                Log(logFile, $"Downloaded and verified {latest.FileName}");
            }
        }

        // Quiet-moment checks: no running tool calls, owner idle >= 300s, no setup running.
        JsonArray? runsArr = null;
        try
        {
            if (!string.IsNullOrEmpty(runsJson))
                runsArr = JsonNode.Parse(await File.ReadAllTextAsync(runsJson)) as JsonArray;
            else
            {
                using var runsCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var body = await Http.GetStringAsync("http://127.0.0.1:8769/runs", runsCts.Token);
                runsArr = JsonNode.Parse(body) as JsonArray;
            }
        }
        catch { }

        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (runsArr is not null && runsArr.Any(r => r?["status"]?.GetValue<string>() == "running" &&
            (nowMs - (r["started"]?.GetValue<long>() ?? 0)) < 150_000))
            return Done(dryRun, "wait", "a tool call is running", new JsonObject { ["latest"] = latest.Tag });

        var idle = idleSeconds ?? -1;
        if (idle < 0)
        {
            var info = new LastInputInfo { cbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
            idle = GetLastInputInfo(ref info) ? Math.Max(0, unchecked(Environment.TickCount - (int)info.dwTime) / 1000) : 0;
        }
        if (UacWillAsk())
        {
            if (idle > 60) return Done(dryRun, "wait", "waiting for the owner, who must approve the administrator request", new JsonObject { ["latest"] = latest.Tag });
        }
        else if (idle < 300) return Done(dryRun, "wait", $"the owner is active (idle {idle}s)", new JsonObject { ["latest"] = latest.Tag });

        if (FailedRecently(logsFolder, latest.Tag))
            return Done(dryRun, "wait", "this version failed or was declined within the last day; use Update now to retry", new JsonObject { ["latest"] = latest.Tag });

        if (Process.GetProcesses().Any(p => p.ProcessName.StartsWith("Nexus-Harness-Setup", StringComparison.OrdinalIgnoreCase)))
            return Done(dryRun, "wait", "an installer is already running");

        if (dryRun) return Done(dryRun, "install", "quiet moment", new JsonObject { ["latest"] = latest.Tag, ["installed"] = installed });

        var secretsDir = Path.Combine(root, "secrets");
        if (Directory.Exists(secretsDir))
        {
            var backupDir = Path.Combine(logsFolder, "backups", $"{DateTime.Now:yyyyMMdd-HHmmss}-{installed}");
            Directory.CreateDirectory(backupDir);
            foreach (var f in Directory.GetFiles(secretsDir))
                File.Copy(f, Path.Combine(backupDir, Path.GetFileName(f)), overwrite: true);
        }

        var setupExe = Path.Combine(root, "Nexus.Setup.exe");
        var arguments = $"auto-update --install --file \"{staged}\" --version {latest.Tag}";
        try
        {
            ScheduleAndStartInstallTask(setupExe, arguments, root);
        }
        catch (Exception ex)
        {
            Log(logFile, $"Could not schedule the verified Nexus update: {ex.Message}");
            return 1;
        }
        Log(logFile, $"Starting the update from {installed} to {latest.Tag}");
        return 0;
    }

    // Always created and run with normal rights, so the monitor can always replace it. Only Setup itself is elevated.
    private const string InstallTaskName = "Nexus-Update";

    /// <summary>False when Windows grants this process administrator rights without asking anyone.</summary>
    private static bool UacWillAsk()
    {
        if (IsElevated()) return false;
        using var policy = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
        if (policy?.GetValue("EnableLUA") is int lua && lua == 0) return false;
        return !(policy?.GetValue("ConsentPromptBehaviorAdmin") is int consent && consent == 0);
    }

    private static bool FailedRecently(string logsFolder, string tag)
    {
        try
        {
            var receipt = JsonNode.Parse(File.ReadAllText(Path.Combine(logsFolder, "last-install-receipt.json")));
            return receipt?["version"]?.GetValue<string>() == tag && receipt["exitCode"]?.GetValue<int>() != 0 &&
                DateTimeOffset.UtcNow - DateTimeOffset.Parse(receipt["recordedAtUtc"]!.GetValue<string>()) < TimeSpan.FromHours(24);
        }
        catch { return false; }
    }

    private static void ScheduleAndStartInstallTask(string exePath, string arguments, string workingDir)
    {
        using var identity = WindowsIdentity.GetCurrent();
        dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", throwOnError: true)!)!;
        service.Connect();
        dynamic folder = service.GetFolder(@"\");
        dynamic definition = service.NewTask(0);
        definition.Principal.UserId = identity.Name;
        definition.Principal.LogonType = 3; // Interactive
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        definition.Settings.ExecutionTimeLimit = "PT30M";
        dynamic action = definition.Actions.Create(0);
        action.Path = exePath;
        action.Arguments = arguments;
        action.WorkingDirectory = workingDir;
        dynamic task = folder.RegisterTaskDefinition(InstallTaskName, definition, 6, identity.Name, null, 3, null);
        task.Run(null);
    }

    private static async Task<int> ExecuteInstallAsync(string root, string logsFolder, string logFile, string? file, string? version, bool noRecovery)
    {
        var safeVersion = version is not null && SafeVersionRegex().IsMatch(version) ? version.TrimStart('v') : "unknown";
        var installerLog = Path.Combine(logsFolder, $"installer-{safeVersion}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        var resultCode = 1;
        var installerExitCode = -1;
        var monitorReady = false;

        try
        {
            if (string.IsNullOrWhiteSpace(file) || !File.Exists(file))
                throw new InvalidOperationException("The staged Nexus installer is missing.");
            if (safeVersion == "unknown")
                throw new InvalidOperationException("Invalid target Nexus version.");

            Log(logFile, noRecovery ? "Installer rollback disabled by explicit command-line option." : $"Installing {version}; installer diagnostic log: {installerLog}");
            // One kind of install: Setup requires administrator rights and raises the UAC request itself.
            var start = new ProcessStartInfo(file)
            {
                UseShellExecute = true,
                WorkingDirectory = root,
            };
            foreach (var arg in new[] { "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", $"/LOG={installerLog}" })
                start.ArgumentList.Add(arg);

            using var proc = Process.Start(start) ?? throw new InvalidOperationException("Could not start the Nexus installer.");
            await proc.WaitForExitAsync();
            installerExitCode = proc.ExitCode;
            resultCode = installerExitCode;
            Log(logFile, $"Installer finished with exit code {resultCode}; log: {installerLog}");

            if (resultCode == 0)
            {
                var (regVer, regLoc) = GetUninstallInfo(root);
                if (!string.Equals(regVer, safeVersion, StringComparison.OrdinalIgnoreCase))
                {
                    Log(logFile, $"Installer exited successfully, but installed version was not verified (registered: {regVer})");
                    resultCode = 1;
                }
                else
                {
                    monitorReady = await WaitMonitorHealthyAsync(regLoc ?? root);
                    if (!monitorReady)
                    {
                        Log(logFile, "Installed version matches, but the managed Nexus monitor or its scheduled task is not healthy.");
                        resultCode = 1;
                    }
                    else
                    {
                        Log(logFile, $"Installed Nexus version and running managed monitor verified: {regVer}");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log(logFile, $"Installer execution failed: {ex.Message}");
            resultCode = 1;
        }
        finally
        {
            if (resultCode == 0)
            {
                try
                {
                    var stagedDir = Path.Combine(logsFolder, "staged");
                    if (!string.IsNullOrEmpty(file) && File.Exists(file) &&
                        SetupPath.Normalize(Path.GetDirectoryName(file)!).Equals(SetupPath.Normalize(stagedDir), StringComparison.OrdinalIgnoreCase))
                        File.Delete(file);
                }
                catch { }
            }
            SaveReceipt(logsFolder, logFile, version ?? "unknown", resultCode, monitorReady, installerLog, installerExitCode);
            try
            {
                dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", throwOnError: true)!)!;
                service.Connect();
                service.GetFolder(@"\").DeleteTask(InstallTaskName, 0);
            }
            catch { }
        }
        return resultCode;
    }

    private static async Task<bool> WaitMonitorHealthyAsync(string installRoot)
    {
        if (!Path.IsPathFullyQualified(installRoot)) return false;
        var expectedRoot = SetupPath.Normalize(installRoot);
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                var body = await Http.GetStringAsync("http://127.0.0.1:8769/monitor-status", cts.Token);
                using var doc = JsonDocument.Parse(body);
                var rootEl = doc.RootElement;
                if (rootEl.GetProperty("application").GetString() == "shared-computer-use-monitor" &&
                    rootEl.GetProperty("managed").GetBoolean() &&
                    rootEl.GetProperty("root").GetString() is { } r &&
                    Path.IsPathFullyQualified(r) &&
                    SetupPath.Normalize(r).Equals(expectedRoot, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            catch { }
            if (attempt < 9) await Task.Delay(2000);
        }
        return false;
    }

    private static void SaveReceipt(string logsFolder, string logFile, string version, int exitCode, bool monitorReady, string installerLog, int installerExitCode)
    {
        var receipt = new JsonObject
        {
            ["version"] = version,
            ["recordedAtUtc"] = DateTimeOffset.UtcNow.ToString("o"),
            ["exitCode"] = exitCode,
            ["installerExitCode"] = installerExitCode,
            ["monitorVerified"] = monitorReady,
            ["installerLog"] = installerLog
        };
        var receiptFile = Path.Combine(logsFolder, "last-install-receipt.json");
        var tempFile = $"{receiptFile}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tempFile, receipt.ToJsonString(), new UTF8Encoding(false));
            File.Move(tempFile, receiptFile, overwrite: true);
        }
        catch (Exception ex) { Log(logFile, $"Could not save installer receipt: {ex.GetType().Name}"); }
        finally { try { File.Delete(tempFile); } catch { } }
    }
}
