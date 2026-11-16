using System.Windows;
using System.Threading;

namespace Nexus.Desktop;

public partial class App : Application
{
    private Mutex? _instance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _instance = new Mutex(true, @"Local\Nexus.Desktop", out var first);
        if (!first)
        {
            MessageBox.Show("Nexus is already open.", "Nexus", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }
        MainWindow = new MainWindow();
        MainWindow.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instance?.Dispose();
        base.OnExit(e);
    }
}
