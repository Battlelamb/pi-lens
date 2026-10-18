@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe" --preserve-symlinks "%~dp0\__TARGET__" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node --preserve-symlinks "%~dp0\__TARGET__" %*
)