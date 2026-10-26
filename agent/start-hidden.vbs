' Starts Claude Remote in the background: the tray application (tray.ps1), which in turn runs
' and watches the agent. No console window. Used by the Startup shortcut that
' install-autostart.bat creates; double-click it to start by hand.
Option Explicit
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\tray.ps1""", 0, False
