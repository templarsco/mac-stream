#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

################################################################################
# MacStream Windows Client Setup
#
# This script prepares a Windows machine to run MacStream client components:
# - Node.js 20+
# - npm dependencies
# - Client build artifacts
# - Windows Firewall rules for UDP 5004 + TCP 8765
################################################################################

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

$UdpPort = 5004
$TcpPort = 8765

$UdpRuleName = 'MacStream Video UDP 5004 (Inbound)'
$TcpRuleName = 'MacStream Control TCP 8765 (Inbound)'

function Write-Info {
	param([string]$Message)
	Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Ok {
	param([string]$Message)
	Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
	param([string]$Message)
	Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Err {
	param([string]$Message)
	Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Require-Node20OrHigher {
	Write-Info 'Checking Node.js (20+)...'

	$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
	if (-not $nodeCommand) {
		throw 'Node.js is not installed. Install Node.js 20+ and re-run.'
	}

	$nodeVersionRaw = (node --version).Trim()
	if (-not $nodeVersionRaw.StartsWith('v')) {
		throw "Unexpected Node.js version output: $nodeVersionRaw"
	}

	$versionNumber = $nodeVersionRaw.Substring(1)
	$version = [System.Version]$versionNumber
	if ($version.Major -lt 20) {
		throw "Node.js $nodeVersionRaw detected. Node.js 20+ is required."
	}

	Write-Ok "Node.js $nodeVersionRaw is installed."
}

function Install-NpmDependencies {
	Write-Info 'Checking npm dependencies...'
	$nodeModulesPath = Join-Path $ProjectRoot 'node_modules'

	if (Test-Path $nodeModulesPath) {
		Write-Ok 'node_modules already exists. Skipping npm install.'
		return
	}

	Write-Info 'Running npm install...'
	Push-Location $ProjectRoot
	try {
		npm install
	}
	finally {
		Pop-Location
	}

	Write-Ok 'npm dependencies installed.'
}

function Build-Client {
	Write-Info 'Building MacStream client...'
	Push-Location $ProjectRoot
	try {
		npm run build:client
	}
	finally {
		Pop-Location
	}
	Write-Ok 'Client build completed.'
}

function Ensure-FirewallRule {
	param(
		[string]$RuleName,
		[string]$Protocol,
		[int]$Port
	)

	$existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
	if ($existingRule) {
		Write-Ok "Firewall rule already exists: $RuleName"
		return
	}

	Write-Info "Adding firewall rule: $RuleName"
	New-NetFirewallRule `
		-DisplayName $RuleName `
		-Direction Inbound `
		-Action Allow `
		-Protocol $Protocol `
		-LocalPort $Port | Out-Null

	Write-Ok "Firewall rule added: $RuleName"
}

function Configure-Firewall {
	Write-Info "Configuring Windows Firewall for UDP $UdpPort and TCP $TcpPort..."

	$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
	if (-not $isAdmin) {
		Write-Warn 'Not running as Administrator. Skipping firewall rule creation.'
		Write-Warn 'Re-run this script in an elevated PowerShell to configure firewall rules.'
		return
	}

	Ensure-FirewallRule -RuleName $UdpRuleName -Protocol 'UDP' -Port $UdpPort
	Ensure-FirewallRule -RuleName $TcpRuleName -Protocol 'TCP' -Port $TcpPort
}

function Print-Success {
	Write-Host ''
	Write-Host 'MacStream client setup completed.' -ForegroundColor Green
	Write-Host ''
	Write-Host 'Next steps:'
	Write-Host '  1) Start the client app:'
	Write-Host '       npm run start:client'
	Write-Host '  2) Connect using your macOS server Tailscale IP and default ports.'
}

try {
	Require-Node20OrHigher
	Install-NpmDependencies
	Build-Client
	Configure-Firewall
	Print-Success
}
catch {
	Write-Err $_.Exception.Message
	exit 1
}
