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
PrivilegesRequired=lowest
WizardStyle=modern
Compression=zip/1
SolidCompression=no
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "desktop,installer,.git*"
Source: "Preflight.ps1"; Flags: dontcopy
Source: "..\Nexus-Takeover.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\Nexus Harness"; Filename: "{app}\Nexus.Desktop.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Nexus Harness"; Filename: "{app}\Nexus.Desktop.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Nexus Harness"; ValueData: """{app}\Nexus.Desktop.exe"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\Nexus.Desktop.exe"; Description: "Open Nexus Harness"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Nexus.Desktop.exe"; Flags: nowait skipifnotsilent; Check: SetupCompleted

[Code]
var Provisioned: Boolean;

function SetupCompleted: Boolean;
begin
  Result := Provisioned;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer; ResultFile, Params: String; Detail: AnsiString;
begin
  Result := '';
  ExtractTemporaryFile('Preflight.ps1');
  ExtractTemporaryFile('Nexus-Takeover.ps1');
  ResultFile := ExpandConstant('{tmp}\nexus-preflight.txt');
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Preflight.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '" -ResultFile "' + ResultFile + '"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'Nexus could not check the installation. Windows PowerShell is required.'
  else if ResultCode <> 0 then begin
    if LoadStringFromFile(ResultFile, Detail) then Result := String(Detail)
    else Result := 'Nexus could not verify the installation folder.';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ResultCode: Integer; Params: String;
begin
  if CurStep = ssPostInstall then begin
    Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\Setup.ps1') + '" -NoBrowserAtSignIn';
    // SuppressibleMsgBox, not MsgBox: a silent install (the updater, an agent) must never wait for a click that nobody sees.
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      SuppressibleMsgBox('Nexus was copied, but setup could not start. Open Nexus Settings and select Set up or repair.', mbError, MB_OK, IDOK)
    else if ResultCode <> 0 then
      SuppressibleMsgBox('Nexus was copied, but setup did not finish. Open Nexus Settings and select Set up or repair. Existing installations were preserved.', mbError, MB_OK, IDOK)
    else Provisioned := True;
  end;
end;
