' Lazy Music: shared helpers for the two launcher scripts.
' Loaded via ExecuteGlobal, so it must contain declarations only.
'
' >>> If your Foundry is installed somewhere unusual, add its path to the list
' >>> below. This is the ONLY place both scripts read it from.

Function FoundryCandidates()
  Dim s
  Set s = CreateObject("WScript.Shell")
  FoundryCandidates = Array( _
    "E:\Foundry VTT\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe", _
    "P:\Foundry VTT\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe", _
    s.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\foundryvtt\Foundry Virtual Tabletop.exe", _
    s.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\FoundryVTT\Foundry Virtual Tabletop.exe", _
    "C:\Program Files\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe", _
    "D:\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe")
End Function

Function FindFoundry()
  Dim f, c
  Set f = CreateObject("Scripting.FileSystemObject")
  FindFoundry = ""
  For Each c In FoundryCandidates()
    If f.FileExists(c) Then
      FindFoundry = c
      Exit For
    End If
  Next
End Function

Function ServerDir()
  Dim f
  Set f = CreateObject("Scripting.FileSystemObject")
  ServerDir = f.GetParentFolderName(WScript.ScriptFullName)
End Function

Function ModuleDir()
  Dim f
  Set f = CreateObject("Scripting.FileSystemObject")
  ModuleDir = f.GetParentFolderName(ServerDir())
End Function

' Foundry loads a module only when its folder name matches the "id" field in
' module.json. A GitHub source ZIP unpacks into "lazy-music-main", and the
' module then silently never appears in the module list at all.
' Returns True when the layout is fine, otherwise explains and returns False.
Function CheckLayout()
  Dim f, name
  Set f = CreateObject("Scripting.FileSystemObject")
  CheckLayout = False

  name = f.GetFileName(ModuleDir())
  If LCase(name) <> "lazy-music" Then
    MsgBox "The module folder is named:" & vbCrLf & vbCrLf & _
           "    " & name & vbCrLf & vbCrLf & _
           "Foundry only loads it when the folder is named exactly:" & vbCrLf & vbCrLf & _
           "    lazy-music" & vbCrLf & vbCrLf & _
           "Rename the folder, restart Foundry, then run this again." & vbCrLf & _
           "(A GitHub source ZIP always unpacks into lazy-music-main.)", _
           48, "Lazy Music"
    Exit Function
  End If

  If Not f.FileExists(ServerDir() & "\helper.mjs") Then
    MsgBox "helper.mjs is missing from:" & vbCrLf & ServerDir() & vbCrLf & vbCrLf & _
           "The module folder is incomplete. Download module.zip from the" & vbCrLf & _
           "Releases page and unpack it again.", 16, "Lazy Music"
    Exit Function
  End If

  CheckLayout = True
End Function

' deno.exe and yt-dlp.exe are not stored in git, so a source ZIP has no bin\
' folder and the helper cannot start. Offer to download them instead of
' failing later with a bare "file not found" from the shell.
Function EnsureBinaries()
  Dim f, s, deno, answer
  Set f = CreateObject("Scripting.FileSystemObject")
  Set s = CreateObject("WScript.Shell")
  deno = ServerDir() & "\bin\deno.exe"

  EnsureBinaries = True
  If f.FileExists(deno) Then Exit Function
  EnsureBinaries = False

  answer = MsgBox("The music helper needs deno.exe and yt-dlp.exe." & vbCrLf & vbCrLf & _
                  "They are not part of the GitHub source ZIP, so they have to" & vbCrLf & _
                  "be downloaded once (about 120 MB)." & vbCrLf & vbCrLf & _
                  "Download them now?" & vbCrLf & vbCrLf & _
                  "Tip: the ready-made module.zip from the Releases page" & vbCrLf & _
                  "already contains both and needs no download.", _
                  vbYesNo + vbQuestion, "Lazy Music")
  If answer <> vbYes Then Exit Function

  s.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ServerDir() & "\get-binaries.ps1""", 1, True

  If f.FileExists(deno) Then
    EnsureBinaries = True
  Else
    MsgBox "Download did not finish." & vbCrLf & vbCrLf & _
           "Take module.zip from the Releases page instead - the binaries" & vbCrLf & _
           "are already inside it.", 16, "Lazy Music"
  End If
End Function
