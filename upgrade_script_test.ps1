# Crosstek - silent Windows 11 25H2 upgrade. Runs unattended as SYSTEM.

$RebootMode      = 'Nightly'   # Immediate | Nightly | None
$RebootHour      = 3
$RebootGraceMins = 10
$MinFreeGB_eKB   = 4
$MinFreeGB_Full  = 30

$eKB_x64   = 'https://catalog.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/fa84cc49-18b2-4c26-b389-90c96e6ae0d2/public/windows11.0-kb5054156-x64_a0c1638cbcf4cf33dbe9a5bef69db374b4786974.msu'
$eKB_arm64 = ''

$WorkDir  = 'C:\ITSupport'
$LogFile  = Join-Path $WorkDir 'Win11-25H2-Upgrade.log'
$TaskName = 'Crosstek-Win11-25H2-Upgrade'

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path $WorkDir)) { New-Item $WorkDir -ItemType Directory -Force | Out-Null }

$SyncroLoaded = $false
if ($env:SyncroModule -and (Test-Path $env:SyncroModule)) {
    try { Import-Module $env:SyncroModule -WarningAction SilentlyContinue; $SyncroLoaded = $true } catch { }
}

function Write-Log {
    param([string]$Message, [ValidateSet('INFO','WARN','ERROR')]$Level = 'INFO')
    $line = "{0}  [{1}]  {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content $LogFile $line -Encoding UTF8
    Write-Output $line
}

function Write-Syncro {
    param([string]$Message, [string]$EventName = 'Win11 25H2 Upgrade')
    if ($SyncroLoaded) { try { Log-Activity -Message $Message -EventName $EventName } catch { } }
}

function Stop-Script {
    param([string]$Message, [int]$Code = 0, [switch]$Alert)
    Write-Log $Message
    Write-Syncro $Message
    if ($Alert -and $SyncroLoaded) { try { Rmm-Alert -Category 'Win11_25H2_Upgrade' -Body $Message } catch { } }
    exit $Code
}

function Test-PendingReboot {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Services\Pending'
    )
    foreach ($k in $keys) { if (Test-Path $k) { return $true } }
    return $false
}

function Test-UserLoggedOn {
    try { $out = & "$env:SystemRoot\System32\quser.exe" 2>$null; return [bool]($out -and $out.Count -gt 1) }
    catch { try { return [bool](Get-CimInstance Win32_ComputerSystem).UserName } catch { return $false } }
}

function Invoke-Reboot {
    param([string]$Reason)
    switch ($RebootMode) {
        'None' { Write-Log "Staged. RebootMode=None, reboot left to patch policy."; return }
        'Immediate' {
            Write-Log "Rebooting ($Reason)."
            & shutdown.exe /r /t ($RebootGraceMins * 60) /f /c "IT maintenance: this PC will restart to finish a Windows update. Please save your work."
            return
        }
        'Nightly' {
            if (-not (Test-UserLoggedOn)) {
                Write-Log "No session. Rebooting ($Reason)."
                & shutdown.exe /r /t 60 /f
                return
            }
            $when = Get-Date -Hour $RebootHour -Minute 0 -Second 0
            if ($when -le (Get-Date)) { $when = $when.AddDays(1) }
            $a = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\shutdown.exe" `
                 -Argument "/r /t 300 /f /c ""IT maintenance: restarting to finish a Windows update."""
            $p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest
            $t = New-ScheduledTaskTrigger -Once -At $when
            $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            Register-ScheduledTask "$TaskName-Reboot" -Action $a -Principal $p -Trigger $t -Settings $s -Force | Out-Null
            Write-Log "User logged on. Reboot scheduled $($when.ToString('yyyy-MM-dd HH:mm'))."
        }
    }
}

function Get-FreeSpaceGB { [math]::Round((Get-PSDrive C).Free / 1GB, 1) }

function Get-FileWithRetry {
    param([string]$Url, [string]$Destination, [int]$Retries = 3)
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 1800
            if ((Get-Item $Destination).Length -gt 0) { return $true }
        } catch {
            Write-Log "Download attempt $i failed: $($_.Exception.Message)" 'WARN'
            Start-Sleep -Seconds (15 * $i)
        }
    }
    return $false
}

Write-Log "=== 25H2 check on $env:COMPUTERNAME as $([Security.Principal.WindowsIdentity]::GetCurrent().Name) ==="

$cv       = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
[int]$bld = $cv.CurrentBuildNumber
[int]$ubr = $cv.UBR
$disp     = $cv.DisplayVersion
$arch     = $env:PROCESSOR_ARCHITECTURE

Write-Log "$($cv.ProductName) / $disp / $bld.$ubr / $arch"

if ($bld -ge 26200) { Stop-Script "Already on $disp ($bld.$ubr). Nothing to do." }
if ((Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { Stop-Script "Not a client OS. Skipping." }
if ($bld -lt 22000) { Stop-Script "Windows 10 (build $bld). Use the Win10-to-Win11 workflow instead." }

if (Test-PendingReboot) {
    Write-Log "Reboot already pending - servicing will fail until it completes." 'WARN'
    Invoke-Reboot -Reason 'pre-existing pending reboot'
    Stop-Script "Reboot pending. Upgrade resumes next run."
}

$wuPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
if (-not (Test-Path $wuPolicy)) { New-Item $wuPolicy -Force | Out-Null }
Set-ItemProperty $wuPolicy 'ProductVersion'           'Windows 11' -Type String -Force
Set-ItemProperty $wuPolicy 'TargetReleaseVersion'     1            -Type DWord  -Force
Set-ItemProperty $wuPolicy 'TargetReleaseVersionInfo' '25H2'       -Type String -Force
foreach ($n in 'DeferFeatureUpdates','DeferFeatureUpdatesPeriodInDays','PauseFeatureUpdatesStartTime') {
    Remove-ItemProperty $wuPolicy $n -ErrorAction SilentlyContinue
}
Write-Log "WUfB pinned to Windows 11 25H2."

# ---- 24H2: enablement package ----
if ($bld -eq 26100) {

    if ((Get-FreeSpaceGB) -lt $MinFreeGB_eKB) {
        Stop-Script "Only $(Get-FreeSpaceGB) GB free on C:, need $MinFreeGB_eKB GB." 1 -Alert
    }

    # eKB requires 26100.5074 (KB5064081) or later
    if ($ubr -lt 5074) {
        Write-Log "UBR $ubr below 5074 prerequisite. Installing pending CUs first." 'WARN'
        try {
            $sess = New-Object -ComObject Microsoft.Update.Session
            $res  = $sess.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
            $cu   = New-Object -ComObject Microsoft.Update.UpdateColl
            foreach ($u in $res.Updates) {
                if ($u.Title -match 'Cumulative Update for Windows 11') {
                    if (-not $u.EulaAccepted) { $u.AcceptEula() }
                    $cu.Add($u) | Out-Null
                    Write-Log "Queued: $($u.Title)"
                }
            }
            if ($cu.Count -eq 0) {
                Stop-Script "No CU offered and UBR $ubr is below prerequisite. Check WSUS/WU connectivity." 1 -Alert
            }
            $dl = $sess.CreateUpdateDownloader(); $dl.Updates = $cu; $dl.Download() | Out-Null
            $in = $sess.CreateUpdateInstaller();  $in.Updates = $cu
            $ir = $in.Install()
            Write-Log "CU result $($ir.ResultCode), reboot required: $($ir.RebootRequired)"
            Invoke-Reboot -Reason 'prerequisite CU'
            Stop-Script "Prerequisite CU installed. 25H2 applies next run."
        } catch {
            Stop-Script "Prerequisite install failed: $($_.Exception.Message)" 1 -Alert
        }
    }

    $wuHandled = $false
    try {
        $sess = New-Object -ComObject Microsoft.Update.Session
        $res  = $sess.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
        $fu   = New-Object -ComObject Microsoft.Update.UpdateColl
        foreach ($u in $res.Updates) {
            if ($u.Title -match '25H2') {
                if (-not $u.EulaAccepted) { $u.AcceptEula() }
                $fu.Add($u) | Out-Null
                Write-Log "Found: $($u.Title)"
            }
        }
        if ($fu.Count -gt 0) {
            $dl = $sess.CreateUpdateDownloader(); $dl.Updates = $fu; $dl.Download() | Out-Null
            $in = $sess.CreateUpdateInstaller();  $in.Updates = $fu
            $ir = $in.Install()
            Write-Log "Install result $($ir.ResultCode) (2=ok), HResult $($ir.HResult)"
            if ($ir.ResultCode -in 2,3) { $wuHandled = $true }
        } else {
            Write-Log "WU not offering 25H2 (safeguard hold, WSUS scope, or already staged)." 'WARN'
        }
    } catch {
        Write-Log "WU path failed: $($_.Exception.Message)" 'WARN'
    }

    if (-not $wuHandled) {
        $url = if ($arch -eq 'ARM64') { $eKB_arm64 } else { $eKB_x64 }
        if ([string]::IsNullOrWhiteSpace($url)) {
            Stop-Script "WU did not offer 25H2 and no eKB URL configured for $arch." 1 -Alert
        }
        $msu = Join-Path $WorkDir "windows11.0-kb5054156-$arch.msu"
        if (-not (Get-FileWithRetry $url $msu)) {
            Stop-Script "Could not download the eKB. Check internet access and mirror URL." 1 -Alert
        }
        Write-Log "eKB downloaded: $([math]::Round((Get-Item $msu).Length/1KB,0)) KB"

        $dismArgs = "/Online /Add-Package /PackagePath:`"$msu`" /Quiet /NoRestart /LogPath:`"$WorkDir\dism-25h2.log`""
        $rc = (Start-Process "$env:SystemRoot\System32\dism.exe" -ArgumentList $dismArgs -Wait -PassThru -WindowStyle Hidden).ExitCode
        Write-Log "DISM exit $rc"

        if ($rc -eq -2146498530) { Stop-Script "eKB not applicable - device needs a newer CU first." 1 -Alert }
        if ($rc -notin 0,3010)   { Stop-Script "DISM failed ($rc). See $WorkDir\dism-25h2.log" 1 -Alert }
    }

    Invoke-Reboot -Reason '25H2 enablement package staged'
    Stop-Script "25H2 staged. Build reports 26200.x after reboot."
}

# ---- Pre-24H2: full feature update ----
Write-Log "Build $bld needs a full feature update."

if ((Get-FreeSpaceGB) -lt $MinFreeGB_Full) {
    Stop-Script "Only $(Get-FreeSpaceGB) GB free on C:, need $MinFreeGB_Full GB." 1 -Alert
}

if (Get-Process 'Windows10UpgraderApp','Windows11InstallationAssistant','SetupHost','WindowsUpdateBox' -ErrorAction SilentlyContinue) {
    Stop-Script "An upgrade is already running. Leaving it alone."
}

$assistant = Join-Path $WorkDir 'Windows11InstallationAssistant.exe'
if (-not (Get-FileWithRetry 'https://go.microsoft.com/fwlink/?linkid=2171764' $assistant)) {
    Stop-Script "Could not download the Installation Assistant." 1 -Alert
}
Write-Log "Assistant downloaded ($([math]::Round((Get-Item $assistant).Length/1MB,1)) MB)."

# Must run as a task, not Start-Process: the RMM agent kills the child tree on script exit.
$a = New-ScheduledTaskAction -Execute $assistant -WorkingDirectory $WorkDir `
     -Argument "/QuietInstall /SkipEULA /NoRestartUI /CopyLogs ""$WorkDir"""
$p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
     -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
Register-ScheduledTask $TaskName -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask $TaskName
Write-Log "Assistant launched as detached SYSTEM task."

Start-Sleep -Seconds 90
$running = Get-Process 'Windows10UpgraderApp','Windows11InstallationAssistant' -ErrorAction SilentlyContinue
if (-not $running) {
    Stop-Script "Assistant exited immediately - likely a hardware block (TPM 2.0 / Secure Boot / CPU). See $WorkDir\setuperr.log" 1 -Alert
}

Write-Log "Upgrade running (PID $($running[0].Id)). Typically 30-90 min then a reboot."
Write-Syncro "Windows 11 25H2 feature update started." 'Upgrade Started'

if ($RebootMode -ne 'None' -and -not (Test-UserLoggedOn)) {
    $rebootAt = (Get-Date).AddHours(3)
    $ra = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\shutdown.exe" -Argument "/r /t 60 /f"
    $rp = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest
    $rt = New-ScheduledTaskTrigger -Once -At $rebootAt
    Register-ScheduledTask "$TaskName-Reboot" -Action $ra -Principal $rp -Trigger $rt `
        -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) -Force | Out-Null
    Write-Log "Backstop reboot scheduled $($rebootAt.ToString('HH:mm'))."
}

exit 0