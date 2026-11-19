Option Explicit

Dim fso, shell, scriptDir, trayScript, psArgs, i, arg, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
trayScript = fso.BuildPath(scriptDir, "tray-app.ps1")

psArgs = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = LCase(Trim(WScript.Arguments(i)))
  If arg = "--minimized" Or arg = "-startminimized" Then
    psArgs = " -StartMinimized"
  End If
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """" & psArgs
shell.Run cmd, 0, False
