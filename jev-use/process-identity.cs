using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class NexusProcessIdentity {
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static void Terminate(int pid, string expectedName, string expectedStart) {
        IntPtr h = OpenProcess(0x00100001 | 0x1000, false, pid);
        if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            FileTime created, exited, kernel, user;
            if (!GetProcessTimes(h, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            string start = (((ulong)created.High << 32) | created.Low).ToString();
            var path = new StringBuilder(32768); int size = path.Capacity;
            if (!QueryFullProcessImageName(h, 0, path, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            string name = Path.GetFileNameWithoutExtension(path.ToString());
            if (!String.Equals(start, expectedStart, StringComparison.Ordinal) || !String.Equals(name, expectedName, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Process identity mismatch; refresh the process list");
            if (!TerminateProcess(h, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(h, 5000) != 0) throw new InvalidOperationException("Process termination not confirmed");
        } finally { CloseHandle(h); }
    }
}
