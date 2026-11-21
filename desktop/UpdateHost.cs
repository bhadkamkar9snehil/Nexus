using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Nexus.Desktop;

/// <summary>Updates from GitLab releases: list versions with their changelog, install or roll back to any release, push-triggered checks. Requests arrive over WebView2 messaging.</summary>
public sealed partial class UpdateHost(string root)
{
    private const string GitLab = "http://10.2.6.112:8080";
    private const string GitLabTailnet = "http://100.110.236.122:8080";
    private const string ProjectPath = "ssm%2Fshared-computer-use";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1";
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(10) };
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus");
    private static string TokenFile => Path.Combine(Folder, "gitlab-token.bin");
    private static string StateFile => Path.Combine(Folder, "updates.json");
    private readonly string _root = root;
    private readonly System.Threading.SemaphoreSlim _installGate = new(1, 1);
    private volatile bool _installerStarted;

    public string? NotifiedTag { get; private set; }

    public static string? CurrentVersion() => Registry.CurrentUser.OpenSubKey(UninstallKey)?.GetValue("DisplayVersion") as string;

    private bool IsInstalledHere()
    {
        using var key = Registry.CurrentUser.OpenSubKey(UninstallKey);
        return key?.GetValue("InstallLocation") is string location && string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(location)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(_root)), StringComparison.OrdinalIgnoreCase);
    }

    private static bool AutoUpdate()
    {
        try { return JsonNode.Parse(File.ReadAllText(StateFile))?["autoUpdate"]?.GetValue<bool>() == true; }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException) { return false; }
    }

    private static void SaveAutoUpdate(bool enabled)
    {
        Directory.CreateDirectory(Folder);
        var staged = StateFile + ".tmp";
        File.WriteAllText(staged, new JsonObject { ["autoUpdate"] = enabled }.ToJsonString());
        File.Move(staged, StateFile, true);
    }

    private static string? Token()
    {
        try { return File.Exists(TokenFile) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(TokenFile), null, DataProtectionScope.CurrentUser)) : null; }
        catch { return null; }
    }

    private static async Task<HttpResponseMessage> RequestAsync(string path)
    {
        var token = Token();
        foreach (var host in new[] { GitLabTailnet, GitLab })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, host + path);
            if (token is not null) request.Headers.Add("PRIVATE-TOKEN", token);
            using var timeout = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { return await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token); }
            catch (Exception ex) when (host == GitLabTailnet && (ex is HttpRequestException or OperationCanceledException)) { }
        }
        throw new InvalidOperationException("GitLab is unavailable.");
    }

    private static async Task<string> GetAsync(string path)
    {
        using var response = await RequestAsync(path);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.NotFound)
            throw new InvalidOperationException("GitLab refused the request. Save a GitLab access token with read_api scope below.");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    private static bool Newer(string tag, string? current) =>
        Version.TryParse(tag.TrimStart('v'), out var a) && (!Version.TryParse(current, out var b) || a > b);

    public record Release(string Tag, string Name, string Date, string Notes, string? InstallerUrl, string? Sha256);

    public static async Task<List<Release>> ReleasesAsync()
    {
        var rows = JsonNode.Parse(await GetAsync($"/api/v4/projects/{ProjectPath}/releases?per_page=30"))!.AsArray();
        return rows.Select(r =>
        {
            var notes = r!["description"]?.GetValue<string>() ?? "";
            var link = r["assets"]?["links"]?.AsArray().FirstOrDefault(l => (l?["name"]?.GetValue<string>() ?? "") is var filename &&
                filename.StartsWith("Nexus-Harness-Setup-", StringComparison.Ordinal) && filename.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
            var name = link?["name"]?.GetValue<string>();
            var sha = name is null ? null : Regex.Match(notes, "(?:" + Regex.Escape(name) + @": SHA256 |Windows installer SHA256: )([0-9a-fA-F]{64})").Groups[1].Value;
            return new Release(r["tag_name"]!.GetValue<string>(), r["name"]?.GetValue<string>() ?? "", r["released_at"]?.GetValue<string>() ?? "", notes,
                link?["url"]?.GetValue<string>(), string.IsNullOrEmpty(sha) ? null : sha.ToLowerInvariant());
        }).ToList();
    }

    /// <summary>Checks for a newer release; returns its tag when it has not been announced yet.</summary>
    public async Task<string?> CheckAsync()
    {
        var latest = (await ReleasesAsync()).FirstOrDefault(r => r.InstallerUrl is not null && r.Sha256 is not null);
        if (latest is not null && IsInstalledHere() && AutoUpdate() && Newer(latest.Tag, CurrentVersion()))
        {
            await InstallAsync(latest, automatic: true);
            return null;
        }
        if (latest is null || !Newer(latest.Tag, CurrentVersion()) || latest.Tag == NotifiedTag) return null;
        NotifiedTag = latest.Tag;
        return latest.Tag;
    }

    public async Task<JsonObject> HandleAsync(JsonElement request)
    {
        var id = request.TryGetProperty("id", out var i) ? i.GetInt32() : 0;
        string Text(string n) => request.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var reply = new JsonObject { ["id"] = id, ["ok"] = true };
        try
        {
            switch (Text("type"))
            {
                case "updates.list":
                    var current = CurrentVersion();
                    reply["current"] = current;
                    reply["tokenSaved"] = File.Exists(TokenFile);
                    reply["autoUpdate"] = AutoUpdate();
                    reply["autoUpdateAvailable"] = IsInstalledHere();
                    var releases = await ReleasesAsync();
                    reply["releases"] = new JsonArray(releases.Select(r => (JsonNode)new JsonObject
                    {
                        ["tag"] = r.Tag, ["name"] = r.Name, ["date"] = r.Date, ["notes"] = r.Notes,
                        ["installable"] = r.InstallerUrl is not null && r.Sha256 is not null,
                        ["isCurrent"] = current is not null && r.Tag.TrimStart('v') == current,
                        ["newer"] = Newer(r.Tag, current)
                    }).ToArray());
                    break;
                case "updates.saveToken":
                    var token = Text("token").Trim();
                    if (token.Length < 8 || token.Any(char.IsWhiteSpace)) { reply["ok"] = false; reply["message"] = "Enter a valid access token."; break; }
                    Directory.CreateDirectory(Folder);
                    File.WriteAllBytes(TokenFile, ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));
                    reply["message"] = "Token saved for this Windows account.";
                    break;
                case "updates.install":
                    var release = (await ReleasesAsync()).FirstOrDefault(r => r.Tag == Text("tag")) ?? throw new InvalidOperationException("That release was not found.");
                    reply["message"] = await InstallAsync(release);
                    break;
                case "updates.autoUpdate":
                    if (!IsInstalledHere()) throw new InvalidOperationException("Automatic updates require an installed copy of Nexus.");
                    var enabled = request.GetProperty("enabled").GetBoolean();
                    SaveAutoUpdate(enabled);
                    reply["autoUpdate"] = enabled;
                    break;
                case "updates.webhook":
                    var secret = (await File.ReadAllTextAsync(Path.Combine(_root, "secrets", "webhook-secret.txt"))).Trim();
                    var ip = (await Dns.GetHostAddressesAsync(Dns.GetHostName())).FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a));
                    reply["url"] = $"http://{ip}:8770/gitlab-webhook";
                    reply["secret"] = secret;
                    break;
                default: reply["ok"] = false; reply["message"] = "Unknown request."; break;
            }
        }
        catch (Exception ex) { reply["ok"] = false; reply["message"] = ex.Message; }
        return reply;
    }

    private async Task<string> InstallAsync(Release release, bool automatic = false)
    {
        if (!await _installGate.WaitAsync(0)) return "An update is already in progress.";
        try
        {
            if (_installerStarted) return "Nexus Setup is already running.";
            return await LaunchInstallerAsync(release, automatic);
        }
        finally { _installGate.Release(); }
    }

    private async Task<string> LaunchInstallerAsync(Release release, bool automatic)
    {
        if (release.InstallerUrl is null || release.Sha256 is null) throw new InvalidOperationException("That release has no installer with a published checksum, so it is not installed.");
        var asset = new Uri(release.InstallerUrl);
        if (asset.GetLeftPart(UriPartial.Authority) is not (GitLab or GitLabTailnet))
            throw new InvalidOperationException("Installer assets must be hosted by the configured GitLab server.");
        var directory = Path.Combine(Path.GetTempPath(), "Nexus-update");
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, Path.GetFileName(asset.AbsolutePath));
        using (var response = await RequestAsync(asset.PathAndQuery))
        {
            response.EnsureSuccessStatusCode();
            await using var output = File.Create(file);
            await response.Content.CopyToAsync(output);
        }
        string hash;
        await using (var stream = File.OpenRead(file)) hash = Convert.ToHexString(await SHA256.HashDataAsync(stream));
        if (!hash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(file);
            throw new InvalidOperationException("The download did not match the published checksum and was discarded.");
        }
        if (automatic && (!AutoUpdate() || !Newer(release.Tag, CurrentVersion()))) return "Automatic update cancelled.";
        if (!automatic && !Newer(release.Tag, CurrentVersion())) SaveAutoUpdate(false);
        // Keep the keys and tool assignments so a bad version can be rolled back without re-entering them.
        var secrets = Path.Combine(_root, "secrets");
        if (Directory.Exists(secrets))
        {
            var backup = Path.Combine(Folder, "backups", $"{DateTime.Now:yyyyMMdd-HHmmss}-{CurrentVersion() ?? "source"}");
            Directory.CreateDirectory(backup);
            foreach (var f in Directory.GetFiles(secrets)) File.Copy(f, Path.Combine(backup, Path.GetFileName(f)), true);
        }
        var installer = Process.Start(new ProcessStartInfo(file, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS") { UseShellExecute = true }) ?? throw new InvalidOperationException("Nexus Setup could not start.");
        _installerStarted = true;
        _ = ObserveInstallerAsync(installer);
        return $"Installing {release.Tag}. Nexus will close and reopen.";
    }

    private async Task ObserveInstallerAsync(Process installer)
    {
        using (installer)
        {
            try { await installer.WaitForExitAsync(); }
            finally { _installerStarted = false; }
        }
    }
}
