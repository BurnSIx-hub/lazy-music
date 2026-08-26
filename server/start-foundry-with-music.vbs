' Lazy Music: starts the music helper (hidden) and Foundry VTT itself.
' The helper exits by itself ~2 minutes after Foundry is closed.
'
' Foundry's install path lives in common.vbs - edit it there if needed.
Option Explicit
Dim fso, sh, here, foundryExe

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(here & "\common.vbs") Then
  MsgBox "common.vbs is missing next to this script." & vbCrLf & vbCrLf & _
         "The module folder is incomplete - unpack module.zip again.", 16, "Lazy Music"
  WScript.Quit
End If
ExecuteGlobal fso.OpenTextFile(here & "\common.vbs", 1).ReadAll

' Wrong folder name or missing files: say so plainly instead of failing later
If Not CheckLayout() Then WScript.Quit
If Not EnsureBinaries() Then WScript.Quit

sh.Run """" & here & "\bin\deno.exe"" run -A """ & here & "\helper.mjs""", 0, False

foundryExe = FindFoundry()
If foundryExe = "" Then
  MsgBox "Foundry Virtual Tabletop.exe not found." & vbCrLf & vbCrLf & _
         "Open this file in Notepad and add your Foundry path to the list:" & vbCrLf & _
         here & "\common.vbs" & vbCrLf & vbCrLf & _
         "The music helper is already running, so you can also just start" & vbCrLf & _
         "Foundry the usual way.", 48, "Lazy Music"
Else
  sh.Run """" & foundryExe & """", 1, False
End If
