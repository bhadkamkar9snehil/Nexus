param([string]$Marker)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'Nexus restart shortcut test'
$script:quit = $false
$menu = New-Object Windows.Forms.MenuStrip
$item = New-Object Windows.Forms.ToolStripMenuItem('Quit')
$item.ShortcutKeys = [Windows.Forms.Keys]::Control -bor [Windows.Forms.Keys]::Q
$item.Add_Click({ $script:quit = $true; $form.Close() })
[void]$menu.Items.Add($item)
$form.Controls.Add($menu)
$form.Add_FormClosing({ if (-not $script:quit) { $_.Cancel = $true } })
[Windows.Forms.Application]::Run($form)
