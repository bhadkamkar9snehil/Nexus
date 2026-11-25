using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Nexus.Installation;

internal sealed class MonitorInstallation(string root, string logDirectory)
{
    private const string TaskName = "SharedHarness-Monitor";
    private const int Running = 4;
    private const int InteractiveLogon = 3;
    private const int Port = 8769;
    private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1";
    private static readonly HttpClient Http = new(new HttpClientHandler { UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(2),
        MaxResponseContentBufferSize = 16 * 1024
    };
    private static readonly string PowerShell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
    private readonly WindowsIdentity identity = WindowsIdentity.GetCurrent();
    private dynamic? folder;
    private dynamic? wmi;

    private dynamic Folder
    {
        get
        {
            if (folder is not null) return folder;
            dynamic service = Activate("Schedule.Service");
            service.Connect();
            return folder = service.GetFolder(@"\");
        }
    }

    private dynamic Wmi => wmi ??= Activate("WbemScripting.SWbemLocator").ConnectServer(".", @"root\cimv2");

    internal async Task TakeOverAsync(bool stopClients)
    {
        dynamic? task = FindTask();
        var currentSid = identity.User!.Value;
        var taskSid = currentSid;
        string? taskRoot = null;
        if (task is not null)
        {
            taskRoot = ResolveTaskRoot(task);
            taskSid = ResolveSid((string)task.Definition.Principal.UserId);
            if (taskSid != currentSid)
            {
                if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new UnauthorizedAccessException("The Nexus monitor task belongs to another Windows user. Administrator approval is required.");
                if (!IsNexusRoot(taskRoot)) throw new InvalidOperationException("The other user's task does not point to a verified Nexus installation.");
            }
            else if (Directory.Exists(taskRoot) && !IsNexusRoot(taskRoot))
                throw new InvalidOperationException("The existing task points to a directory that could not be verified as Nexus.");
        }

        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { root };
        if (taskRoot is not null) roots.Add(taskRoot);
        using (var registry = Registry.CurrentUser.OpenSubKey(RegistryPath))
        {
            if (registry?.GetValue("InstallLocation") is string installed && Path.IsPathFullyQualified(installed) && IsNexusRoot(installed))
                roots.Add(SetupPath.Normalize(installed));
        }

        var listeners = Windows.PortOwners(Port);
        var health = listeners.Count == 0 ? null : await ReadHealthAsync();
        if (listeners.Count > 0)
        {
            if (health is null || listeners.Count != 1 || !listeners.Contains(health.Pid))
                throw new InvalidOperationException($"Port {Port} is held by an unverified process (PID {string.Join(", ", listeners)}). No process was stopped.");
            if (!roots.Contains(health.Root) && !IsNexusRoot(health.Root))
                throw new InvalidOperationException("The monitor's installation directory could not be verified.");
            roots.Add(health.Root);
        }

        var processes = new List<OwnedProcess>();
        try
        {
            foreach (dynamic candidate in Wmi.ExecQuery("SELECT ProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='Nexus.Desktop.exe'"))
            {
                var name = (string)ReadProperty(candidate, "Name");
                var arguments = Windows.Arguments(ReadProperty(candidate, "CommandLine") as string ?? "");
                var executable = ReadProperty(candidate, "ExecutablePath") as string;
                if (!roots.Any(candidateRoot => Matches(name, executable, arguments, candidateRoot, stopClients))) continue;
                var pid = Convert.ToInt32(ReadProperty(candidate, "ProcessId"));
                Process process;
                try
                {
                    process = Process.GetProcessById(pid);
                    _ = process.Handle;
                }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException) { continue; }
                processes.Add(new OwnedProcess(process, false));
                if (process.HasExited) continue;

                var processPath = $"Win32_Process.Handle=\"{pid}\"";
                object? started;
                try { started = ReadProperty(Wmi.Get(processPath), "CreationDate"); }
                catch (Exception) when (process.HasExited) { continue; }
                if (ReadProperty(candidate, "CreationDate") is not string originalStart || !Equals(originalStart, started))
                {
                    processes.RemoveAt(processes.Count - 1);
                    process.Dispose();
                    continue;
                }
                var ownerSid = Windows.ProcessOwner(process.SafeHandle);
                if (process.HasExited) continue;
                if (ownerSid != currentSid && (taskRoot is null || ownerSid != taskSid || !Matches(name, executable, arguments, taskRoot, stopClients)))
                    throw new UnauthorizedAccessException($"Nexus process PID {pid} belongs to another or unidentified user.");
                var monitor = name.Equals("node.exe", StringComparison.OrdinalIgnoreCase) && arguments.Length > 1 &&
                    health is not null && IsFile(arguments[1], health.Root, "monitor.mjs");
                processes[^1] = new OwnedProcess(process, monitor);
            }
            if (health is not null && !processes.Any(entry => entry.Monitor && entry.Process.Id == health.Pid))
                throw new InvalidOperationException("The process serving the monitor could not be verified.");

            await TransferAsync(task, processes);
        }
        finally
        {
            foreach (var process in processes) process.Process.Dispose();
        }
    }

    private async Task TransferAsync(dynamic? task, List<OwnedProcess> processes)
    {
        string? backup = null;
        string? xml = null;
        string? owner = null;
        var wasRunning = task is not null && (int)task.State == Running;
        try
        {
            if (task is not null)
            {
                owner = (string)task.Definition.Principal.UserId;
                xml = (string)task.Xml;
                var directory = Path.Combine(logDirectory, "installer-migrations");
                Directory.CreateDirectory(directory);
                backup = Path.Combine(directory, $"SharedHarness-Monitor-{Guid.NewGuid():N}.xml");
                var encoding = xml.StartsWith("<?xml", StringComparison.Ordinal) &&
                    xml.Split('>', 2)[0].Contains("UTF-16", StringComparison.OrdinalIgnoreCase)
                    ? Encoding.Unicode : Encoding.UTF8;
                File.WriteAllText(backup, xml, encoding);
                if (wasRunning) task.Stop(0);
                Folder.DeleteTask(TaskName, 0);
            }

            foreach (var entry in processes)
            {
                if (entry.Process.HasExited) continue;
                try { Windows.StopProcess(entry.Process.SafeHandle); }
                catch (Exception error) when ((error is InvalidOperationException or System.ComponentModel.Win32Exception) && entry.Process.HasExited) { }
            }
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            foreach (var entry in processes) await entry.Process.WaitForExitAsync(deadline.Token);
            while (Windows.PortOwners(Port).Count > 0) await Task.Delay(200, deadline.Token);
        }
        catch (Exception original)
        {
            if (backup is not null && xml is not null && owner is not null)
            {
                try
                {
                    dynamic? restored = FindTask();
                    if (restored is null)
                        restored = Folder.RegisterTask(TaskName, xml, 2, owner, null, InteractiveLogon, null);
                    else if (!string.Equals(xml, (string)restored.Xml, StringComparison.Ordinal))
                        throw new InvalidOperationException("A different monitor task now owns the task name.");
                    if (wasRunning && (int)restored.State != Running) restored.Run(null);
                }
                catch (Exception rollback)
                {
                    throw new InvalidOperationException($"{original.Message} The previous task could not be restored automatically. Task backup: {backup}. {rollback.Message}", original);
                }
            }
            throw;
        }
    }

    internal async Task ProvisionAsync()
    {
        var existing = FindTask();
        if (existing is not null)
        {
            if (!ResolveTaskRoot(existing).Equals(root, StringComparison.OrdinalIgnoreCase) ||
                ResolveSid((string)existing.Definition.Principal.UserId) != identity.User!.Value)
                throw new InvalidOperationException("Another installation owns the Nexus monitor. Run the interactive installer to transfer it.");
            if ((int)existing.State != Running) existing.Run(null);
        }
        else
        {
            if (Windows.PortOwners(Port).Count > 0) throw new InvalidOperationException($"Port {Port} is already in use.");
            dynamic service = Activate("Schedule.Service");
            service.Connect();
            dynamic definition = service.NewTask(0);
            definition.Principal.UserId = identity.Name;
            definition.Principal.LogonType = InteractiveLogon;
            definition.Settings.DisallowStartIfOnBatteries = false;
            definition.Settings.StopIfGoingOnBatteries = false;
            definition.Settings.StartWhenAvailable = true;
            definition.Settings.ExecutionTimeLimit = "PT0S";
            definition.Settings.RestartCount = 999;
            definition.Settings.RestartInterval = "PT1M";
            dynamic trigger = definition.Triggers.Create(9);
            trigger.UserId = identity.Name;
            dynamic action = definition.Actions.Create(0);
            action.Path = PowerShell;
            action.Arguments = $"-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{Path.Combine(root, "Monitor.ps1")}\" Run";
            action.WorkingDirectory = root;
            // Keep the same user able to transfer the task from a non-elevated update.
            var taskSecurity = $"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{identity.User!.Value})";
            existing = Folder.RegisterTaskDefinition(TaskName, definition, 2, identity.Name, null, InteractiveLogon, taskSecurity);
            existing.Run(null);
        }

        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(60))
        {
            var health = await ReadHealthAsync();
            if (health is not null && health.Managed && health.Root.Equals(root, StringComparison.OrdinalIgnoreCase) &&
                Windows.PortOwners(Port).SetEquals([health.Pid]) && FindTask() is { } task && (int)task.State == Running) return;
            await Task.Delay(500);
        }
        throw new InvalidOperationException("The Nexus monitor did not become ready. See monitor-error.log and the scheduled task history.");
    }

    private dynamic? FindTask()
    {
        try { return Folder.GetTask(TaskName); }
        catch (Exception error) when (error.HResult == unchecked((int)0x80070002)) { return null; }
    }

    private static string ResolveTaskRoot(dynamic task)
    {
        dynamic actions = task.Definition.Actions;
        if ((int)actions.Count != 1 || (int)actions.Item(1).Type != 0)
            throw new InvalidOperationException("The existing scheduled task is not a recognized Nexus task.");
        dynamic action = actions.Item(1);
        var path = (string)action.Path;
        var script = MonitorScript(path, Windows.Arguments("task " + (string)action.Arguments));
        if (script is null || !Path.IsPathFullyQualified(script) || !Path.GetFileName(script).Equals("Monitor.ps1", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The existing scheduled task is not a recognized Nexus monitor.");
        return SetupPath.Normalize(Path.GetDirectoryName(script)!);
    }

    private static bool Matches(string name, string? executable, string[] arguments, string directory, bool stopClients)
    {
        if (name.Equals("Nexus.Desktop.exe", StringComparison.OrdinalIgnoreCase))
            return stopClients && IsFile(executable, directory, "Nexus.Desktop.exe");
        if (name.Equals("node.exe", StringComparison.OrdinalIgnoreCase))
            return arguments.Length > 1 && (IsFile(arguments[1], directory, "monitor.mjs") ||
                (stopClients && IsFile(arguments[1], directory, @"jev-use\start.mjs")));
        return IsFile(MonitorScript(name, arguments), directory, "Monitor.ps1");
    }

    private static string? MonitorScript(string name, string[] args)
    {
        if (!new[] { "powershell.exe", "pwsh.exe" }.Contains(Path.GetFileName(name), StringComparer.OrdinalIgnoreCase)) return null;
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index].ToLowerInvariant())
            {
                case "-noprofile": case "-noninteractive": continue;
                case "-windowstyle" when index + 1 < args.Length && args[index + 1].Equals("Hidden", StringComparison.OrdinalIgnoreCase): index++; continue;
                case "-executionpolicy" when index + 1 < args.Length && args[index + 1].Equals("Bypass", StringComparison.OrdinalIgnoreCase): index++; continue;
                case "-file" when index + 2 < args.Length && args[index + 2].Equals("Run", StringComparison.OrdinalIgnoreCase): return args[index + 1];
                default: return null;
            }
        }
        return null;
    }

    private static bool IsNexusRoot(string directory) =>
        File.Exists(Path.Combine(directory, "Monitor.ps1")) &&
        File.Exists(Path.Combine(directory, "monitor.mjs")) &&
        File.Exists(Path.Combine(directory, "version.mjs"));

    private static bool IsFile(string? path, string directory, string file) =>
        Path.Combine(directory, file).Equals(path, StringComparison.OrdinalIgnoreCase);

    private static string ResolveSid(string user) => user.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)
        ? new SecurityIdentifier(user).Value
        : ((SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier))).Value;

    private static dynamic Activate(string name) => Activator.CreateInstance(Type.GetTypeFromProgID(name, throwOnError: true)!)!;

    private static object? ReadProperty(dynamic instance, string name) => instance.Properties_.Item(name, 0).Value;

    private static async Task<MonitorHealth?> ReadHealthAsync()
    {
        try
        {
            using var response = await Http.GetAsync($"http://127.0.0.1:{Port}/monitor-status");
            if (!response.IsSuccessStatusCode) return null;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
            var body = document.RootElement;
            if (body.GetProperty("application").GetString() != "shared-computer-use-monitor") return null;
            var directory = body.GetProperty("root").GetString();
            if (directory is null || !Path.IsPathFullyQualified(directory)) return null;
            return new(SetupPath.Normalize(directory), body.GetProperty("pid").GetInt32(), body.GetProperty("managed").GetBoolean());
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }

    private sealed record OwnedProcess(Process Process, bool Monitor);
    private sealed record MonitorHealth(string Root, int Pid, bool Managed);
}
