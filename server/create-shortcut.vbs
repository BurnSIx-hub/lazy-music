' Lazy Music: creates the "Foundry VTT (with music)" shortcut on the Desktop.
' Run this once by double-clicking it.
Option Explicit
Dim fso, sh, here, lnk, foundryExe, iconNote

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(here & "\common.vbs") Then
  MsgBox "common.vbs is missing next to this script." & vbCrLf & vbCrLf & _
         "The module folder is incomplete - unpack module.zip again.", 16, "Lazy Music"
  WScript.Quit
End If
ExecuteGlobal fso.OpenTextFile(here & "\common.vbs", 1).ReadAll

' No point making a shortcut to something that cannot work
If Not CheckLayout() Then WScript.Quit

Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Foundry VTT (with music).lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
lnk.Arguments = """" & here & "\start-foundry-with-music.vbs"""
lnk.WorkingDirectory = here
lnk.Description = "Foundry VTT + Lazy Music helper"

' Without an explicit icon the shortcut inherits the wscript.exe one and looks
' like a stray script rather than Foundry.
foundryExe = FindFoundry()
If foundryExe <> "" Then
  lnk.IconLocation = foundryExe & ",0"
  iconNote = ""
Else
  iconNote = vbCrLf & vbCrLf & "Foundry was not found, so the shortcut keeps a generic icon." & vbCrLf & _
             "Add your Foundry path to common.vbs and run this again to fix it."
End If

lnk.Save
MsgBox "Shortcut 'Foundry VTT (with music)' created on your Desktop." & vbCrLf & _
       "Use it to start Foundry from now on." & iconNote, 64, "Lazy Music"
