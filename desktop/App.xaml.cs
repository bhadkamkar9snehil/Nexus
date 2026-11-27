using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Windows;
using System.Threading;

namespace Nexus.Desktop;

public partial class App : System.Windows.Application
{
    private Mutex? _instance;
    private readonly CancellationTokenSource _activation = new();
    private static readonly string ActivationPipe = "Nexus.Desktop.Activation." + Process.GetCurrentProcess().SessionId;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        NexusNotifications.SetProcessIdentity();
        if (e.Args is ["--notify"])
        {
            try
            {
                using var input = Console.OpenStandardInput();
                using var payload = JsonDocument.Parse(input);
                var args = payload.RootElement;
                NexusNotifications.Show(args.GetProperty("title").GetString() ?? "",
                    args.GetProperty("body").GetString() ?? "",
                    args.GetProperty("view").GetString() == "inbox" ? NexusView.Inbox : NexusView.Updates);
                Shutdown();
            }
            catch { Shutdown(1); }
            return;
        }
        var destination = NexusNotifications.ViewFromProtocol(e.Args.FirstOrDefault());
        _instance = new Mutex(true, @"Local\Nexus.Desktop", out var first);
        if (!first)
        {
            try
            {
                using var client = new NamedPipeClientStream(".", ActivationPipe, PipeDirection.Out, PipeOptions.CurrentUserOnly);
                client.Connect(1500);
                client.WriteByte((byte)destination);
            }
            catch (Exception error) when (error is IOException or TimeoutException or UnauthorizedAccessException) { }
            Shutdown();
            return;
        }
        var window = new MainWindow(destination);
        MainWindow = window;
        window.Show();
        _ = ListenForActivationAsync(window, _activation.Token);
    }

    private static async Task ListenForActivationAsync(MainWindow window, CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                using var server = new NamedPipeServerStream(ActivationPipe, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(cancellation);
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                deadline.CancelAfter(TimeSpan.FromSeconds(1));
                var code = new byte[1];
                try
                {
                    if (await server.ReadAsync(code, deadline.Token) == 1 && code[0] <= (byte)NexusView.Settings)
                        window.OpenView((NexusView)code[0]);
                }
                catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { }
                catch (IOException) { }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _activation.Cancel();
        _activation.Dispose();
        _instance?.Dispose();
        base.OnExit(e);
    }
}
