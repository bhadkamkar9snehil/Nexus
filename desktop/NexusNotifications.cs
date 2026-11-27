using System.Runtime.InteropServices;
using System.Xml.Linq;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Nexus.Desktop;

internal enum NexusView : byte { Current, Inbox, Updates, Mail, Devices, Settings }

internal static class NexusNotifications
{
    internal const string AppId = "Nexus.Harness";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    internal static void SetProcessIdentity() => _ = SetCurrentProcessExplicitAppUserModelID(AppId);

    internal static NexusView ViewFromProtocol(string? uri) => uri switch
    {
        "nexus-harness:inbox" => NexusView.Inbox,
        "nexus-harness:updates" => NexusView.Updates,
        _ => NexusView.Current
    };

    internal static void Show(string title, string body, NexusView destination)
    {
        var (address, action) = destination == NexusView.Inbox
            ? ("nexus-harness:inbox", "Open Inbox")
            : ("nexus-harness:updates", "Open Updates");
        var markup = new XElement("toast",
            new XAttribute("activationType", "protocol"), new XAttribute("launch", address),
            new XElement("visual", new XElement("binding", new XAttribute("template", "ToastGeneric"),
                new XElement("text", Limit(title, 80)), new XElement("text", Limit(body, 200)))),
            new XElement("actions", new XElement("action", new XAttribute("content", action),
                new XAttribute("activationType", "protocol"), new XAttribute("arguments", address))));
        var document = new XmlDocument();
        document.LoadXml(markup.ToString(SaveOptions.DisableFormatting));
        ToastNotificationManager.CreateToastNotifier(AppId).Show(new ToastNotification(document));
    }

    private static string Limit(string text, int length) => string.Concat(
        text.EnumerateRunes().Where(rune => rune.Value >= 32 && rune.Value is not (0xfffe or 0xffff))
            .Take(length).Select(rune => rune.ToString()));
}
