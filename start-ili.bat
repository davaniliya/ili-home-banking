@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo ========================================
echo   ILI Home Banking - Startup Script
echo ========================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found
node --version
echo.

if not exist "node_modules" (
    echo [INFO] node_modules not found. Running npm install...
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        echo.
        echo Try these steps:
        echo   1. Delete the node_modules folder if it exists
        echo   2. Delete package-lock.json if it exists
        echo   3. Run: npm.cmd install
        echo   4. If better-sqlite3 still fails, use Node.js 22 LTS
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed.
    echo.
) else (
    echo [OK] node_modules already present.
    echo.
)

echo [INFO] Starting ILI Home Banking server...
echo.
node server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server exited with an error.
    echo.
    pause
)
