#!/bin/bash

set -euo pipefail

################################################################################
# MacStream macOS Server Setup
#
# This script prepares a macOS machine to run MacStream server components:
# - Homebrew (if missing)
# - FFmpeg (7+)
# - Node.js (20+ via Homebrew node@20)
# - npm dependencies
# - Swift input-agent build (release)
# - TCC permission guidance (Screen Recording + Accessibility)
# - macOS firewall / packet filter rules for UDP 5004 + TCP 8765
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT_AGENT_DIR="$PROJECT_ROOT/native/input-agent"
INPUT_AGENT_BINARY="$INPUT_AGENT_DIR/.build/release/input-agent"

PORT_VIDEO_UDP=5004
PORT_WS_TCP=8765

if [[ "$(uname -s)" != "Darwin" ]]; then
	printf 'This script is for macOS (Darwin) only.\n' >&2
	exit 1
fi

if [[ -t 1 ]]; then
	COLOR_RED='\033[0;31m'
	COLOR_GREEN='\033[0;32m'
	COLOR_YELLOW='\033[1;33m'
	COLOR_BLUE='\033[0;34m'
	COLOR_RESET='\033[0m'
else
	COLOR_RED=''
	COLOR_GREEN=''
	COLOR_YELLOW=''
	COLOR_BLUE=''
	COLOR_RESET=''
fi

log_info() {
	printf '%b[INFO]%b %s\n' "$COLOR_BLUE" "$COLOR_RESET" "$1"
}

log_ok() {
	printf '%b[OK]%b %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

log_warn() {
	printf '%b[WARN]%b %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

log_error() {
	printf '%b[ERROR]%b %s\n' "$COLOR_RED" "$COLOR_RESET" "$1" >&2
}

on_error() {
	local exit_code=$?
	log_error "Setup failed at line ${BASH_LINENO[0]} (exit code ${exit_code})."
	log_error 'Review the message above and re-run the script.'
	exit "$exit_code"
}
trap on_error ERR

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

major_version_from_semver() {
	local version="$1"
	printf '%s' "$version" | sed -E 's/^v?([0-9]+).*/\1/'
}

ensure_homebrew() {
	log_info 'Checking Homebrew...'
	if command_exists brew; then
		log_ok "Homebrew already installed ($(brew --version | head -n 1))."
		return
	fi

	log_warn 'Homebrew not found. Installing Homebrew...'
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

	if [[ -x /opt/homebrew/bin/brew ]]; then
		eval "$(/opt/homebrew/bin/brew shellenv)"
	elif [[ -x /usr/local/bin/brew ]]; then
		eval "$(/usr/local/bin/brew shellenv)"
	fi

	if ! command_exists brew; then
		log_error 'Homebrew installation finished, but brew is not in PATH.'
		log_error 'Open a new shell and run this script again.'
		exit 1
	fi

	log_ok "Homebrew installed ($(brew --version | head -n 1))."
}

ensure_ffmpeg() {
	log_info 'Checking FFmpeg (7+)...'
	if command_exists ffmpeg; then
		local ffmpeg_version
		local ffmpeg_major
		ffmpeg_version="$(ffmpeg -version | awk 'NR==1 {print $3}')"
		ffmpeg_major="$(major_version_from_semver "$ffmpeg_version")"
		if [[ "$ffmpeg_major" =~ ^[0-9]+$ ]] && ((ffmpeg_major >= 7)); then
			log_ok "FFmpeg already installed (version ${ffmpeg_version})."
			return
		fi
		log_warn "FFmpeg version ${ffmpeg_version} is below 7. Upgrading..."
	else
		log_warn 'FFmpeg not found. Installing...'
	fi

	brew install ffmpeg
	log_ok 'FFmpeg installed/upgraded.'
}

ensure_node() {
	log_info 'Checking Node.js (20+)...'

	if command_exists node; then
		local node_version
		local node_major
		node_version="$(node --version)"
		node_major="$(major_version_from_semver "$node_version")"
		if [[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 20)); then
			log_ok "Node.js already installed (${node_version})."
			return
		fi
		log_warn "Node.js ${node_version} is below 20. Installing node@20..."
	else
		log_warn 'Node.js not found. Installing node@20...'
	fi

	brew install node@20

	local brew_prefix
	brew_prefix="$(brew --prefix node@20)"
	export PATH="$brew_prefix/bin:$PATH"

	if command_exists node; then
		log_ok "Node.js available after install ($(node --version))."
	else
		log_error 'node command still unavailable after installing node@20.'
		log_error "Add ${brew_prefix}/bin to PATH and re-run."
		exit 1
	fi
}

install_npm_dependencies() {
	log_info 'Checking npm dependencies...'
	if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
		log_ok 'node_modules already exists. Skipping npm install.'
		return
	fi

	log_info 'Running npm install...'
	(
		cd "$PROJECT_ROOT"
		npm install
	)
	log_ok 'npm dependencies installed.'
}

build_swift_input_agent() {
	log_info 'Checking Swift input-agent build...'
	if [[ -f "$INPUT_AGENT_BINARY" ]]; then
		log_ok "Swift input-agent already built (${INPUT_AGENT_BINARY}). Skipping."
		return
	fi

	log_info 'Building Swift input-agent (release)...'
	(
		cd "$INPUT_AGENT_DIR"
		swift build -c release
	)
	log_ok 'Swift input-agent build complete.'
}

configure_tcc_permissions() {
	log_info 'TCC permissions (Screen Recording + Accessibility)...'
	log_warn 'macOS requires GUI confirmation for these permissions; auto-grant is not supported.'

	if command_exists open; then
		open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' || true
		open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' || true
	fi

	cat <<'EOF'
Please grant permissions to your terminal and/or MacStream binaries:
  1) System Settings → Privacy & Security → Screen Recording
  2) System Settings → Privacy & Security → Accessibility
After granting, restart Terminal (or re-login) if macOS requires it.
EOF

	log_ok 'TCC guidance shown.'
}

configure_firewall_ports() {
	log_info "Configuring packet filter rules for UDP ${PORT_VIDEO_UDP} and TCP ${PORT_WS_TCP}..."

	if ! command_exists pfctl; then
		log_warn 'pfctl not available. Skipping firewall configuration.'
		return
	fi

	if [[ "$EUID" -ne 0 ]]; then
		log_warn 'Firewall changes require root privileges; skipping automatic configuration.'
		cat <<EOF
Run the following command as root to apply firewall rules later:
  sudo "$SCRIPT_DIR/setup-server.sh" --firewall-only
EOF
		return
	fi

	local anchor_file='/etc/pf.anchors/com.macstream'
	local include_line='anchor "com.macstream"'
	local load_line='load anchor "com.macstream" from "/etc/pf.anchors/com.macstream"'

	cat >"$anchor_file" <<EOF
# Managed by MacStream setup-server.sh
pass in proto udp from any to any port ${PORT_VIDEO_UDP} keep state
pass in proto tcp from any to any port ${PORT_WS_TCP} keep state
EOF

	if ! grep -Fq "$include_line" /etc/pf.conf; then
		printf '\n%s\n%s\n' "$include_line" "$load_line" >>/etc/pf.conf
		log_info 'Added com.macstream anchor include to /etc/pf.conf.'
	fi

	pfctl -f /etc/pf.conf >/dev/null
	pfctl -e >/dev/null 2>&1 || true

	log_ok "Firewall/pf rules configured for UDP ${PORT_VIDEO_UDP} and TCP ${PORT_WS_TCP}."
}

print_success() {
	cat <<EOF

${COLOR_GREEN}MacStream server setup completed.${COLOR_RESET}

Next steps:
  1) Confirm TCC permissions (Screen Recording + Accessibility) are enabled.
  2) Build server artifacts if needed:
       npm run build:server
  3) Start the server:
       node dist/server/index.js --client-ip <tailscale-ip>

If firewall was skipped due to privileges, re-run with root and --firewall-only.
EOF
}

main() {
	if [[ "${1:-}" == '--firewall-only' ]]; then
		configure_firewall_ports
		log_ok 'Firewall-only mode finished.'
		exit 0
	fi

	ensure_homebrew
	ensure_ffmpeg
	ensure_node
	install_npm_dependencies
	build_swift_input_agent
	configure_tcc_permissions
	configure_firewall_ports
	print_success
}

main "$@"
