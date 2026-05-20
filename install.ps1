# QianWen CLI Installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/QianWen-AI/qianwen-cli/main/install.ps1 | iex
#   .\install.ps1 -Version v1.2.0
#
# Parameters:
#   -Version           - version to install (e.g. v1.0.0, default: v1.0.1)
#
# Behavior:
#   - If a previous installation exists in the install directory, the existing
#     binary will be backed up with a '-old' suffix (e.g. qianwen.exe → qianwen-old.exe)
#     before being overwritten.
#   - Under Constrained Language Mode (CLM, typically enforced by AppLocker / WDAC),
#     the script transparently switches to a curl.exe-based transport and
#     registry/setx-based PATH management. curl.exe is bundled with Windows 10
#     1803+ and Windows 11.

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

# ─── Constrained Language Mode (CLM) Detection ──────────────────────────────
# CLM (enforced by AppLocker / WDAC) blocks the .NET method calls used by the
# rich install path (HttpWebRequest, Environment, IO.Path, IO.File, Add-Type
# for VT processing, etc.). When detected, we set a flag and the relevant
# branches downgrade to curl.exe + registry/setx + ASCII output.
$script:IsCLM = ($ExecutionContext.SessionState.LanguageMode -eq 'ConstrainedLanguage')

# ─── Default Version ────────────────────────────────────────────────────────
# Update this value when releasing a new version.
$DefaultVersion = "v1.0.1"

# ─── Brand Colors ────────────────────────────────────────────────────────────
# #3047F5 via ANSI 24-bit true color escape sequences (matching install.sh)
$ESC = [char]27

$BOLD = "${ESC}[1m"
$RESET = "${ESC}[0m"
$BRAND = "${ESC}[38;2;48;71;245m"
$BRAND_BOLD = "${ESC}[1;38;2;48;71;245m"
$GREEN = "${ESC}[32m"
$RED = "${ESC}[31m"
$DIM = "${ESC}[2m"
$YELLOW = "${ESC}[33m"

# Enable VT processing on Windows (for ANSI escape support)
function Enable-VTProcessing {
    if ($script:IsCLM) { return }  # Add-Type / [Console] disallowed under CLM
    if ($PSVersionTable.PSVersion.Major -ge 7) { return }
    try {
        $null = [Console]::OutputEncoding
        # Windows 10 1511+ supports VT sequences in conhost
        $key = "HKCU:\Console"
        if (Test-Path $key) {
            $vt = (Get-ItemProperty $key -ErrorAction SilentlyContinue).VirtualTerminalLevel
            if (-not $vt) {
                # Try to enable via .NET
                Add-Type -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int mode);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int handle);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int mode);
"@ -Namespace Win32 -Name Console -ErrorAction SilentlyContinue
                $handle = [Win32.Console]::GetStdHandle(-11)  # STD_OUTPUT_HANDLE
                $mode = 0
                [Win32.Console]::GetConsoleMode($handle, [ref]$mode) | Out-Null
                # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
                [Win32.Console]::SetConsoleMode($handle, $mode -bor 0x0004) | Out-Null
            }
        }
    } catch {
        # Silently fail - colors will degrade gracefully
    }
}

Enable-VTProcessing

function Write-Branded {
    param([string]$Text, [switch]$NoNewline)
    if ($NoNewline) {
        Write-Host "${BRAND_BOLD}${Text}${RESET}" -NoNewline
    } else {
        Write-Host "${BRAND_BOLD}${Text}${RESET}"
    }
}

function Write-Info {
    param([string]$Message)
    Write-Host "${BRAND_BOLD}qianwen${RESET} ${DIM}»${RESET} ${Message}"
}

function Write-Success {
    param([string]$Message)
    Write-Host "${GREEN}✔${RESET} ${Message}"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "${YELLOW}⚠${RESET} ${Message}"
}

function Write-Error2 {
    param([string]$Message)
    Write-Host "${RED}✘${RESET} ${Message}"
}

function Write-Fatal {
    param([string]$Message)
    Write-Error2 $Message
    exit 1
}

# ─── Platform Detection ─────────────────────────────────────────────────────

function Get-CpuArch {
    $arch = $null

    # Try RuntimeInformation first (.NET Core / PS 6+)
    try {
        $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        switch ($osArch) {
            "X64"  { $arch = "x64" }
            "Arm64" { $arch = "arm64" }
        }
    } catch {
        # Fallback to environment variable
    }

    if (-not $arch) {
        switch ($env:PROCESSOR_ARCHITECTURE) {
            "AMD64" { $arch = "x64" }
            "ARM64" { $arch = "arm64" }
            "x86"   {
                # Check if running 32-bit PS on 64-bit Windows
                if ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64") {
                    $arch = "x64"
                } else {
                    Write-Fatal "32-bit Windows is not supported."
                }
            }
            default {
                Write-Fatal "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
            }
        }
    }

    return $arch
}

# ─── PATH Management ────────────────────────────────────────────────────────

function Test-InPath {
    param([string]$Dir)
    $paths = $env:PATH -split ";"
    foreach ($p in $paths) {
        if ($p.TrimEnd("\") -eq $Dir.TrimEnd("\")) {
            return $true
        }
    }
    return $false
}

function Add-ToUserPath {
    param([string]$Dir)

    if ($script:IsCLM) {
        # CLM: read User PATH from registry, persist via setx (1024-char limit).
        try {
            $prop = Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue
            $currentPath = if ($prop -and $prop.Path) { $prop.Path } else { '' }
            if ($currentPath) {
                foreach ($p in ($currentPath -split ';')) {
                    if ($p.TrimEnd('\') -eq $Dir.TrimEnd('\')) {
                        $env:PATH = "$Dir;$env:PATH"
                        return $true
                    }
                }
                $newPath = "$Dir;$currentPath"
            } else {
                $newPath = $Dir
            }
            if ($newPath.Length -ge 1024) {
                # setx truncates at 1024 chars; refuse to damage existing PATH.
                $env:PATH = "$Dir;$env:PATH"
                return $false
            }
            & setx PATH "$newPath" | Out-Null
            $env:PATH = "$Dir;$env:PATH"
            return $true
        } catch {
            return $false
        }
    }

    try {
        $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ($currentPath) {
            $paths = $currentPath -split ";"
            foreach ($p in $paths) {
                if ($p.TrimEnd("\") -eq $Dir.TrimEnd("\")) {
                    return $true  # Already in user PATH
                }
            }
            $newPath = "$Dir;$currentPath"
        } else {
            $newPath = $Dir
        }

        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        # Also update current session
        $env:PATH = "$Dir;$env:PATH"
        return $true
    } catch {
        return $false
    }
}

# ─── Download (CLM-safe via curl.exe) ───────────────────────────────────────
# Used only when running under Constrained Language Mode. curl.exe ships with
# Windows 10 1803+ / Windows 11 and uses schannel TLS independent of .NET, so
# it sidesteps both the CLM ban on [Net.ServicePointManager] and the PS 5.1
# default TLS 1.0 issue when talking to GitHub.
function Invoke-CurlDownload {
    param(
        [string]$Url,
        [string]$Out
    )
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        Write-Error2 "curl.exe not found. Required on Windows 10 1803+ / Windows 11."
        return $false
    }
    try {
        & curl.exe --tlsv1.2 -fsSL --retry 2 --connect-timeout 15 -o $Out $Url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $Out) -and (Get-Item $Out).Length -gt 0) {
            return $true
        }
        Write-Error2 "curl.exe failed with exit code $LASTEXITCODE"
    } catch {
        Write-Error2 "curl.exe error: $_"
    }
    if (Test-Path $Out) { Remove-Item $Out -Force -ErrorAction SilentlyContinue }
    return $false
}

# ─── Main Installation ──────────────────────────────────────────────────────

function Install-QianWenCLI {
    Write-Host ""
    Write-Host "  ${BRAND_BOLD}╔═══════════════════════════════════════╗${RESET}"
    Write-Host "  ${BRAND_BOLD}║          QianWen CLI Installer        ║${RESET}"
    Write-Host "  ${BRAND_BOLD}╚═══════════════════════════════════════╝${RESET}"
    Write-Host ""

    # Detect platform
    $arch = Get-CpuArch
    Write-Info "Detected platform: ${BOLD}windows-${arch}${RESET}"

    # Resolve version: CLI param > default
    if ($Version) {
        $ver = $Version
    } else {
        $ver = $DefaultVersion
    }

    # Normalize version: ensure it starts with 'v'
    if (-not $ver.StartsWith("v")) {
        $ver = "v$ver"
    }
    Write-Info "Version: ${BOLD}${ver}${RESET}"

    # Set install directory
    $installDir = Join-Path $env:USERPROFILE ".qianwen\bin"
    Write-Info "Install directory: ${BOLD}${installDir}${RESET}"

    # Construct download URL
    $filename = "qianwen-windows-$arch.zip"
    $downloadUrl = "https://github.com/QianWen-AI/qianwen-cli/releases/download/$ver/$filename"
    Write-Info "Downloading ${BRAND}${filename}${RESET}..."

    # Create temp directory (CLM-safe path avoids [System.IO.Path] / [System.Guid])
    if ($script:IsCLM) {
        $rand   = -join (1..8 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
        $tmpDir = Join-Path $env:TEMP "qianwen-install-$rand"
    } else {
        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qianwen-install-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
    }
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $tmpZip = Join-Path $tmpDir $filename

    try {
        if ($script:IsCLM) {
            # CLM transport: curl.exe only (no progress bar, no ANSI).
            if (-not (Invoke-CurlDownload -Url $downloadUrl -Out $tmpZip)) {
                Write-Fatal "Download via curl.exe failed.`n  URL: $downloadUrl`n  Hints: check proxy / network connectivity, ensure curl.exe is available (Windows 10 1803+)."
            }
        } else {
            # Download with progress bar
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

                $webRequest = [System.Net.HttpWebRequest]::Create($downloadUrl)
                $webRequest.AllowAutoRedirect = $true
                $webRequest.UserAgent = "QianWen-Installer"
                $response = $webRequest.GetResponse()
                $totalBytes = $response.ContentLength
                $responseStream = $response.GetResponseStream()
                $fileStream = [System.IO.File]::Create($tmpZip)
                $buffer = New-Object byte[] 8192
                $bytesRead = 0
                $totalRead = 0
                $barWidth = 30

                while (($bytesRead = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $fileStream.Write($buffer, 0, $bytesRead)
                    $totalRead += $bytesRead

                    if ($totalBytes -gt 0) {
                        $pct = [math]::Floor(($totalRead / $totalBytes) * 100)
                        $filled = [math]::Floor(($totalRead / $totalBytes) * $barWidth)
                        $empty = $barWidth - $filled
                        $bar = ("█" * $filled) + ("░" * $empty)
                        $sizeMB = "{0:N1}" -f ($totalRead / 1MB)
                        $totalMB = "{0:N1}" -f ($totalBytes / 1MB)
                        Write-Host -NoNewline "`r  $bar ${pct}%  ${sizeMB}/${totalMB} MB"
                    }
                }

                $fileStream.Close()
                $responseStream.Close()
                $response.Close()
                Write-Host ""
            } catch {
                Write-Fatal "Download failed. Please check your network connection and verify the version exists.`n  URL: $downloadUrl`n  Error: $_"
            }
        }

        # Verify download
        if (-not (Test-Path $tmpZip) -or (Get-Item $tmpZip).Length -eq 0) {
            Write-Fatal "Downloaded file is empty or missing. The version $ver may not exist for windows-$arch."
        }
        Write-Success "Download complete"

        # Create install directory
        if (-not (Test-Path $installDir)) {
            New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        }

        # Backup existing binary before overwriting
        $existingExe = Join-Path $installDir "qianwen.exe"
        if (Test-Path $existingExe) {
            $backupExe = Join-Path $installDir "qianwen-old.exe"
            Copy-Item -Path $existingExe -Destination $backupExe -Force
            Write-Info "Backed up existing binary → ${DIM}qianwen-old.exe${RESET}"
        }

        # Extract
        Write-Info "Extracting to ${BOLD}${installDir}${RESET}..."
        try {
            Expand-Archive -Path $tmpZip -DestinationPath $installDir -Force
        } catch {
            Write-Fatal "Failed to extract archive. The file may be corrupted.`n  Error: $_"
        }
        Write-Success "Extraction complete"

    } finally {
        # Cleanup temp directory
        if (Test-Path $tmpDir) {
            Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Verify installation
    $exePath = Join-Path $installDir "qianwen.exe"
    Write-Host ""
    if (Test-Path $exePath) {
        Write-Success "${BRAND_BOLD}QianWen CLI${RESET} ${ver} installed successfully!"
    } else {
        Write-Success "Installation complete (${ver})"
    }

    # Check and configure PATH
    if (Test-InPath $installDir) {
        Write-Success "${BOLD}${installDir}${RESET} is already in your PATH"
        Write-Host ""
        Write-Host "  Run ${BRAND_BOLD}qianwen${RESET} to get started."
    } else {
        $added = Add-ToUserPath $installDir
        if ($added) {
            Write-Success "Added ${BOLD}${installDir}${RESET} to your user PATH"
            Write-Host ""
            Write-Warn "Please restart your terminal for the PATH change to take effect."
            Write-Host ""
            Write-Host "  Or run this in your current session:"
            Write-Host ""
            Write-Host "    ${BOLD}`$env:PATH = `"${installDir};`$env:PATH`"${RESET}"
        } else {
            Write-Warn "Could not automatically add ${BOLD}${installDir}${RESET} to your PATH."
            Write-Host ""
            Write-Host "  To add it manually:"
            Write-Host ""
            Write-Host "  1. Open ${BOLD}Settings > System > About > Advanced system settings${RESET}"
            Write-Host "  2. Click ${BOLD}Environment Variables${RESET}"
            Write-Host "  3. Under ${BOLD}User variables${RESET}, edit ${BOLD}Path${RESET}"
            Write-Host "  4. Add: ${BOLD}${installDir}${RESET}"
            Write-Host ""
            Write-Host "  Or run in PowerShell (as current user):"
            Write-Host ""
            Write-Host "    ${DIM}[Environment]::SetEnvironmentVariable('PATH', `"${installDir};`" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')${RESET}"
        }
    }

    Write-Host ""
    Write-Host "  ${DIM}Documentation: https://www.qianwenai.com${RESET}"
    Write-Host "  ${DIM}GitHub:        https://github.com/QianWen-AI/qianwen-cli${RESET}"
    Write-Host ""
}

# Run installer
Install-QianWenCLI
