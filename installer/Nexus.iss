#ifndef PayloadDir
  #error PayloadDir must point to the complete staged harness
#endif
#ifndef OutputDir
  #error OutputDir must point to the installer output directory
#endif
#ifndef Version
  #error Version is required
#endif

[Setup]
AppId={{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}
AppName=Nexus Harness
AppVersion={#Version}
AppPublisher=Nexus Harness
DefaultDirName={userdocs}\Nexus Harness
DefaultGroupName=Nexus Harness
OutputDir={#OutputDir}
OutputBaseFilename=Nexus-Harness-Setup-{#Version}-windows-x64
SetupIconFile=..\desktop\Assets\Nexus.ico
UninstallDisplayIcon={app}\Nexus.Desktop.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
WizardStyle=modern
Compression=zip/1
SolidCompression=no
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "optionalbrowser"; Description: "Install Google Chrome if no supported browser exists (requires internet)"; GroupDescription: "Optional setup:"; Flags: unchecked
Name: "optionalsearch"; Description: "Install UFFS search service (may request administrator approval)"; GroupDescription: "Optional setup:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "desktop,installer,.git*"
Source: "{#PayloadDir}\Nexus.Setup.exe"; Flags: dontcopy

[InstallDelete]
Type: files; Name: "{app}\monitor.html"
Type: files; Name: "{app}\.monitor-session"

[Icons]
Name: "{group}\Nexus Harness"; Filename: "{app}\Nexus.Desktop.exe"; WorkingDir: "{app}"; AppUserModelID: "Nexus.Harness"; AppUserModelToastActivatorCLSID: "E62E3398-958A-4A2A-8D4A-DA27675F96AC"
Name: "{autodesktop}\Nexus Harness"; Filename: "{app}\Nexus.Desktop.exe"; WorkingDir: "{app}"; AppUserModelID: "Nexus.Harness"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Nexus Harness"; ValueData: """{app}\Nexus.Desktop.exe"""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\Nexus.Harness"; ValueType: string; ValueName: "DisplayName"; ValueData: "Nexus"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\nexus-harness"; ValueType: string; ValueData: "URL:Nexus"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\nexus-harness"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\nexus-harness\DefaultIcon"; ValueType: string; ValueData: """{app}\Nexus.Desktop.exe"",0"
Root: HKCU; Subkey: "Software\Classes\nexus-harness\shell\open\command"; ValueType: string; ValueData: """{app}\Nexus.Desktop.exe"" ""%1"""

[Run]
Filename: "{app}\Nexus.Desktop.exe"; Description: "Open Nexus Harness"; Flags: nowait postinstall skipifsilent; Check: SetupCompleted
Filename: "{app}\Nexus.Desktop.exe"; Flags: nowait skipifnotsilent; Check: SetupCompleted

[Code]
var Provisioned: Boolean;

function SetupCompleted: Boolean;
begin
  Result := Provisioned;
end;

// A copied application is not a successful installation until setup passes.
// Return a failure status to scheduled and silent updaters when provisioning fails.
function GetCustomSetupExitCode: Integer;
begin
  if Provisioned then Result := 0 else Result := 1;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer; ResultFile, Params: String; Detail: AnsiString;
begin
  Result := '';
  ExtractTemporaryFile('Nexus.Setup.exe');
  ResultFile := ExpandConstant('{tmp}\nexus-preflight.txt');
  DeleteFile(ResultFile);
  Params := 'preflight "' + ExpandConstant('{app}') + '" "' + ResultFile + '"';
  if not Exec(ExpandConstant('{tmp}\Nexus.Setup.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'Nexus could not start its installation helper.'
  else begin
    // Elevate only takeover, so per-user setup still runs as the original user.
    if (ResultCode = 5) and (not WizardSilent) then begin
      if SuppressibleTaskDialogMsgBox('Nexus Setup needs administrator approval',
        'Windows blocked access to the existing Nexus monitor task. Run the setup helper as administrator to transfer that task and continue this installation.',
        mbConfirmation, MB_YESNO, ['Run as administrator', 'Cancel update'], IDYES, IDNO) = IDYES then begin
        Params := 'preflight "' + ExpandConstant('{app}') + '" --elevated';
        if not ShellExec('runas', ExpandConstant('{tmp}\Nexus.Setup.exe'),
          Params, ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
          Result := 'Administrator approval was not granted. Nexus Setup did not transfer the monitor task.';
          Exit;
        end;
        if ResultCode <> 0 then begin
          Result := 'The administrator retry could not transfer the Nexus monitor. Check %LOCALAPPDATA%\Nexus\setup.log.';
          Exit;
        end;
      end else begin
        Result := 'The update was canceled before transferring the monitor task.';
        Exit;
      end;
    end;
    if ResultCode <> 0 then begin
      if LoadStringFromFile(ResultFile, Detail) then Result := String(Detail)
      else Result := 'Nexus could not verify the installation folder.';
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ResultCode: Integer; Params: String;
begin
  if CurStep = ssPostInstall then begin
    WizardForm.StatusLabel.Caption := 'Starting Nexus and verifying the monitor...';
    Params := 'provision "' + ExpandConstant('{app}') + '"';
    if not WizardSilent then begin
      if IsTaskSelected('optionalbrowser') then Params := Params + ' --browser';
      if IsTaskSelected('optionalsearch') then Params := Params + ' --search';
    end;
    // SuppressibleMsgBox, not MsgBox: a silent install (the updater, an agent) must never wait for a click that nobody sees.
    if not Exec(ExpandConstant('{app}\Nexus.Setup.exe'), Params, ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      SuppressibleMsgBox('Nexus files were copied, but setup did not start. Retry with Nexus Settings > Set up or repair. Check %LOCALAPPDATA%\Nexus\setup.log. The installer reports failure.', mbError, MB_OK, IDOK)
    else if ResultCode <> 0 then
      SuppressibleMsgBox('Nexus files were copied, but setup failed. Close Nexus and select Settings > Set up or repair. Check %LOCALAPPDATA%\Nexus\setup.log. Your data remains intact. The installer reports failure.', mbError, MB_OK, IDOK)
    else Provisioned := True;
  end;
end;
