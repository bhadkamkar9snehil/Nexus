using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace Nexus.Installation;

internal static class Program
{
    private static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    private static readonly string Logs = Path.Combine(Local, "Nexus");
    private static readonly string Profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    private static async Task<int> Main(string[] args)
    {
        string? result = null;
        var canElevate = false;
        try
        {
            if (args is ["self-test"]) { SelfTest.Run(); return 0; }
            if (args.Length < 2) throw new ArgumentException("Usage: Nexus.Setup preflight|provision|repair <installation directory> [result file] [--browser] [--search]");
            var operation = args[0];
            if (operation == "preflight")
            {
                if (args.Length != 3) throw new ArgumentException("Preflight requires a result file.");
                if (args[2] != "--elevated") result = args[2];
            }
            else if (operation is not ("provision" or "repair") || args.Skip(2).Any(option => option is not ("--browser" or "--search")))
                throw new ArgumentException("Unknown installer operation or option.");

            var root = SetupPath.ValidateDestination(args[1]);
            canElevate = operation == "preflight";
            Directory.CreateDirectory(Logs);
            using var setupLock = new FileStream(Path.Combine(Logs, "setup.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            var monitor = new MonitorInstallation(root, Logs);
            if (operation == "preflight") await monitor.TakeOverAsync(stopClients: true);
            else
            {
                ValidatePackage(root);
                if (operation == "repair") await monitor.TakeOverAsync(stopClients: false);
                await monitor.ProvisionAsync();
                await ConfigureOptionalAsync(root, args);
                Log("Nexus setup completed. Managed monitor verified.");
            }
            return 0;
        }
        catch (Exception error)
        {
            var permissionDenied = Windows.IsAccessDenied(error);
            var message = permissionDenied && canElevate
                ? $"Windows denied Nexus monitor takeover. Retry with administrator approval. {error.Message}"
                : error.Message;
            Log(error.ToString());
            if (result is not null)
            {
                try { File.WriteAllText(result, message); }
                catch (Exception writeError) when (writeError is IOException or UnauthorizedAccessException)
                { Log($"Could not write the preflight result: {writeError.Message}"); }
            }
            Console.Error.WriteLine(message);
            return permissionDenied && canElevate ? 5 : 1;
        }
    }

    internal static void ValidatePackage(string root)
    {
        var runtime = Path.Combine(root, "runtime");
        var hashes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(runtime, "SHA256.json")));
        foreach (var entry in manifest.RootElement.EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString();
            if (string.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name) || name is "." or ".." || !hashes.Add(name))
                throw new InvalidDataException("Invalid or duplicate runtime manifest entry.");
            VerifyHash(Path.Combine(runtime, name), entry.GetProperty("sha256").GetString());
        }
        foreach (var name in new[] { "node.exe", "cua-driver.exe", "uffs.exe", "uffsd.exe", "uffs-broker.exe", "rg.exe" })
            if (!hashes.Contains(name)) throw new InvalidDataException($"Missing checksum for bundled component {name}.");
        var package = Path.Combine(root, "jev-use");
        VerifyHash(Path.Combine(package, "package-lock.json"), File.ReadAllText(Path.Combine(root, ".bundled-lock.sha256")).Trim());
        if (!File.Exists(Path.Combine(package, "node_modules", "tsx", "dist", "loader.mjs")))
            throw new InvalidDataException("Bundled Node dependencies are missing. Download a fresh installer.");
    }

    private static void VerifyHash(string path, string? expected)
    {
        using var file = File.OpenRead(path);
        if (!Convert.ToHexString(SHA256.HashData(file)).Equals(expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Checksum mismatch: {Path.GetFileName(path)}.");
    }

    private static async Task ConfigureOptionalAsync(string root, string[] args)
    {
        var runtime = Path.Combine(root, "runtime");
        var warnings = new List<string>();
        if (args.Contains("--browser"))
            await Optional("Browser integration", async () =>
            {
                var browsers = new[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe")
                };
                if (!browsers.Any(File.Exists))
                    await Require("winget.exe", ["install", "--id", "Google.Chrome", "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--silent", "--disable-interactivity"]);
            });
        if (args.Contains("--search"))
            await Optional("UFFS search service", async () =>
            {
                if ((await Run(Path.Combine(Environment.SystemDirectory, "sc.exe"), ["query", "UffsAccessBroker"])).ExitCode == 0) return;
                using var broker = Process.Start(new ProcessStartInfo(Path.Combine(runtime, "uffs-broker.exe"), "--install") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden })
                    ?? throw new InvalidOperationException("UFFS installer could not start.");
                await broker.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(2));
                if (broker.ExitCode != 0) throw new InvalidOperationException($"UFFS installer returned {broker.ExitCode}.");
            });
        await Optional("Cua Driver sign-in startup", async () =>
        {
            var driver = Path.Combine(runtime, "cua-driver.exe");
            var status = await Require(driver, ["autostart", "status"]);
            if (!status.StartsWith("registered (", StringComparison.OrdinalIgnoreCase)) await Require(driver, ["autostart", "enable"]);
            if (!status.StartsWith("registered (running)", StringComparison.OrdinalIgnoreCase)) await Require(driver, ["autostart", "kick"]);
        });

        foreach (var agent in new[] { "codex", "claude" })
        {
            var tool = FindAgent(agent);
            if (tool is not null) await Optional($"{agent} MCP registration", async () =>
            {
                await Require(tool, ["mcp", "list"]);
                foreach (var (name, command) in new (string Name, string[] Command)[] {
                    ("shared_jev", [Path.Combine(runtime, "node.exe"), Path.Combine(root, "jev-use", "start.mjs")]),
                    ("shared_cua", [Path.Combine(runtime, "cua-driver.exe"), "mcp", "--socket", @"\\.\pipe\cua-driver"])
                })
                {
                    if ((await Run(tool, ["mcp", "get", name])).ExitCode == 0) continue;
                    string[] prefix = agent == "claude" ? ["mcp", "add", "-s", "user", name, "--"] : ["mcp", "add", name, "--"];
                    await Require(tool, [.. prefix, .. command]);
                }
            });
            await Optional($"{agent} skill", () =>
            {
                var destination = Path.Combine(Profile, "." + agent, "skills", "shared-harness");
                if (!Directory.Exists(Path.Combine(Profile, "." + agent)) || Directory.Exists(destination)) return Task.CompletedTask;
                var source = Path.Combine(root, "skills", "shared-harness");
                var staging = destination + "." + Guid.NewGuid().ToString("N");
                Directory.CreateDirectory(Path.Combine(staging, "references"));
                try
                {
                    File.Copy(Path.Combine(source, "SKILL.md"), Path.Combine(staging, "SKILL.md"));
                    File.Copy(Path.Combine(source, "references", "tools.md"), Path.Combine(staging, "references", "tools.md"));
                    File.WriteAllText(Path.Combine(staging, ".harness-managed"), root);
                    Directory.Move(staging, destination);
                }
                finally { if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true); }
                return Task.CompletedTask;
            });
        }
        var warningsFile = Path.Combine(Logs, "setup-warnings.json");
        var temporary = warningsFile + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(warnings));
            File.Move(temporary, warningsFile, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Log($"Could not update setup warnings: {error.Message}");
        }
        finally { try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }

        async Task Optional(string label, Func<Task> action)
        {
            try { await action(); }
            catch (Exception error)
            {
                var message = $"{label} is not ready: {error.Message}";
                warnings.Add(message);
                Log(message);
            }
        }
    }

    private static string? FindAgent(string name) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Where(path => Path.IsPathFullyQualified(path))
            .SelectMany(path => new[] { Path.Combine(path, name + ".exe"), Path.Combine(path, name + ".cmd") })
            .FirstOrDefault(File.Exists);

    private static async Task<string> Require(string command, string[] args)
    {
        var result = await Run(command, args);
        if (result.ExitCode != 0) throw new InvalidOperationException($"{Path.GetFileName(command)} returned {result.ExitCode}.");
        return result.Output.Trim();
    }

    private static async Task<(int ExitCode, string Output)> Run(string command, string[] args)
    {
        var info = new ProcessStartInfo(command) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (command.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
        {
            if (args.Append(command).Any(value => value.IndexOfAny(['"', '%', '!', '\r', '\n']) >= 0))
                throw new ArgumentException("Unsupported characters in the agent registration command.");
            info.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            info.Arguments = $"/d /v:off /s /c \"\"{command}\" {string.Join(" ", args.Select(value => $"\"{value}\""))}\"";
        }
        else foreach (var arg in args) info.ArgumentList.Add(arg);

        using var child = Process.Start(info) ?? throw new InvalidOperationException($"{Path.GetFileName(command)} could not start.");
        var stdout = child.StandardOutput.ReadToEndAsync();
        var stderr = child.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try { await child.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
            throw new TimeoutException($"{Path.GetFileName(command)} did not finish within two minutes.");
        }
        await stderr;
        return (child.ExitCode, await stdout);
    }

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Logs);
            File.AppendAllText(Path.Combine(Logs, "setup.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal static class SetupPath
{
    internal static string Normalize(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    internal static string ValidateDestination(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("Choose an absolute installation folder.");
        var root = Normalize(path);
        if (root.Equals(Path.GetPathRoot(root), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Choose a Nexus subfolder, not a drive root.");
        if (root.Split(Path.DirectorySeparatorChar).Contains("AppData", StringComparer.OrdinalIgnoreCase))
            throw new ArgumentException("Choose an installation folder outside AppData.");
        if (File.Exists(root)) throw new ArgumentException("The installation path is an existing file.");
        for (var directory = new DirectoryInfo(root); directory is not null; directory = directory.Parent)
            if (Directory.Exists(Path.Combine(directory.FullName, ".git")) || File.Exists(Path.Combine(directory.FullName, ".git")))
                throw new ArgumentException("Cannot install Nexus into a Git working directory.");
        Directory.CreateDirectory(root);
        var probe = Path.Combine(root, $".nexus-write-test-{Guid.NewGuid():N}");
        using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { }
        return root;
    }
}
