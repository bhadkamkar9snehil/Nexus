using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Nexus.Installation;

internal static class Windows
{
    private const uint InsufficientBuffer = 122;

    internal static bool IsAccessDenied(Exception error) => error is UnauthorizedAccessException ||
        error.HResult is unchecked((int)0x80070005) or unchecked((int)0x80041003) ||
        error is System.ComponentModel.Win32Exception { NativeErrorCode: 5 };

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr address);

    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    internal static void StopProcess(SafeProcessHandle process)
    {
        if (!TerminateProcess(process, 1))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    internal static string? ProcessOwner(SafeProcessHandle process)
    {
        const uint query = 8;
        if (!OpenProcessToken(process, query, out var token)) return null;
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
            return identity.User?.Value;
    }

    internal static string[] Arguments(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return [];
        var pointer = CommandLineToArgvW(commandLine, out var count);
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("Windows could not parse a process command line.");
        try
        {
            return Enumerable.Range(0, count)
                .Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size))!)
                .ToArray();
        }
        finally { LocalFree(pointer); }
    }

    internal static HashSet<int> PortOwners(int port)
    {
        var owners = new HashSet<int>();
        ReadTable(2, 24, 0, 8, 20);
        if (System.Net.Sockets.Socket.OSSupportsIPv6) ReadTable(23, 56, 48, 20, 52);
        return owners;

        void ReadTable(int family, int rowSize, int stateOffset, int portOffset, int pidOffset)
        {
            const int ownerPidListener = 3;
            var size = 0;
            var error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, ownerPidListener, 0);
            for (var attempt = 0; error == InsufficientBuffer && attempt < 3; attempt++)
            {
                var buffer = Marshal.AllocHGlobal(size);
                try
                {
                    error = GetExtendedTcpTable(buffer, ref size, false, family, ownerPidListener, 0);
                    if (error != 0) continue;
                    var count = Marshal.ReadInt32(buffer);
                    for (var index = 0; index < count; index++)
                    {
                        var row = IntPtr.Add(buffer, 4 + index * rowSize);
                        var localPort = Marshal.ReadByte(row, portOffset) * 256 + Marshal.ReadByte(row, portOffset + 1);
                        if (localPort == port && Marshal.ReadInt32(row, stateOffset) == 2)
                            owners.Add(Marshal.ReadInt32(row, pidOffset));
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            if (error != 0) throw new System.ComponentModel.Win32Exception((int)error, "Could not verify TCP listener ownership.");
        }
    }
}
