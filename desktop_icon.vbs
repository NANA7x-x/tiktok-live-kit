' ============================================================
' TikTok LIVE kit - One-click desktop icon
'
' Double-click this file ONCE. It creates a desktop icon
' "NANA LIVE". After that, double-click the icon to:
'   - start the server (first time: installs parts automatically)
'   - open the remote page in your browser
' If the server is already running, the icon just opens the remote.
' Safe to run again: the icon is simply overwritten.
' ============================================================
Option Explicit

Dim sh, fso, kitFolder, startJs, nodePath, lnk

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

kitFolder = fso.GetParentFolderName(WScript.ScriptFullName)
startJs   = fso.BuildPath(kitFolder, "start.js")

If Not fso.FileExists(startJs) Then
  MsgBox "start.js ga mitsukarimasen deshita." & vbCrLf & _
         "GitHub Desktop de Pull shite kara, mou ichido jikkou shite kudasai.", _
         vbExclamation, "TikTok LIVE kit - Desktop icon"
  WScript.Quit 1
End If

nodePath = FindNode()
If nodePath = "" Then
  MsgBox "Node.js ga mitsukarimasen deshita." & vbCrLf & _
         "https://nodejs.org kara Node.js wo irete kara, mou ichido jikkou shite kudasai.", _
         vbExclamation, "TikTok LIVE kit - Desktop icon"
  WScript.Quit 1
End If

Set lnk = sh.CreateShortcut(fso.BuildPath(sh.SpecialFolders("Desktop"), "NANA LIVE.lnk"))
lnk.TargetPath       = nodePath
lnk.Arguments        = """" & startJs & """"
lnk.WorkingDirectory = kitFolder
lnk.WindowStyle      = 7   ' minimized (the server window stays on the taskbar)
lnk.IconLocation     = nodePath & ",0"
lnk.Description      = "TikTok LIVE kit: start server + open remote"
lnk.Save

MsgBox "Desktop ni ""NANA LIVE"" ga dekimashita!" & vbCrLf & vbCrLf & _
       "Haishin mae wa sore wo double-click suru dake de OK desu." & vbCrLf & _
       "(Server ga ugoite inakereba kidou shite, remote wo hirakimasu.)", _
       vbInformation, "TikTok LIVE kit - Desktop icon"

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
