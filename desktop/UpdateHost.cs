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
    private const string ProjectPath = "ssm%2Fshared-computer-use";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nexus");
    private static string TokenFile => Path.Combine(Folder, "gitlab-token.bin");
    private static string StateFile => Path.Combine(Folder, "updates.json");
    private readonly string _root = root;

    public string? NotifiedTag { get; private set; }

    public static string? CurrentVersion() => Registry.CurrentUser.OpenSubKey(UninstallKey)?.GetValue("DisplayVersion") as string;

    private static string? Token()
    {
        try { return File.Exists(TokenFile) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(TokenFile), null, DataProtectionScope.CurrentUser)) : null; }
        catch { return null; }
    }

    private static async Task<string> GetAsync(string path)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, GitLab + path);
        if (Token() is { } token) request.Headers.Add("PRIVATE-TOKEN", token);
        using var response = await Http.SendAsync(request);
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
            var link = r["assets"]?["links"]?.AsArray().FirstOrDefault(l => (l?["name"]?.GetValue<string>() ?? "").StartsWith("Nexus-Harness-Setup", StringComparison.Ordinal));
            var name = link?["name"]?.GetValue<string>();
            var sha = name is null ? null : Regex.Match(notes, Regex.Escape(name) + @": SHA256 ([0-9a-fA-F]{64})").Groups[1].Value;
            return new Release(r["tag_name"]!.GetValue<string>(), r["name"]?.GetValue<string>() ?? "", r["released_at"]?.GetValue<string>() ?? "", notes,
                link?["url"]?.GetValue<string>(), string.IsNullOrEmpty(sha) ? null : sha.ToLowerInvariant());
        }).ToList();
    }

    /// <summary>Checks for a newer release; returns its tag when it has not been announced yet.</summary>
    public async Task<string?> CheckAsync()
    {
        var latest = (await ReleasesAsync()).FirstOrDefault(r => r.InstallerUrl is not null);
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
                    var releases = await ReleasesAsync();
                    reply["current"] = current;
                    reply["tokenSaved"] = File.Exists(TokenFile);
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
                    reply["message"] = await InstallAsync(Text("tag"));
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

    private async Task<string> InstallAsync(string tag)
    {
        var release = (await ReleasesAsync()).FirstOrDefault(r => r.Tag == tag) ?? throw new InvalidOperationException("That release was not found.");
        if (release.InstallerUrl is null || release.Sha256 is null) throw new InvalidOperationException("That release has no installer with a published checksum, so it is not installed.");
        var directory = Path.Combine(Path.GetTempPath(), "Nexus-update");
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, Path.GetFileName(new Uri(release.InstallerUrl).AbsolutePath));
        using (var request = new HttpRequestMessage(HttpMethod.Get, release.InstallerUrl))
        {
            if (Token() is { } token) request.Headers.Add("PRIVATE-TOKEN", token);
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            await using var output = File.Create(file);
            await response.Content.CopyToAsync(output);
        }
        await using (var stream = File.OpenRead(file))
            if (!Convert.ToHexString(await SHA256.HashDataAsync(stream)).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(file);
                throw new InvalidOperationException("The download did not match the published checksum and was discarded.");
            }
        // Keep the keys and tool assignments so a bad version can be rolled back without re-entering them.
        var secrets = Path.Combine(_root, "secrets");
        if (Directory.Exists(secrets))
        {
            var backup = Path.Combine(Folder, "backups", $"{DateTime.Now:yyyyMMdd-HHmmss}-{CurrentVersion() ?? "source"}");
            Directory.CreateDirectory(backup);
            foreach (var f in Directory.GetFiles(secrets)) File.Copy(f, Path.Combine(backup, Path.GetFileName(f)), true);
        }
        Process.Start(new ProcessStartInfo(file, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS") { UseShellExecute = true });
        return $"Installing {tag}. Nexus will close and reopen.";
    }
}
