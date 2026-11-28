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

/// <summary>Updates from GitHub and GitLab releases: check sources in parallel, list versions with source and changelog, install or roll back to any release, push-triggered checks. Requests arrive over WebView2 messaging.</summary>
public sealed partial class UpdateHost(string root)
{
    private const string GitLab = "http://10.2.6.112:8080";
    private const string GitLabTailnet = "http://100.110.236.122:8080";
    private const string GitHubApi = "https://api.github.com/repos/bhadkamkar9snehil/Nexus/releases?per_page=30";
    private const string GitHubDownloadPrefix = "https://github.com/bhadkamkar9snehil/Nexus/releases/download/";
    private const string ProjectPath = "ssm%2Fshared-computer-use";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1";
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(10) };
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus");
    private static string TokenFile => Path.Combine(Folder, "gitlab-token.bin");
    private static string StateFile => Path.Combine(Folder, "updates.json");
    private readonly string _root = root;
    private readonly System.Threading.SemaphoreSlim _installGate = new(1, 1);

    public string? NotifiedTag { get; private set; }

    private static RegistryKey? OpenUninstallKey(string? installRoot = null)
    {
        RegistryKey? best = null;
        Version? bestVersion = null;
        var bestMatchesRoot = false;
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            var key = hive.OpenSubKey(UninstallKey);
            if (key is null) continue;
            var matchesRoot = installRoot is not null &&
                key.GetValue("InstallLocation") is string location &&
                string.Equals(
                    Path.TrimEndingDirectorySeparator(Path.GetFullPath(location)),
                    Path.TrimEndingDirectorySeparator(Path.GetFullPath(installRoot)),
                    StringComparison.OrdinalIgnoreCase);
            var version = Version.TryParse((key.GetValue("DisplayVersion") as string)?.Split('-')[0], out var parsed)
                ? parsed
                : new Version(0, 0, 0);
            var take = best is null
                || (matchesRoot && !bestMatchesRoot)
                || (matchesRoot == bestMatchesRoot && version > bestVersion);
            if (take)
            {
                best?.Dispose();
                best = key;
                bestVersion = version;
                bestMatchesRoot = matchesRoot;
            }
            else
            {
                key.Dispose();
            }
        }
        return best;
    }

    public static string? CurrentVersion()
    {
        using var key = OpenUninstallKey();
        return key?.GetValue("DisplayVersion") as string;
    }

    private bool IsInstalledHere()
    {
        using var key = OpenUninstallKey(_root);
        return key?.GetValue("InstallLocation") is string location && string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(location)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(_root)), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Automatic updates are on unless the owner switched them off. Update-Nexus.ps1 (run by the monitor) does the installing, in a quiet moment.</summary>
    private static bool AutoUpdate()
    {
        try { return JsonNode.Parse(File.ReadAllText(StateFile))?["autoUpdate"]?.GetValue<bool>() != false; }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException) { return true; }
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

    private static async Task<HttpResponseMessage> RequestGitLabAsync(string path, TimeSpan? perHostTimeout = null, CancellationToken outerToken = default)
    {
        var token = Token();
        using var raceCts = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
        var hosts = new[] { GitLab, GitLabTailnet };

        async Task<HttpResponseMessage> ProbeAsync(string host)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, host + path);
            if (token is not null) request.Headers.Add("PRIVATE-TOKEN", token);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(raceCts.Token);
            timeoutCts.CancelAfter(perHostTimeout ?? TimeSpan.FromSeconds(5));
            return await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
        }

        var pending = hosts.Select(ProbeAsync).ToList();
        while (pending.Count > 0)
        {
            var finished = await Task.WhenAny(pending);
            pending.Remove(finished);
            try
            {
                var response = await finished;
                raceCts.Cancel();
                foreach (var other in pending) _ = other.ContinueWith(t => { if (t.IsCompletedSuccessfully) t.Result.Dispose(); }, TaskScheduler.Default);
                return response;
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !outerToken.IsCancellationRequested)
            {
                // This host failed or timed out; let the other host finish if still running.
            }
        }
        throw new InvalidOperationException("GitLab is unavailable.");
    }

    private static async Task<string> GetGitLabAsync(string path)
    {
        using var response = await RequestGitLabAsync(path);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.NotFound)
            throw new InvalidOperationException("GitLab refused the request. Save a GitLab access token with read_api scope below.");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    private static async Task<HttpResponseMessage> RequestGitHubAsync(Uri uri, TimeSpan timeout, CancellationToken outerToken = default)
    {
        var current = uri;
        for (var hop = 0; hop < 6; hop++)
        {
            if (current.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("GitHub asset redirects must use HTTPS.");
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Add("User-Agent", "Nexus-Harness-Updater");
            if (current.Host.Equals("api.github.com", StringComparison.OrdinalIgnoreCase))
                request.Headers.Add("Accept", "application/vnd.github+json");
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
            timeoutCts.CancelAfter(timeout);
            var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308 && response.Headers.Location is { } location)
            {
                response.Dispose();
                current = location.IsAbsoluteUri ? location : new Uri(current, location);
                continue;
            }
            return response;
        }
        throw new InvalidOperationException("Too many redirects while contacting GitHub.");
    }

    private static bool Newer(string tag, string? current) =>
        Version.TryParse(tag.TrimStart('v'), out var a) && (!Version.TryParse(current, out var b) || a > b);

    private static Version ParseTagVersion(string tag) =>
        Version.TryParse(tag.TrimStart('v'), out var v) ? v : new Version(0, 0, 0);

    private static string? ExtractSha256(string notes, string? assetName)
    {
        if (string.IsNullOrEmpty(assetName)) return null;
        var sha = Regex.Match(notes, "(?:" + Regex.Escape(assetName) + @": SHA256 |Windows installer SHA256: )([0-9a-fA-F]{64})").Groups[1].Value;
        return string.IsNullOrEmpty(sha) ? null : sha.ToLowerInvariant();
    }

    public record Release(string Tag, string Name, string Date, string Notes, string? InstallerUrl, string? Sha256, string Source);

    public record ReleasesResult(List<Release> Releases, string? GitHubError, string? GitLabError);

    public static async Task<List<Release>> GitLabReleasesAsync()
    {
        var rows = JsonNode.Parse(await GetGitLabAsync($"/api/v4/projects/{ProjectPath}/releases?per_page=30"))!.AsArray();
        return rows.Select(r =>
        {
            var notes = r!["description"]?.GetValue<string>() ?? "";
            var link = r["assets"]?["links"]?.AsArray().FirstOrDefault(l => (l?["name"]?.GetValue<string>() ?? "") is var filename &&
                filename.StartsWith("Nexus-Harness-Setup-", StringComparison.Ordinal) && filename.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
            var name = link?["name"]?.GetValue<string>();
            var sha = ExtractSha256(notes, name);
            return new Release(r["tag_name"]!.GetValue<string>(), r["name"]?.GetValue<string>() ?? "", r["released_at"]?.GetValue<string>() ?? "", notes,
                link?["url"]?.GetValue<string>(), sha, "gitlab");
        }).ToList();
    }

    public static async Task<List<Release>> GitHubReleasesAsync()
    {
        using var response = await RequestGitHubAsync(new Uri(GitHubApi), TimeSpan.FromSeconds(6));
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"GitHub returned HTTP {(int)response.StatusCode}.");
        var rows = JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsArray();
        return rows.Select(r =>
        {
            var tag = r!["tag_name"]!.GetValue<string>();
            var notes = r["body"]?.GetValue<string>() ?? "";
            var asset = r["assets"]?.AsArray().FirstOrDefault(a => (a?["name"]?.GetValue<string>() ?? "") is var filename &&
                filename.StartsWith("Nexus-Harness-Setup-", StringComparison.Ordinal) && filename.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
            var name = asset?["name"]?.GetValue<string>();
            var url = asset?["browser_download_url"]?.GetValue<string>();
            var sha = ExtractSha256(notes, name);
            var digest = asset?["digest"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(digest) && sha is not null && !digest.Equals("sha256:" + sha, StringComparison.OrdinalIgnoreCase))
                sha = null;
            if (url is not null && !url.StartsWith(GitHubDownloadPrefix + tag + "/", StringComparison.Ordinal))
                url = null;
            var date = r["published_at"]?.GetValue<string>() ?? r["created_at"]?.GetValue<string>() ?? "";
            return new Release(tag, r["name"]?.GetValue<string>() ?? "", date, notes, url, sha, "github");
        }).ToList();
    }

    public static async Task<ReleasesResult> FetchAllReleasesAsync()
    {
        async Task<(List<Release> List, string? Error)> TryFetch(Func<Task<List<Release>>> fn, string fallback)
        {
            try { return (await fn(), null); }
            catch (Exception ex) { return ([], string.IsNullOrWhiteSpace(ex.Message) ? fallback : ex.Message); }
        }

        var githubTask = TryFetch(GitHubReleasesAsync, "GitHub is unavailable.");
        var gitlabTask = TryFetch(GitLabReleasesAsync, "GitLab is unavailable.");
        await Task.WhenAll(githubTask, gitlabTask);

        var (gh, ghErr) = await githubTask;
        var (gl, glErr) = await gitlabTask;
        if (ghErr is not null && glErr is not null)
            throw new InvalidOperationException($"{ghErr} {glErr}");

        var combined = gh.Concat(gl)
            .OrderByDescending(r => ParseTagVersion(r.Tag))
            .ThenBy(r => r.Source, StringComparer.Ordinal)
            .ToList();
        return new ReleasesResult(combined, ghErr, glErr);
    }

    public static async Task<List<Release>> ReleasesAsync() => (await FetchAllReleasesAsync()).Releases;

    /// <summary>Checks for a newer release; returns its tag when it has not been announced yet.</summary>
    public async Task<string?> CheckAsync()
    {
        var latest = (await ReleasesAsync()).FirstOrDefault(r => r.InstallerUrl is not null && r.Sha256 is not null);
        if (latest is null || !Newer(latest.Tag, CurrentVersion()) || latest.Tag == NotifiedTag) return null;
        NotifiedTag = latest.Tag;
        return latest.Tag;
    }

    public async Task<JsonObject> HandleAsync(JsonElement request, Action<JsonObject> notify)
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
                    var result = await FetchAllReleasesAsync();
                    reply["sources"] = new JsonObject
                    {
                        ["github"] = new JsonObject { ["ok"] = result.GitHubError is null, ["error"] = result.GitHubError },
                        ["gitlab"] = new JsonObject { ["ok"] = result.GitLabError is null, ["error"] = result.GitLabError }
                    };
                    reply["releases"] = new JsonArray(result.Releases.Select(r => (JsonNode)new JsonObject
                    {
                        ["tag"] = r.Tag, ["name"] = r.Name, ["date"] = r.Date, ["notes"] = r.Notes,
                        ["source"] = r.Source,
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
                    var requestedTag = Text("tag");
                    var requestedSource = Text("source");
                    void Progress(string message, int? percent = null) => notify(new JsonObject
                    {
                        ["type"] = "updateProgress", ["tag"] = requestedTag, ["source"] = requestedSource, ["message"] = message,
                        ["percent"] = percent
                    });
                    Progress("Looking up the release");
                    var allReleases = await ReleasesAsync();
                    var release = (!string.IsNullOrEmpty(requestedSource)
                        ? allReleases.FirstOrDefault(r => r.Tag == requestedTag && r.Source == requestedSource)
                        : allReleases.FirstOrDefault(r => r.Tag == requestedTag && r.InstallerUrl is not null && r.Sha256 is not null)
                            ?? allReleases.FirstOrDefault(r => r.Tag == requestedTag))
                        ?? throw new InvalidOperationException("That release was not found.");
                    reply["message"] = await InstallAsync(release, Progress);
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

    private async Task<string> InstallAsync(Release release, Action<string, int?> progress)
    {
        if (!await _installGate.WaitAsync(0)) throw new InvalidOperationException("An update is already in progress.");
        try
        {
            return await LaunchInstallerAsync(release, progress);
        }
        finally { _installGate.Release(); }
    }

    private async Task<string> LaunchInstallerAsync(Release release, Action<string, int?> progress)
    {
        if (release.InstallerUrl is null || release.Sha256 is null) throw new InvalidOperationException("That release has no installer with a published checksum, so it is not installed.");
        var asset = new Uri(release.InstallerUrl);
        if (release.Source == "github")
        {
            if (asset.Scheme != Uri.UriSchemeHttps || !release.InstallerUrl.StartsWith(GitHubDownloadPrefix + release.Tag + "/", StringComparison.Ordinal))
                throw new InvalidOperationException("GitHub installer assets must come from the configured GitHub repository.");
        }
        else if (asset.GetLeftPart(UriPartial.Authority) is not (GitLab or GitLabTailnet))
        {
            throw new InvalidOperationException("Installer assets must be hosted by the configured GitLab server.");
        }
        var directory = Path.Combine(Path.GetTempPath(), "Nexus-update");
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, Path.GetFileName(asset.AbsolutePath));
        foreach (var oldFile in Directory.GetFiles(directory))
        {
            if (!string.Equals(oldFile, file, StringComparison.OrdinalIgnoreCase))
            {
                try { File.Delete(oldFile); } catch { }
            }
        }
        progress("Downloading the installer", null);
        try
        {
            using var downloadDeadline = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            using var response = release.Source == "github"
                ? await RequestGitHubAsync(asset, TimeSpan.FromMinutes(15), downloadDeadline.Token)
                : await RequestGitLabAsync(asset.PathAndQuery, TimeSpan.FromMinutes(15), downloadDeadline.Token);
            response.EnsureSuccessStatusCode();
            var size = response.Content.Headers.ContentLength;
            await using var input = await response.Content.ReadAsStreamAsync(downloadDeadline.Token);
            await using var output = File.Create(file);
            var buffer = new byte[128 * 1024];
            long received = 0;
            var refresh = Stopwatch.StartNew();
            int count;
            while ((count = await input.ReadAsync(buffer, downloadDeadline.Token)) > 0)
            {
                await output.WriteAsync(buffer.AsMemory(0, count), downloadDeadline.Token);
                received += count;
                if (refresh.ElapsedMilliseconds < 300) continue;
                progress("Downloading the installer", size > 0 ? (int)Math.Min(100, received * 100 / size.Value) : null);
                refresh.Restart();
            }
        }
        catch (OperationCanceledException) { throw new InvalidOperationException("The installer download timed out. Try Update now again."); }
        progress("Verifying the installer checksum", null);
        string hash;
        await using (var stream = File.OpenRead(file)) hash = Convert.ToHexString(await SHA256.HashDataAsync(stream));
        if (!hash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(file);
            throw new InvalidOperationException("The download did not match the published checksum and was discarded.");
        }
        // Installing an older version by hand is a rollback: stop the updater from putting the newer one straight back.
        if (!Newer(release.Tag, CurrentVersion())) SaveAutoUpdate(false);
        // Keep the keys and tool assignments so a bad version can be rolled back without re-entering them.
        var secrets = Path.Combine(_root, "secrets");
        if (Directory.Exists(secrets))
        {
            var backup = Path.Combine(Folder, "backups", $"{DateTime.Now:yyyyMMdd-HHmmss}-{CurrentVersion() ?? "source"}");
            Directory.CreateDirectory(backup);
            foreach (var f in Directory.GetFiles(secrets)) File.Copy(f, Path.Combine(backup, Path.GetFileName(f)), true);
        }
        progress("Opening Nexus Setup", null);
        var log = Path.Combine(Folder, "manual-update.log");
        var start = new ProcessStartInfo(file) { UseShellExecute = true };
        foreach (var argument in new[] { "/SP-", "/NORESTART", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", $"/LOG={log}" })
            start.ArgumentList.Add(argument);
        using var installer = Process.Start(start) ?? throw new InvalidOperationException("Nexus Setup could not start.");
        progress("Follow the Nexus Setup window to continue", null);
        await installer.WaitForExitAsync();
        if (installer.ExitCode != 0)
            throw new InvalidOperationException($"Setup ended with code {installer.ExitCode}. You can try Update now again. Details are in %LOCALAPPDATA%\\Nexus\\manual-update.log.");
        if (CurrentVersion() != release.Tag.TrimStart('v'))
            throw new InvalidOperationException("Setup closed, but Windows has not registered the selected Nexus version.");
        try { File.Delete(file); } catch { }
        try
        {
            var backupsRoot = Path.Combine(Folder, "backups");
            if (Directory.Exists(backupsRoot))
            {
                foreach (var oldBackup in Directory.GetDirectories(backupsRoot).OrderByDescending(Path.GetFileName, StringComparer.Ordinal).Skip(5))
                    Directory.Delete(oldBackup, recursive: true);
            }
        }
        catch { }
        return $"Nexus {release.Tag} is installed.";
    }
}
