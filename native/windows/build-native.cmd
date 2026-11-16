@echo off
setlocal
rem Existing toolchain only. Call with Node-API headers and x64 import library.
if "%~1"=="" exit /b 2
if "%~2"=="" exit /b 2
if not exist "%~1\node_api.h" exit /b 2
if not exist "%~2" exit /b 2
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /std:c++17 /EHsc /W4 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /DNAPI_VERSION=8 /DNODE_GYP_MODULE_NAME=ce_windows /MT /LD /I"%~1" ce_windows.cpp /Fo:build\ce_windows.obj /Fe:build\ce_windows.node /link "%~2" advapi32.lib
exit /b %errorlevel%
