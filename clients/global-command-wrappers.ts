/**
 * Exact generator output admitted by the discovered-command trust gate (#4566 r17).
 * Captures and provenance: tests/fixtures/global-command-wrappers/README.md.
 * Only __TARGET__ and (Yarn 4) __RUNTIME__ are variable literal path slots.
 * New generator versions/options require captures; they never widen by parsing.
 */
export const GLOBAL_COMMAND_WRAPPERS: readonly {
	id: string;
	kind: "cmd" | "ps1" | "sh";
	text: string;
}[] = [
	{
		id: "npm-node-cmd",
		kind: "cmd",
		text: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\__TARGET__" %*\r\n',
	},
	{
		id: "npm-node-ps1",
		kind: "ps1",
		text: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe"  "$basedir/__TARGET__" $args\n  } else {\n    & "$basedir/node$exe"  "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe"  "$basedir/__TARGET__" $args\n  } else {\n    & "node$exe"  "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n',
	},
	{
		id: "npm-node-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w "$basedir"`\n        fi\n    ;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/__TARGET__" "$@"\nelse \n  exec node  "$basedir/__TARGET__" "$@"\nfi\n',
	},
	{
		id: "npm-direct-cmd",
		kind: "cmd",
		text: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\__TARGET__"   %*\r\n',
	},
	{
		id: "npm-direct-ps1",
		kind: "ps1",
		text: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n# Support pipeline input\nif ($MyInvocation.ExpectingInput) {\n  $input | & "$basedir/__TARGET__"   $args\n} else {\n  & "$basedir/__TARGET__"   $args\n}\nexit $LASTEXITCODE\n',
	},
	{
		id: "npm-direct-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w "$basedir"`\n        fi\n    ;;\nesac\n\nexec "$basedir/__TARGET__"   "$@"\n',
	},
	{
		id: "pnpm-node-cmd",
		kind: "cmd",
		text: '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\__TARGET__" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\__TARGET__" %*\r\n)\r\n',
	},
	{
		id: "pnpm-node-ps1",
		kind: "ps1",
		text: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe"  "$basedir/__TARGET__" $args\n  } else {\n    & "$basedir/node$exe"  "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe"  "$basedir/__TARGET__" $args\n  } else {\n    & "node$exe"  "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n',
	},
	{
		id: "pnpm-node-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/__TARGET__" "$@"\nelse\n  exec node  "$basedir/__TARGET__" "$@"\nfi\n',
	},
	{
		id: "pnpm-preserve-cmd",
		kind: "cmd",
		text: '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" --preserve-symlinks "%~dp0\\__TARGET__" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node --preserve-symlinks "%~dp0\\__TARGET__" %*\r\n)\r\n',
	},
	{
		id: "pnpm-preserve-ps1",
		kind: "ps1",
		text: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe" --preserve-symlinks "$basedir/__TARGET__" $args\n  } else {\n    & "$basedir/node$exe" --preserve-symlinks "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe" --preserve-symlinks "$basedir/__TARGET__" $args\n  } else {\n    & "node$exe" --preserve-symlinks "$basedir/__TARGET__" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n',
	},
	{
		id: "pnpm-preserve-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" --preserve-symlinks "$basedir/__TARGET__" "$@"\nelse\n  exec node --preserve-symlinks "$basedir/__TARGET__" "$@"\nfi\n',
	},
	{
		id: "pnpm-direct-cmd",
		kind: "cmd",
		text: '@SETLOCAL\r\n@"%~dp0\\__TARGET__"   %*\r\n',
	},
	{
		id: "pnpm-direct-ps1",
		kind: "ps1",
		text: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=".exe"\n}\n# Support pipeline input\nif ($MyInvocation.ExpectingInput) {\n  $input | & "$basedir/__TARGET__"   $args\n} else {\n  & "$basedir/__TARGET__"   $args\n}\nexit $LASTEXITCODE\n',
	},
	{
		id: "pnpm-direct-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\n"$basedir/__TARGET__"   "$@"\nexit $?\n',
	},
	{
		id: "classic-node-cmd",
		kind: "cmd",
		text: '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\__TARGET__" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\__TARGET__" %*\r\n)',
	},
	{
		id: "classic-node-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  "$basedir/node"  "$basedir/__TARGET__" "$@"\n  ret=$?\nelse \n  node  "$basedir/__TARGET__" "$@"\n  ret=$?\nfi\nexit $ret\n',
	},
	{
		id: "classic-preserve-cmd",
		kind: "cmd",
		text: '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" --preserve-symlinks "%~dp0\\__TARGET__" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node --preserve-symlinks "%~dp0\\__TARGET__" %*\r\n)',
	},
	{
		id: "classic-preserve-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  "$basedir/node" --preserve-symlinks "$basedir/__TARGET__" "$@"\n  ret=$?\nelse \n  node --preserve-symlinks "$basedir/__TARGET__" "$@"\n  ret=$?\nfi\nexit $ret\n',
	},
	{
		id: "classic-direct-cmd",
		kind: "cmd",
		text: '@"%~dp0\\__TARGET__"   %*\r\n',
	},
	{
		id: "classic-direct-sh",
		kind: "sh",
		text: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\ncase `uname` in\n    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\nesac\n\n"$basedir/__TARGET__"   "$@"\nexit $?\n',
	},
	{
		id: "yarn4-node-cmd",
		kind: "cmd",
		text: '@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"__RUNTIME__" "__TARGET__" %*',
	},
	{
		id: "yarn4-node-sh",
		kind: "sh",
		text: '#!/bin/sh\nexec "__RUNTIME__" \'__TARGET__\' "$@"\n',
	},
];
