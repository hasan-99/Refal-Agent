Option Explicit

Dim shell, fso, root, logs, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logs = fso.BuildPath(root, "logs")
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)

shell.CurrentDirectory = root
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & "C:\\Program Files\\nodejs\\node.exe" & Chr(34) & " " & Chr(34) & fso.BuildPath(root, "src\\bot.js") & Chr(34) & " >> " & Chr(34) & fso.BuildPath(logs, "worker.log") & Chr(34) & " 2>&1" & Chr(34)
shell.Run command, 0, False

shell.CurrentDirectory = fso.BuildPath(root, "dashboard")
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & "C:\\Program Files\\nodejs\\node.exe" & Chr(34) & " " & Chr(34) & fso.BuildPath(root, "dashboard\\server.js") & Chr(34) & " >> " & Chr(34) & fso.BuildPath(logs, "dashboard.log") & Chr(34) & " 2>&1" & Chr(34)
shell.Run command, 0, False
