' run-hidden.vbs <file> - runs <file> (the mcp-memory launcher .cmd) with NO window and returns at once.
' Why: Node's `detached` on Windows starts the child WITHOUT a console (DETACHED_PROCESS), which
' makes Windows ignore `windowsHide`; the PowerShell the launcher runs then opens a VISIBLE console
' (it flashed on every session start). Without `detached`, the launcher dies with the hook process.
' wscript is a GUI host (no console of its own); Run(..., 0, False) starts the file hidden and detached.
CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False
