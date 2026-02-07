#!/usr/bin/env bash
set -euo pipefail

# OpenClaudeCode Gateway Daemon Installer
# Installs launchd (macOS) or systemd (Linux) service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.openclaudecode"
DAEMON_SCRIPT="$PROJECT_DIR/packages/gateway/dist/gateway-daemon.js"
LOG_DIR="$DATA_DIR/logs"

mkdir -p "$DATA_DIR" "$LOG_DIR"

detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "macos" ;;
    Linux*)  echo "linux" ;;
    *)       echo "unknown" ;;
  esac
}

install_launchd() {
  local plist_name="com.openclaudecode.gateway"
  local plist_path="$HOME/Library/LaunchAgents/${plist_name}.plist"
  local node_path
  node_path="$(which node)"

  echo "Installing launchd service..."

  cat > "$plist_path" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plist_name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_path}</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/gateway.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/gateway.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${HOME}/.nvm/versions/node/$(node -v)/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

  # Load the service
  launchctl unload "$plist_path" 2>/dev/null || true
  launchctl load "$plist_path"

  echo "Installed: $plist_path"
  echo "Service loaded. Gateway will start automatically on login."
  echo ""
  echo "Commands:"
  echo "  Start:   launchctl start $plist_name"
  echo "  Stop:    launchctl stop $plist_name"
  echo "  Unload:  launchctl unload $plist_path"
  echo "  Logs:    tail -f $LOG_DIR/gateway.stderr.log"
}

install_systemd() {
  local service_name="openclaudecode-gateway"
  local service_path="$HOME/.config/systemd/user/${service_name}.service"
  local node_path
  node_path="$(which node)"

  mkdir -p "$HOME/.config/systemd/user"

  echo "Installing systemd user service..."

  cat > "$service_path" << EOF
[Unit]
Description=OpenClaudeCode Gateway Daemon
After=network.target

[Service]
Type=simple
ExecStart=${node_path} ${DAEMON_SCRIPT}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

  # Reload and enable
  systemctl --user daemon-reload
  systemctl --user enable "$service_name"
  systemctl --user start "$service_name"

  echo "Installed: $service_path"
  echo "Service enabled and started."
  echo ""
  echo "Commands:"
  echo "  Status:  systemctl --user status $service_name"
  echo "  Start:   systemctl --user start $service_name"
  echo "  Stop:    systemctl --user stop $service_name"
  echo "  Logs:    journalctl --user -u $service_name -f"
  echo "  Disable: systemctl --user disable $service_name"
}

uninstall_launchd() {
  local plist_name="com.openclaudecode.gateway"
  local plist_path="$HOME/Library/LaunchAgents/${plist_name}.plist"

  if [ -f "$plist_path" ]; then
    launchctl unload "$plist_path" 2>/dev/null || true
    rm -f "$plist_path"
    echo "Uninstalled launchd service."
  else
    echo "No launchd service found."
  fi
}

uninstall_systemd() {
  local service_name="openclaudecode-gateway"
  local service_path="$HOME/.config/systemd/user/${service_name}.service"

  if [ -f "$service_path" ]; then
    systemctl --user stop "$service_name" 2>/dev/null || true
    systemctl --user disable "$service_name" 2>/dev/null || true
    rm -f "$service_path"
    systemctl --user daemon-reload
    echo "Uninstalled systemd service."
  else
    echo "No systemd service found."
  fi
}

# Main
OS=$(detect_os)
ACTION="${1:-install}"

case "$ACTION" in
  install)
    echo "OpenClaudeCode Gateway Daemon Installer"
    echo "========================================"
    echo ""
    case "$OS" in
      macos)  install_launchd ;;
      linux)  install_systemd ;;
      *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
    esac
    ;;
  uninstall)
    case "$OS" in
      macos)  uninstall_launchd ;;
      linux)  uninstall_systemd ;;
      *)      echo "Unsupported OS"; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: $0 [install|uninstall]"
    exit 1
    ;;
esac
