; 绿果PC Windows 安装向导脚本 (Inno Setup 6)
; 用法: iscc /DArch=x64 /DAppVersion=1.0.0 /DSourceDir=... /DOutputDir=... lvguo-pc.iss

#ifndef Arch
  #define Arch "x64"
#endif

#ifndef AppVersion
  #define AppVersion "3.0.3"
#endif

#ifndef SourceDir
  #define SourceDir "stage"
#endif

#ifndef OutputDir
  #define OutputDir "dist"
#endif

#define MyAppName "绿果PC"
#define MyAppPublisher "Pengfei"
#define MyAppExeName "lvguo-pc.exe"

[Setup]
AppId={{8D6E4A21-7C1B-4E2A-9B0F-3A91D48F2011}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\LvguoPC
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
DisableProgramGroupPage=yes
DisableDirPage=no
ShowLanguageDialog=no
OutputDir={#OutputDir}
#ifdef SourceDir64
  OutputBaseFilename=LvguoPC-Setup-{#AppVersion}-win
  ArchitecturesInstallIn64BitMode=x64compatible
#else
  OutputBaseFilename=LvguoPC-Setup-{#AppVersion}-win-{#Arch}
  #if Arch == "x64"
    ArchitecturesAllowed=x64compatible
    ArchitecturesInstallIn64BitMode=x64compatible
  #endif
#endif
SetupIconFile=app_icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
UsePreviousTasks=no

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl,ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; GroupDescription: "附加任务:"
Name: "startup"; Description: "开机自动启动 {#MyAppName}(&S)"; GroupDescription: "附加任务:"; Flags: unchecked
Name: "protocol"; Description: "注册 lvguo:// 桌面协议"; GroupDescription: "附加任务:"

[Files]
#ifdef SourceDir64
Source: "{#SourceDir64}\lvguo-pc.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: Is64BitInstallMode
Source: "{#SourceDir64}\lvguo_core.dll"; DestDir: "{app}"; Flags: ignoreversion; Check: Is64BitInstallMode
Source: "{#SourceDir32}\lvguo-pc.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: not Is64BitInstallMode
Source: "{#SourceDir32}\lvguo_core.dll"; DestDir: "{app}"; Flags: ignoreversion; Check: not Is64BitInstallMode
#else
Source: "{#SourceDir}\lvguo-pc.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\lvguo_core.dll"; DestDir: "{app}"; Flags: ignoreversion
#endif

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "LvguoPC"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup
Root: HKCU; Subkey: "Software\Classes\lvguo"; ValueType: string; ValueData: "URL:LvguoPC Protocol"; Flags: uninsdeletekey; Tasks: protocol
Root: HKCU; Subkey: "Software\Classes\lvguo"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey; Tasks: protocol
Root: HKCU; Subkey: "Software\Classes\lvguo\DefaultIcon"; ValueType: string; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey; Tasks: protocol
Root: HKCU; Subkey: "Software\Classes\lvguo\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey; Tasks: protocol

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
