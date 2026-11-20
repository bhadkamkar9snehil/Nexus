// Native Windows toast from the monitor host, so agent mail and GitLab events reach the user without opening Nexus.
import { spawn } from 'node:child_process';

const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Uses Windows PowerShell's own registered AppUserModelID: an unregistered id (such as "Nexus") shows nothing.
export function notify(title, body) {
  if (process.platform !== 'win32' || process.env.NEXUS_NOTIFY === '0') return;
  const xml = `<toast><visual><binding template="ToastText02"><text id="1">${escape(title).slice(0, 80)}</text><text id="2">${escape(body).slice(0, 200)}</text></binding></visual></toast>`;
  const script = "$ErrorActionPreference='Stop';[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
    "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];" +
    "$d=New-Object Windows.Data.Xml.Dom.XmlDocument;$d.LoadXml($env:NEXUS_TOAST);" +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($d))";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, NEXUS_TOAST: xml } });
  child.on('error', () => console.error('Could not show a Windows notification.'));
}
