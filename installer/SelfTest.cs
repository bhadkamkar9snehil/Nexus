using System.Net;
using System.Net.Sockets;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Nexus.Installation;

internal static class SelfTest
{
    internal static void Run()
    {
        if (AutoUpdater.RequiresInteractiveElevation(1, false, 0) != true ||
            AutoUpdater.RequiresInteractiveElevation(1, true, null) != false ||
            AutoUpdater.RequiresInteractiveElevation(2, true, 5) != true ||
            AutoUpdater.RequiresInteractiveElevation(3, false, 0) != false ||
            AutoUpdater.RequiresInteractiveElevation(3, false, null) != true)
            throw new Exception("Updater elevation policy regression.");
        var args = Windows.Arguments("node.exe \"C:\\Program Files\\Nexus\\monitor.mjs\" extra");
        if (args is not ["node.exe", @"C:\Program Files\Nexus\monitor.mjs", "extra"]) throw new Exception("Windows argument parsing failed.");
        using var process = Process.GetCurrentProcess();
        using var identity = WindowsIdentity.GetCurrent();
        if (Windows.ProcessOwner(process.SafeHandle) != identity.User?.Value) throw new Exception("Windows process owner lookup failed.");
        if (!Windows.IsAccessDenied(new COMException("Fixture scheduler access denied", unchecked((int)0x80070005))))
            throw new Exception("Scheduler access-denied detection failed.");
        IPAddress[] addresses = Socket.OSSupportsIPv6 ? [IPAddress.Loopback, IPAddress.IPv6Loopback] : [IPAddress.Loopback];
        foreach (var address in addresses)
        {
            using var listener = new TcpListener(address, 0);
            listener.Start();
            if (!Windows.PortOwners(((IPEndPoint)listener.LocalEndpoint).Port).SetEquals([Environment.ProcessId]))
                throw new Exception($"TCP PID ownership check failed for {address}.");
        }
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile, Environment.SpecialFolderOption.DoNotVerify);
        if (!Path.IsPathFullyQualified(profile)) profile = AppContext.BaseDirectory;
        var working = Path.Combine(profile, "nexus-setup-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            if (!SetupPath.CanUpgradeUnderDriveRoot(working, Path.GetPathRoot(working)!, working)
                || SetupPath.CanUpgradeUnderDriveRoot(working, profile, working)
                || SetupPath.CanUpgradeUnderDriveRoot(working, Path.GetPathRoot(working)!, Path.Combine(profile, "other")))
                throw new Exception("Existing installation exception is too broad.");
            if (SetupPath.ValidateDestination(working, working) != working || Directory.EnumerateFileSystemEntries(working).Any())
                throw new Exception("Destination probe failed.");
            File.WriteAllText(Path.Combine(working, ".git"), "fixture");
            try { SetupPath.ValidateDestination(Path.Combine(working, "nested"), Path.Combine(working, "nested")); }
            catch (ArgumentException) { Console.WriteLine("Installer self-test passed."); return; }
            throw new Exception("Git working directory was accepted.");
        }
        finally
        {
            File.Delete(Path.Combine(working, ".git"));
            Directory.Delete(working);
        }
    }
}
