' ============================================================
' TikTok LIVE kit - Remove auto-start
'
' Double-click this file ONCE. It deletes the shortcuts that
' the ON script created:
'   - Startup:  TikTokLiveServer.lnk
'   - Desktop:  NANA LIVE.lnk / TikTokRemote.url (old)
' Safe to run even when the shortcuts do not exist.
' ============================================================
Option Explicit

Dim sh, fso, targetPath, removedList
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

removedList = ""

targetPath = fso.BuildPath(sh.SpecialFolders("Startup"), "TikTokLiveServer.lnk")
If fso.FileExists(targetPath) Then
  fso.DeleteFile targetPath, True
  removedList = removedList & " - Startup: TikTokLiveServer" & vbCrLf
End If

targetPath = fso.BuildPath(sh.SpecialFolders("Desktop"), "NANA LIVE.lnk")
If fso.FileExists(targetPath) Then
  fso.DeleteFile targetPath, True
  removedList = removedList & " - Desktop: NANA LIVE" & vbCrLf
End If

targetPath = fso.BuildPath(sh.SpecialFolders("Desktop"), "TikTokRemote.url")
If fso.FileExists(targetPath) Then
  fso.DeleteFile targetPath, True
  removedList = removedList & " - Desktop: TikTokRemote" & vbCrLf
End If

If removedList = "" Then
  MsgBox "Sakujo suru shortcut wa arimasen deshita.", _
         vbInformation, "TikTok LIVE kit - Remove auto-start"
Else
  MsgBox "Sakujo shimashita:" & vbCrLf & removedList & vbCrLf & _
         "Tsugi no sign-in kara, server wa jidou de tachiagarimasen.", _
         vbInformation, "TikTok LIVE kit - Remove auto-start"
End If
