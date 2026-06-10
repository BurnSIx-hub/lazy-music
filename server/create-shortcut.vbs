' Lazy Music: creates the "Foundry VTT (with music)" shortcut on the Desktop.
' Run this once by double-clicking it.
Option Explicit
Dim fso, sh, here, lnk
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Foundry VTT (with music).lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
lnk.Arguments = """" & here & "\start-foundry-with-music.vbs"""
lnk.WorkingDirectory = here
lnk.Description = "Foundry VTT + Lazy Music helper"
lnk.Save
MsgBox "Shortcut 'Foundry VTT (with music)' created on your Desktop." & vbCrLf & _
       "Use it to start Foundry from now on.", 64, "Lazy Music"
