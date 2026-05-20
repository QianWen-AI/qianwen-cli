#!/bin/sh
# QianWen CLI Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/QianWen-AI/qianwen-cli/main/install.sh | sh
#   sh install.sh --version v1.2.0
#
# Arguments:
#   --version, -v      - version to install (e.g. v1.0.0, default: v1.0.1)
#   --help, -h         - show help message
#
# Behavior:
#   If a previous installation exists in the install directory, the existing
#   binary will be backed up with a '-old' suffix (e.g. qianwen → qianwen-old)
#   before being overwritten. This allows easy rollback if needed.

set -e

# ─── Default Version ────────────────────────────────────────────────────────
# Update this value when releasing a new version.
VERSION="v1.0.1"

# ─── Brand Colors ────────────────────────────────────────────────────────────
# Generate real ESC character for POSIX sh compatibility
ESC=$(printf '\033')

BOLD="${ESC}[1m"
RESET="${ESC}[0m"
BRAND="${ESC}[38;2;48;71;245m"          # #3047F5 via 24-bit true color
BRAND_BOLD="${ESC}[1;38;2;48;71;245m"
GREEN="${ESC}[32m"
RED="${ESC}[31m"
DIM="${ESC}[2m"
YELLOW="${ESC}[33m"

# ─── Helper Functions ────────────────────────────────────────────────────────

# Use %b to interpret escape sequences in arguments
info() {
  printf '%b' "${BRAND_BOLD}qianwen${RESET} ${DIM}»${RESET} "
  printf '%b\n' "$1"
}

success() {
  printf '%b' "${GREEN}✔${RESET} "
  printf '%b\n' "$1"
}

warn() {
  printf '%b' "${YELLOW}⚠${RESET} "
  printf '%b\n' "$1"
}

error() {
  printf '%b' "${RED}✘${RESET} " >&2
  printf '%b\n' "$1" >&2
}

fatal() {
  error "$1"
  exit 1
}

# ─── Platform Detection ─────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "darwin" ;;
    Linux*)   echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      fatal "This script does not support Windows. Please use install.ps1 instead."
      ;;
    *)
      fatal "Unsupported operating system: $(uname -s)"
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "x64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *)
      fatal "Unsupported architecture: $(uname -m)"
      ;;
  esac
}

# ─── Download Utility ───────────────────────────────────────────────────────

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

download() {
  url="$1"
  dest="$2"

  if has_cmd curl; then
    # -fL: fail on error + follow redirects
    # --progress-bar: show a simple progress bar instead of full stats
    curl -fL --progress-bar -o "$dest" "$url" 2>&1
  elif has_cmd wget; then
    wget --show-progress --progress=bar:force -O "$dest" "$url" 2>&1
  else
    fatal "Neither 'curl' nor 'wget' found. Please install one of them and try again."
  fi
}

# ─── Argument Parsing ────────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version|-v)
        if [ -n "${2:-}" ]; then
          VERSION="$2"
          shift 2
        else
          fatal "--version requires a value (e.g. --version v1.0.0)"
        fi
        ;;
      --help|-h)
        printf "Usage: install.sh [OPTIONS]\n\n"
        printf "Options:\n"
        printf "  --version, -v <version>  Version to install (default: %s)\n" "$VERSION"
        printf "  --help, -h               Show this help message\n"
        exit 0
        ;;
      *)
        fatal "Unknown argument: $1. Use --help for usage."
        ;;
    esac
  done
}

# ─── PATH Detection ─────────────────────────────────────────────────────────

detect_shell_config() {
  shell_name=$(basename "${SHELL:-/bin/sh}")

  case "$shell_name" in
    bash)
      # Prefer .bashrc for Linux, .bash_profile for macOS
      if [ "$(uname -s)" = "Darwin" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    zsh)
      echo "$HOME/.zshrc"
      ;;
    fish)
      echo "$HOME/.config/fish/config.fish"
      ;;
    *)
      echo "$HOME/.profile"
      ;;
  esac
}

print_path_instructions() {
  install_dir="$1"
  shell_name=$(basename "${SHELL:-/bin/sh}")
  config_file=$(detect_shell_config)

  echo ""
  warn "The install directory ${BRAND}${install_dir}${RESET} is not in your ${BOLD}PATH${RESET}."
  echo ""
  printf '%b\n\n' "  Add it by running:"

  case "$shell_name" in
    fish)
      printf '%b\n' "    ${BOLD}fish_add_path ${install_dir}${RESET}"
      echo ""
      printf '%b\n\n' "  To make it permanent, add to ${DIM}${config_file}${RESET}:"
      printf '%b\n' "    ${DIM}fish_add_path ${install_dir}${RESET}"
      ;;
    *)
      printf '%b\n' "    ${BOLD}export PATH=\"${install_dir}:\$PATH\"${RESET}"
      echo ""
      printf '%b\n\n' "  To make it permanent, add to ${DIM}${config_file}${RESET}:"
      printf '%b\n' "    ${DIM}echo 'export PATH=\"${install_dir}:\$PATH\"' >> ${config_file}${RESET}"
      ;;
  esac

  echo ""
  printf '%b\n' "  Then restart your terminal or run: ${BOLD}source ${config_file}${RESET}"
}

# ─── Main Installation ──────────────────────────────────────────────────────

main() {
  # Parse command-line arguments (may override VERSION)
  parse_args "$@"

  # Normalize version: ensure it starts with 'v'
  case "$VERSION" in
    v*) ;; # already has v prefix
    *)  VERSION="v${VERSION}" ;;
  esac

  printf '\n'
  printf '%b\n' "  ${BRAND_BOLD}╔═══════════════════════════════════════╗${RESET}"
  printf '%b\n' "  ${BRAND_BOLD}║          QianWen CLI Installer        ║${RESET}"
  printf '%b\n' "  ${BRAND_BOLD}╚═══════════════════════════════════════╝${RESET}"
  printf '\n'

  # Detect platform
  os=$(detect_os)
  arch=$(detect_arch)
  info "Detected platform: ${BOLD}${os}-${arch}${RESET}"

  # Display version
  info "Version: ${BOLD}${VERSION}${RESET}"

  # Set install directory
  install_dir="$HOME/.qianwen/bin"
  info "Install directory: ${BOLD}${install_dir}${RESET}"

  # Construct download URL
  filename="qianwen-${os}-${arch}.zip"
  download_url="https://github.com/QianWen-AI/qianwen-cli/releases/download/${VERSION}/${filename}"
  info "Downloading ${BRAND}${filename}${RESET}..."

  # Create temp directory
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT
  tmp_zip="${tmp_dir}/${filename}"

  # Download
  download "$download_url" "$tmp_zip" || fatal "Download failed. Please check your network connection and verify the version exists."

  # Verify download
  if [ ! -f "$tmp_zip" ] || [ ! -s "$tmp_zip" ]; then
    fatal "Downloaded file is empty or missing. The version ${VERSION} may not exist for ${os}-${arch}."
  fi
  success "Download complete"

  # Check for unzip
  if ! has_cmd unzip; then
    fatal "'unzip' is required but not found. Please install it and try again."
  fi

  # Create install directory
  mkdir -p "$install_dir"

  # Backup existing binary before overwriting
  if [ -f "${install_dir}/qianwen" ]; then
    cp -f "${install_dir}/qianwen" "${install_dir}/qianwen-old"
    info "Backed up existing binary → ${DIM}qianwen-old${RESET}"
  fi

  # Extract (overwrite)
  info "Extracting to ${BOLD}${install_dir}${RESET}..."
  unzip -o -q "$tmp_zip" -d "$install_dir" || fatal "Failed to extract archive. The file may be corrupted."
  success "Extraction complete"

  # Set executable permissions
  if [ -f "${install_dir}/qianwen" ]; then
    chmod +x "${install_dir}/qianwen"
    success "Set executable permissions"
  else
    # Try to find the binary in a subdirectory
    binary=$(find "$install_dir" -name "qianwen" -type f 2>/dev/null | head -1)
    if [ -n "$binary" ]; then
      chmod +x "$binary"
      success "Set executable permissions"
    else
      warn "Could not find 'qianwen' binary in the extracted files."
    fi
  fi

  # Verify installation
  printf "\n"
  if [ -x "${install_dir}/qianwen" ]; then
    success "${BRAND_BOLD}QianWen CLI${RESET} ${VERSION} installed successfully!"
  else
    success "Installation complete (${VERSION})"
  fi

  # Check PATH
  case ":${PATH}:" in
    *":${install_dir}:"*)
      success "${BOLD}${install_dir}${RESET} is already in your PATH"
      echo ""
      printf '%b\n' "  Run ${BRAND_BOLD}qianwen${RESET} to get started."
      ;;
    *)
      print_path_instructions "$install_dir"
      ;;
  esac

  printf '\n'
  printf '%b\n' "  ${DIM}Documentation: https://www.qianwenai.com${RESET}"
  printf '%b\n' "  ${DIM}GitHub:        https://github.com/QianWen-AI/qianwen-cli${RESET}"
  printf '\n'
}

main "$@"
