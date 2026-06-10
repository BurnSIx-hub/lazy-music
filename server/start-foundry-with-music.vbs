' Lazy Music: starts the music helper (hidden) and Foundry VTT itself.
' The helper exits by itself ~2 minutes after Foundry is closed.
' If your Foundry is installed somewhere unusual, add its path to the list below.
Option Explicit
Dim fso, sh, here, foundryExe, candidates, c
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

foundryExe = ""
candidates = Array( _
  "P:\Foundry VTT\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\foundryvtt\Foundry Virtual Tabletop.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\FoundryVTT\Foundry Virtual Tabletop.exe", _
  "C:\Program Files\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe", _
  "D:\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe")
For Each c In candidates
  If fso.FileExists(c) Then
    foundryExe = c
    Exit For
  End If
Next

sh.Run """" & here & "\bin\deno.exe"" run -A """ & here & "\helper.mjs""", 0, False

If foundryExe = "" Then
  MsgBox "Foundry Virtual Tabletop.exe not found." & vbCrLf & _
         "Open this file in Notepad and add your Foundry path to the candidates list:" & vbCrLf & _
         WScript.ScriptFullName, 48, "Lazy Music"
Else
  sh.Run """" & foundryExe & """", 1, False
End If
