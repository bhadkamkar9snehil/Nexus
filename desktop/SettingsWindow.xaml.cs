using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;

namespace Nexus.Desktop;

public partial class SettingsWindow : Window
{
    private readonly string _root;
    private const string DefaultKey = "Use default key";
    private static readonly string[] JevTools = ["jev_browse", "jev_desktop", "find_files", "jev_search_content", "map_files", "jev_select_workflow", "jev_rank_results", "jev_classify_failure", "jev_verify_result"];

    public SettingsWindow(string root)
    {
        InitializeComponent();
        _root = Path.GetFullPath(root);
        RootLabel.Text = _root;
        RefreshStatus();
        ToolChoice.ItemsSource = JevTools;
        ToolChoice.SelectedIndex = 0;
    }

    private void RefreshStatus() => KeyStatus.Text = File.Exists(Path.Combine(_root, "secrets", "computeruse_1.xml"))
        ? "A key is saved for this Windows account. Saving a new key replaces it."
        : "No key is saved for this installation.";

    private async void SaveKey(object sender, RoutedEventArgs e)
    {
        var key = KeyInput.Password;
        KeyInput.Clear();
        if (string.IsNullOrWhiteSpace(key) || key.Contains('\n') || key.Contains('\r'))
        {
            Feedback.Text = "Enter a valid API key.";
            return;
        }
        SaveButton.IsEnabled = false;
        try
        {
            var result = await RunScriptAsync("Set-ComputerUseKey.ps1", "-FromStandardInput", key);
            Feedback.Text = result.ExitCode == 0
                ? "Key saved for this Windows account. Reconnect Codex and Claude to use it."
                : "The key could not be saved. Check the installation folder and Windows account.";
            RefreshStatus();
        }
        catch { Feedback.Text = "The key could not be saved. Check the installation folder and try again."; }
        finally { key = string.Empty; SaveButton.IsEnabled = true; }
    }

    private async void SaveNamedKey(object sender, RoutedEventArgs e)
    {
        var alias = AliasInput.Text.Trim();
        var key = NamedKeyInput.Password;
        NamedKeyInput.Clear();
        if (!Regex.IsMatch(alias, "^[a-zA-Z0-9_-]{1,40}$") || alias.Equals("computeruse_1", StringComparison.OrdinalIgnoreCase))
        {
            NamedFeedback.Text = "Enter a key name using letters, numbers, underscores or hyphens. The default key is saved above.";
            return;
        }
        if (string.IsNullOrWhiteSpace(key) || key.Contains('\n') || key.Contains('\r'))
        {
            NamedFeedback.Text = "Enter a valid API key.";
            return;
        }
        SaveNamedButton.IsEnabled = false;
        try
        {
            var result = await RunScriptAsync("Set-ComputerUseKey.ps1", "-FromStandardInput", key, alias);
            NamedFeedback.Text = result.ExitCode == 0 ? "Named key saved. Assign it to a tool below." : "The key could not be saved. Check the installation folder and Windows account.";
            if (result.ExitCode == 0) RefreshAssignments(alias);
        }
        catch { NamedFeedback.Text = "The key could not be saved. Check the installation folder and try again."; }
        finally { key = string.Empty; SaveNamedButton.IsEnabled = true; }
    }

    private string MappingPath => Path.Combine(_root, "secrets", "tool-keys.json");

    private JsonObject ReadMapping()
    {
        if (!File.Exists(MappingPath)) return new JsonObject();
        return JsonNode.Parse(File.ReadAllText(MappingPath)) as JsonObject ?? throw new InvalidDataException("Invalid key mapping.");
    }

    private void ToolChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e) => RefreshAssignments();

    private void RefreshAssignments(string? selected = null)
    {
        if (ToolChoice?.SelectedItem is not string tool || KeyChoice is null) return;
        try
        {
            var mapping = ReadMapping();
            var assigned = mapping[tool]?.GetValue<string>();
            var folder = Path.Combine(_root, "secrets");
            var names = Directory.Exists(folder)
                ? Directory.GetFiles(folder, "*.xml").Select(Path.GetFileNameWithoutExtension).Where(n => n is not null && Regex.IsMatch(n, "^[a-zA-Z0-9_-]{1,40}$") && !n.Equals("computeruse_1", StringComparison.OrdinalIgnoreCase)).OrderBy(n => n).ToList()
                : new List<string?>();
            if (!string.IsNullOrEmpty(assigned) && !assigned.Equals("computeruse_1", StringComparison.OrdinalIgnoreCase) && !names.Contains(assigned)) names.Add(assigned);
            KeyChoice.ItemsSource = new[] { DefaultKey }.Concat(names.Select(n => n!)).ToArray();
            KeyChoice.SelectedItem = selected ?? (string.IsNullOrEmpty(assigned) || assigned == "computeruse_1" ? DefaultKey : assigned);
            AssignButton.IsEnabled = true;
        }
        catch { AssignButton.IsEnabled = false; AssignmentFeedback.Text = "Tool assignments could not be read. Check secrets\\tool-keys.json before changing them."; }
    }

    private void SaveAssignment(object sender, RoutedEventArgs e)
    {
        if (ToolChoice.SelectedItem is not string tool || KeyChoice.SelectedItem is not string alias) return;
        string? temporary = null;
        try
        {
            var mapping = ReadMapping();
            if (alias == DefaultKey) mapping.Remove(tool);
            else
            {
                if (!Regex.IsMatch(alias, "^[a-zA-Z0-9_-]{1,40}$") || !File.Exists(Path.Combine(_root, "secrets", alias + ".xml"))) throw new InvalidDataException("Selected key is missing.");
                mapping[tool] = alias;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(MappingPath)!);
            temporary = MappingPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, mapping.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, MappingPath, true);
            AssignmentFeedback.Text = "Tool assignment saved. Reconnect Codex and Claude to use it.";
        }
        catch { AssignmentFeedback.Text = "The assignment could not be saved. Check that the selected key exists and the settings file is valid."; }
        finally { if (temporary is not null && File.Exists(temporary)) File.Delete(temporary); }
    }

    private async void RunSetup(object sender, RoutedEventArgs e)
    {
        SetupButton.IsEnabled = false;
        Feedback.Text = "Setting up Nexus. Approve the Windows prompt if one appears.";
        try
        {
            var result = await RunScriptAsync("Setup.ps1", "-NoBrowserAtSignIn", null);
            Feedback.Text = result.ExitCode == 0
                ? "Setup completed. Reconnect Codex and Claude, then verify a tool in each agent."
                : "Setup did not finish. " + (string.IsNullOrWhiteSpace(result.Error) ? "Check the installation and try again." : result.Error.Trim());
        }
        catch (Exception ex) { Feedback.Text = "Setup could not start: " + ex.Message; }
        finally { SetupButton.IsEnabled = true; }
    }

    private async Task<(int ExitCode, string Error)> RunScriptAsync(string script, string arguments, string? input, string? alias = null)
    {
        var scriptPath = Path.Combine(_root, script);
        if (!File.Exists(scriptPath)) throw new FileNotFoundException("Nexus setup files are missing. Run the installer.");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var info = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = _root,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath }) info.ArgumentList.Add(arg);
        if (!string.IsNullOrEmpty(arguments)) info.ArgumentList.Add(arguments);
        if (alias is not null) { info.ArgumentList.Add("-Alias"); info.ArgumentList.Add(alias); }
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

    private void CloseWindow(object sender, RoutedEventArgs e) => Close();
}
