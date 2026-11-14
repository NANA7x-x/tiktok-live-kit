' ============================================================
' TikTok LIVE kit - Auto-start setup
'
' Double-click this file ONCE. It creates:
'   1) Startup shortcut "TikTokLiveServer.lnk"
'      -> the bridge server starts (minimized) at Windows sign-in
'   2) Desktop icon "NANA LIVE.lnk"
'      -> opens the remote page (starts the server if needed)
'
' Safe to run again: existing shortcuts are simply overwritten.
' To undo, run the OFF script in the same folder.
' ============================================================
Option Explicit

Dim sh, fso, kitFolder, serverJs, nodePath
Dim startupFolder, desktopFolder, lnk

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' --- Kit folder = the folder this script itself is in.
'     (Resolved from the script path, so it works even if the
'      folder name contains Japanese characters.)
kitFolder = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))   ' this script is in the "tools" folder
serverJs  = fso.BuildPath(fso.BuildPath(kitFolder, "app"), "start.js")

If Not fso.FileExists(serverJs) Then
  MsgBox "app\start.js ga mitsukarimasen deshita." & vbCrLf & _
         "Kono file wo kit no folder ni oite kara, mou ichido jikkou shite kudasai.", _
         vbExclamation, "TikTok LIVE kit - Setup"
  WScript.Quit 1
End If

' --- Find node.exe (PATH first, then default install folders) ---
nodePath = FindNode()
If nodePath = "" Then
  MsgBox "Node.js ga mitsukarimasen deshita." & vbCrLf & _
         "https://nodejs.org kara Node.js wo irete kara, mou ichido jikkou shite kudasai.", _
         vbExclamation, "TikTok LIVE kit - Setup"
  WScript.Quit 1
End If

' --- 1) Startup shortcut: start the server at sign-in, minimized ---
startupFolder = sh.SpecialFolders("Startup")
Set lnk = sh.CreateShortcut(fso.BuildPath(startupFolder, "TikTokLiveServer.lnk"))
lnk.TargetPath       = nodePath
lnk.Arguments        = """" & serverJs & """ --no-open"
lnk.WorkingDirectory = kitFolder
lnk.WindowStyle      = 7   ' 7 = start minimized (stays on the taskbar)
lnk.Description      = "TikTok LIVE kit server (auto start)"
lnk.Save

' --- 2) Desktop icon "NANA LIVE": opens the remote (starts the server if it is not running) ---
desktopFolder = sh.SpecialFolders("Desktop")
Set lnk = sh.CreateShortcut(fso.BuildPath(desktopFolder, "NANA LIVE.lnk"))
lnk.TargetPath       = nodePath
lnk.Arguments        = """" & serverJs & """"
lnk.WorkingDirectory = kitFolder
lnk.WindowStyle      = 7
lnk.IconLocation     = nodePath & ",0"
lnk.Description      = "TikTok LIVE kit: open remote (start server if needed)"
lnk.Save
If fso.FileExists(fso.BuildPath(desktopFolder, "TikTokRemote.url")) Then fso.DeleteFile fso.BuildPath(desktopFolder, "TikTokRemote.url"), True

MsgBox "Settei kanryou!" & vbCrLf & vbCrLf & _
       "Jikai no sign-in kara, server ga jidou de tachiagarimasu." & vbCrLf & _
       "(Kuroi gamen wa taskbar ni chiisaku nokorimasu.)" & vbCrLf & vbCrLf & _
       "Desktop ni ""NANA LIVE"" ga dekimashita." & vbCrLf & _
       "Haishin mae wa sore wo hiraku dake de OK desu.", _
       vbInformation, "TikTok LIVE kit - Setup"

' ------------------------------------------------------------
' FindNode: full path of node.exe, or "" if not found.
' ------------------------------------------------------------
Function FindNode()
  Dim execObj, line, p
  FindNode = ""

  ' 1) Ask Windows where node.exe is (PATH lookup)
  On Error Resume Next
  Set execObj = sh.Exec("cmd /c where node")
  If Err.Number = 0 Then
    Do While execObj.Status = 0
      WScript.Sleep 50
    Loop
    If Not execObj.StdOut.AtEndOfStream Then
      line = Trim(execObj.StdOut.ReadLine())
      If line <> "" And fso.FileExists(line) Then FindNode = line
    End If
  End If
  Err.Clear
  On Error GoTo 0
  If FindNode <> "" Then Exit Function

  ' 2) Default install locations
  p = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If
  p = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If
End Function
