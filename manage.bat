@echo off
setlocal enabledelayedexpansion
title Parking Server - Project Manager

:: Set current directory to the directory of the batch file
cd /d "%~dp0"

:MENU
cls
echo =====================================================================
echo                PARKING SERVER - PROJECT MANAGER
echo =====================================================================
echo.
echo  [1] Export Project (Compresses project without node_modules/.git)
echo  [2] Import Project (Extracts project, installs packages, runs setup)
echo  [3] Exit
echo.
echo =====================================================================
echo.
set /p opt="Enter your choice (1-3): "

if "%opt%"=="1" goto EXPORT
if "%opt%"=="2" goto IMPORT
if "%opt%"=="3" goto EXIT

echo.
echo [ERROR] Invalid choice. Please enter 1, 2, or 3.
timeout /t 2 >nul
goto MENU

:EXPORT
cls
echo =====================================================================
echo                         EXPORTING PROJECT
echo =====================================================================
echo.

:: Get the current folder name
for %%I in ("%CD%") do set "FolderName=%%~nxI"
set "DefaultZipName=..\!FolderName!-export.zip"

echo Current Project Directory: %CD%
echo Default Export Destination: !DefaultZipName!
echo.
set /p "ZipInput=Enter export destination zip path (Press Enter for default): "
if "!ZipInput!"=="" (
    set "ZipPath=!DefaultZipName!"
) else (
    set "ZipPath=!ZipInput!"
)

:: Ensure the destination path has a .zip extension
if /I not "!ZipPath:~-4!"==".zip" (
    set "ZipPath=!ZipPath!.zip"
)

echo.
echo Check and delete existing zip if present...
if exist "!ZipPath!" (
    echo Deleting existing file: !ZipPath!
    del /F /Q "!ZipPath!"
)

echo.
echo Preparing temporary directory for packaging...
set "TempDir=%CD%\_temp_export_"
if exist "!TempDir!" rmdir /S /Q "!TempDir!"
mkdir "!TempDir!"

echo.
echo Copying files to temporary directory...
echo (Excluding: node_modules, .git, prisma_client_mysql, prisma_client_mssql, and zip archives)
:: Robocopy exit code >= 8 means failure, lower codes are success/info.
robocopy "%CD%" "!TempDir!" /E /XD node_modules .git prisma_client_mysql prisma_client_mssql _temp_export_ /XF *.zip >nul

echo.
echo Compressing to ZIP archive...
:: Set environment variables for PowerShell to reference to avoid quoting/space issues
set "POWERSHELL_TEMP_DIR=!TempDir!"
set "POWERSHELL_ZIP_PATH=!ZipPath!"
powershell -NoProfile -Command "Compress-Archive -Path \"$env:POWERSHELL_TEMP_DIR\*\" -DestinationPath \"$env:POWERSHELL_ZIP_PATH\" -Force"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Compression failed. Please check permissions or PowerShell settings.
) else (
    echo.
    echo =====================================================================
    echo [SUCCESS] Project successfully exported to:
    echo !ZipPath!
    echo =====================================================================
)

echo.
echo Cleaning up temporary directory...
if exist "!TempDir!" rmdir /S /Q "!TempDir!"

echo.
pause
goto MENU

:IMPORT
cls
echo =====================================================================
echo                         IMPORTING PROJECT
echo =====================================================================
echo.

:: Suggest default zip name
for %%I in ("%CD%") do set "FolderName=%%~nxI"
set "DefaultZipName=..\!FolderName!-export.zip"

echo Default source zip: !DefaultZipName!
echo.
set /p "ImportZip=Enter path to the export zip file (Press Enter for default): "
if "!ImportZip!"=="" set "ImportZip=!DefaultZipName!"

if not exist "!ImportZip!" (
    echo.
    echo [ERROR] Zip file not found at: !ImportZip!
    pause
    goto MENU
)

echo.
set /p "DestDir=Enter destination directory (Press Enter for current directory '%CD%'): "
if "!DestDir!"=="" set "DestDir=%CD%"

echo.
echo Extracting archive to !DestDir!...
if not exist "!DestDir!" mkdir "!DestDir!"

:: Set environment variables for PowerShell
set "POWERSHELL_IMPORT_ZIP=!ImportZip!"
set "POWERSHELL_DEST_DIR=!DestDir!"
powershell -NoProfile -Command "Expand-Archive -Path \"$env:POWERSHELL_IMPORT_ZIP\" -DestinationPath \"$env:POWERSHELL_DEST_DIR\" -Force"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Extraction failed.
    pause
    goto MENU
)
echo Extraction successful.

:: Navigate to destination folder
cd /d "!DestDir!"

echo.
echo Detecting package manager...
set "PkgManager=npm"
if exist "yarn.lock" (
    set "PkgManager=yarn"
)
echo Found package manager: !PkgManager!

echo.
echo Installing dependencies (this might take a few minutes)...
if "!PkgManager!"=="yarn" (
    call yarn install
) else (
    call npm install
)

if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Package installation encountered errors.
)

echo.
echo Generating Prisma clients...
if exist "prisma\schema.mysql.prisma" (
    echo Rebuilding Prisma Client for MySQL...
    call npx prisma generate --schema=prisma/schema.mysql.prisma
)
if exist "prisma\schema.mssql.prisma" (
    echo Rebuilding Prisma Client for MSSQL...
    call npx prisma generate --schema=prisma/schema.mssql.prisma
)

:: Check for build script in package.json
findstr /C:"\"build\":" package.json >nul
if %errorlevel% eq 0 (
    echo.
    echo Running production build script...
    if "!PkgManager!"=="yarn" (
        call yarn build
    ) else (
        call npm run build
    )
)

echo.
echo =====================================================================
echo [SUCCESS] Import and setup completed successfully!
echo =====================================================================
echo.

set /p "RunServer=Do you want to run the project now? (Y/N): "
if /I "!RunServer!"=="Y" (
    echo.
    echo Starting the application...
    :: Check if dev script exists
    findstr /C:"\"dev\":" package.json >nul
    if %errorlevel% eq 0 (
        if "!PkgManager!"=="yarn" (
            call yarn dev
        ) else (
            call npm run dev
        )
    ) else (
        if "!PkgManager!"=="yarn" (
            call yarn start
        ) else (
            call npm start
        )
    )
)

pause
goto MENU

:EXIT
echo.
echo Thank you for using Parking Server - Project Manager.
echo Goodbye!
timeout /t 2 >nul
endlocal
exit /b
