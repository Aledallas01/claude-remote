' Starts the Claude Remote agent with no window. Output goes to agent.log next to this file
' (rotated to agent.log.1 when it grows past 5 MB). Used by the Startup shortcut that
' install-autostart.bat creates; double-click it to start the agent in the background by hand.
Option Explicit
Dim sh, fso, dir, logFile
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = dir & "\agent.log"
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5 * 1024 * 1024 Then
    If fso.FileExists(logFile & ".1") Then fso.DeleteFile logFile & ".1", True
    fso.MoveFile logFile, logFile & ".1"
  End If
End If
sh.CurrentDirectory = dir
' --no-hooks: never prompt (there is no console); hooks are installed once with start.bat.
sh.Run "cmd /c node src\index.js --no-hooks >> """ & logFile & """ 2>&1", 0, False
