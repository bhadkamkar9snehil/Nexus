using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Nexus.Desktop;

/// <summary>Key, tool-assignment and setup actions for the monitor's Settings page. Requests arrive over WebView2 messaging; secrets never leave this process.</summary>
public sealed class SettingsHost(string root)
{
    private readonly string _root = Path.GetFullPath(root);
    private static readonly Regex Name = new("^[a-zA-Z0-9_-]{1,40}$");
    private static readonly string[] JevTools = ["jev_browse", "jev_desktop", "find_files", "jev_search_content", "map_files", "jev_select_workflow", "jev_rank_results", "jev_classify_failure", "jev_verify_result"];
    private string Secrets => Path.Combine(_root, "secrets");
    private string MappingPath => Path.Combine(Secrets, "tool-keys.json");

    public async Task<JsonObject> HandleAsync(JsonElement request)
    {
        var id = request.TryGetProperty("id", out var i) ? i.GetInt32() : 0;
        string Text(string n) => request.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var (ok, message) = (true, (string?)null);
        try
        {
            switch (Text("type"))
            {
                case "status": break;
                case "saveKey":
                    (ok, message) = await SaveKeyAsync(Text("key"), null, "Key saved for this Windows account. Reconnect Codex and Claude to use it.");
                    break;
                case "saveNamedKey":
                    var alias = Text("alias");
                    if (!Name.IsMatch(alias) || alias.Equals("computeruse_1", StringComparison.OrdinalIgnoreCase))
                        (ok, message) = (false, "Use letters, numbers, underscores or hyphens for the key name. The default key is saved above.");
                    else (ok, message) = await SaveKeyAsync(Text("key"), alias, "Named key saved. Assign it to a tool.");
                    break;
                case "assign": (ok, message) = Assign(Text("tool"), Text("alias")); break;
                case "setup": (ok, message) = await SetupAsync(); break;
                default: (ok, message) = (false, "Unknown request."); break;
            }
        }
        catch (Exception ex) { (ok, message) = (false, ex.Message); }
        var reply = new JsonObject { ["id"] = id, ["ok"] = ok };
        if (message is not null) reply["message"] = message;
        try { reply["info"] = Info(); } catch { /* status is best effort */ }
        return reply;
    }

    private JsonObject Info()
    {
        var mapping = ReadMapping();
        var keys = Directory.Exists(Secrets)
            ? Directory.GetFiles(Secrets, "*.xml").Select(Path.GetFileNameWithoutExtension).OfType<string>().Where(n => Name.IsMatch(n) && !n.Equals("computeruse_1", StringComparison.OrdinalIgnoreCase)).Order().ToArray()
            : [];
        var map = new JsonObject();
        foreach (var (tool, alias) in mapping) if (alias is not null) map[tool] = alias.GetValue<string>();
        return new JsonObject
        {
            ["root"] = _root,
            ["keySaved"] = File.Exists(Path.Combine(Secrets, "computeruse_1.xml")),
            ["tools"] = new JsonArray(JevTools.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()),
            ["keys"] = new JsonArray(keys.Select(k => (JsonNode)JsonValue.Create(k)!).ToArray()),
            ["mapping"] = map
        };
    }

    private JsonObject ReadMapping() => File.Exists(MappingPath) ? JsonNode.Parse(File.ReadAllText(MappingPath)) as JsonObject ?? throw new InvalidDataException("Invalid key mapping.") : new JsonObject();

    private async Task<(bool, string?)> SaveKeyAsync(string key, string? alias, string success)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Contains('\n') || key.Contains('\r')) return (false, "Enter a valid API key.");
        var result = await RunScriptAsync("Set-ComputerUseKey.ps1", ["-FromStandardInput", .. alias is null ? Array.Empty<string>() : ["-Alias", alias]], key);
        return result.ExitCode == 0 ? (true, success) : (false, "The key could not be saved. Check the installation folder and Windows account.");
    }

    private (bool, string?) Assign(string tool, string alias)
    {
        if (!JevTools.Contains(tool)) return (false, "Unknown tool.");
        var mapping = ReadMapping();
        if (alias.Length == 0) mapping.Remove(tool);
        else
        {
            if (!Name.IsMatch(alias) || !File.Exists(Path.Combine(Secrets, alias + ".xml"))) return (false, "Selected key is missing.");
            mapping[tool] = alias;
        }
        Directory.CreateDirectory(Secrets);
        var temporary = MappingPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, mapping.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, MappingPath, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return (true, "Tool assignment saved. Reconnect Codex and Claude to use it.");
    }

    private async Task<(bool, string?)> SetupAsync()
    {
        var result = await RunScriptAsync("Setup.ps1", ["-NoBrowserAtSignIn"], null);
        return result.ExitCode == 0
            ? (true, "Setup completed. Reconnect Codex and Claude, then verify a tool in each agent.")
            : (false, "Setup did not finish. " + (string.IsNullOrWhiteSpace(result.Error) ? "Check the installation and try again." : result.Error.Trim()));
    }

    private async Task<(int ExitCode, string Error)> RunScriptAsync(string script, string[] arguments, string? input)
    {
        var scriptPath = Path.Combine(_root, script);
        if (!File.Exists(scriptPath)) throw new FileNotFoundException("Nexus setup files are missing. Run the installer.");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var info = new ProcessStartInfo(powershell) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = _root, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath }.Concat(arguments)) info.ArgumentList.Add(arg);
        info.Environment["PSModulePath"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "Modules");
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Windows PowerShell could not start.");
        if (input is not null) await process.StandardInput.WriteLineAsync(input);
        process.StandardInput.Close();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await stdout;
        return (process.ExitCode, await stderr);
    }
}
