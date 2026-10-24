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
      Exit Function
    End If
  Next
  ' Not in the usual places: ask Foundry's own shortcut. A path added to the
  ' list above is lost with every module update, the shortcut is not
  FindFoundry = FoundryFromShortcuts()
End Function

' Foundry's installer puts "Foundry Virtual Tabletop" shortcuts on the Desktop
' and in the Start menu - read where they point.
Function FoundryFromShortcuts()
  Dim f, s, place, dir, folder, lnk, target
  Set f = CreateObject("Scripting.FileSystemObject")
  Set s = CreateObject("WScript.Shell")
  FoundryFromShortcuts = ""
  On Error Resume Next
  For Each place In Array("Desktop", "AllUsersDesktop", "Programs", "AllUsersPrograms")
    dir = s.SpecialFolders(place)
    If dir <> "" And f.FolderExists(dir) Then
      For Each lnk In Array(dir & "\Foundry Virtual Tabletop.lnk", dir & "\Foundry VTT.lnk")
        target = ShortcutTarget(lnk)
        If target <> "" Then
          FoundryFromShortcuts = target
          Exit Function
        End If
      Next
      For Each folder In f.GetFolder(dir).SubFolders
        target = ShortcutTarget(folder.Path & "\Foundry Virtual Tabletop.lnk")
        If target <> "" Then
          FoundryFromShortcuts = target
          Exit Function
        End If
      Next
    End If
  Next
End Function

' The shortcut's target if it is Foundry itself and still exists, otherwise "".
Function ShortcutTarget(lnk)
  Dim f, s, t
  Set f = CreateObject("Scripting.FileSystemObject")
  Set s = CreateObject("WScript.Shell")
  ShortcutTarget = ""
  If Not f.FileExists(lnk) Then Exit Function
  t = s.CreateShortcut(lnk).TargetPath
  If LCase(f.GetFileName(t)) = "foundry virtual tabletop.exe" And f.FileExists(t) Then ShortcutTarget = t
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

' Starts the helper from a copy in %LOCALAPPDATA%\lazy-music\helper, not from
' the module folder. Foundry deletes the whole module folder when it updates the
' module, and a deno.exe running from there kept it locked: the update stopped
' halfway with EBUSY and left the module half-deleted. The copy is refreshed on
' every start; deno.exe is skipped while a running helper holds it, and
' yt-dlp.exe is only copied once - after that the helper itself keeps the newer
' of the two (it may have been updated by the button in the module window).
' If the copy cannot be made, the helper starts from the module folder as before.
Sub StartHelper()
  Dim f, s, src, dst, exe
  Set f = CreateObject("Scripting.FileSystemObject")
  Set s = CreateObject("WScript.Shell")
  src = ServerDir()
  dst = s.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\lazy-music\helper"

  On Error Resume Next
  If Not f.FolderExists(f.GetParentFolderName(dst)) Then f.CreateFolder f.GetParentFolderName(dst)
  If Not f.FolderExists(dst) Then f.CreateFolder dst
  If Not f.FolderExists(dst & "\bin") Then f.CreateFolder dst & "\bin"
  If Not f.FileExists(dst & "\bin\deno.exe") Then
    f.CopyFile src & "\bin\deno.exe", dst & "\bin\deno.exe", True
  ElseIf f.GetFile(dst & "\bin\deno.exe").Size <> f.GetFile(src & "\bin\deno.exe").Size Then
    f.CopyFile src & "\bin\deno.exe", dst & "\bin\deno.exe", True
  End If
  If Not f.FileExists(dst & "\bin\yt-dlp.exe") Then f.CopyFile src & "\bin\yt-dlp.exe", dst & "\bin\yt-dlp.exe", True
  f.CopyFile src & "\helper.mjs", dst & "\helper.mjs", True
  Err.Clear
  On Error GoTo 0

  ' The working folder is held open by the process too - keep it out of the module
  If f.FileExists(dst & "\bin\deno.exe") And f.FileExists(dst & "\bin\yt-dlp.exe") And f.FileExists(dst & "\helper.mjs") Then
    exe = dst
    s.CurrentDirectory = dst
  Else
    exe = src
    s.CurrentDirectory = s.ExpandEnvironmentStrings("%LOCALAPPDATA%")
  End If
  s.Run """" & exe & "\bin\deno.exe"" run -A """ & exe & "\helper.mjs"" --module """ & ModuleDir() & """", 0, False
End Sub

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
