#!/usr/bin/env bash
# ================================================================
# APEX v2.0 — One-Shot Install Script
# Autonomous Polymorphic Execution System
# By Temple Nweke — Jomiez Innovation
# ================================================================
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'

echo -e "${CYAN}"
cat << 'BANNER'
 █████╗ ██████╗ ███████╗██╗  ██╗
██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝
███████║██████╔╝█████╗   ╚███╔╝
██╔══██║██╔═══╝ ██╔══╝   ██╔██╗
██║  ██║██║     ███████╗██╔╝ ██╗
╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝  v2.0
BANNER
echo -e "${RESET}${BOLD}Autonomous Polymorphic Execution System${RESET}"
echo -e "${CYAN}56 files | 13,000+ lines | 28 agents | 40+ capabilities${RESET}\n"

# ── Detect environment ─────────────────────────────────────────
IS_TERMUX=false; IS_KALI=false; IS_LINUX=false; IS_MAC=false; IS_VPS=false

if [[ -n "$TERMUX_VERSION" ]] || [[ "$PREFIX" == *"com.termux"* ]]; then
  IS_TERMUX=true; echo -e "${YELLOW}📱 Detected: Termux (Android)${RESET}"
elif grep -qi "kali" /etc/os-release 2>/dev/null; then
  IS_KALI=true; IS_LINUX=true; echo -e "${GREEN}🐉 Kali Linux — Full security capabilities enabled${RESET}"
elif [[ "$(uname)" == "Linux" ]]; then
  IS_LINUX=true
  [[ -z "$DISPLAY" ]] && IS_VPS=true && echo -e "${GREEN}☁️  Linux VPS — Server mode${RESET}" || echo -e "${GREEN}🐧 Linux Desktop${RESET}"
elif [[ "$(uname)" == "Darwin" ]]; then
  IS_MAC=true; echo -e "${GREEN}🍎 macOS${RESET}"
fi

# ── Node.js ────────────────────────────────────────────────────
echo -e "\n${CYAN}Checking Node.js (requires v20+)...${RESET}"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  echo -e "${GREEN}✓ Node.js ${NODE_VER}${RESET}"
else
  echo -e "${YELLOW}Installing Node.js 20...${RESET}"
  if $IS_TERMUX; then pkg install nodejs -y
  elif $IS_LINUX; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif $IS_MAC; then brew install node; fi
fi

# ── npm install ────────────────────────────────────────────────
echo -e "\n${CYAN}Installing npm dependencies (30 packages)...${RESET}"
npm install 2>&1 | tail -3
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── Playwright ─────────────────────────────────────────────────
echo -e "\n${CYAN}Setting up browser automation (Playwright)...${RESET}"
if $IS_TERMUX; then
  echo -e "${YELLOW}⚠  Termux: browser agent uses HTTP fallback${RESET}"
else
  npx playwright install chromium --with-deps 2>&1 | tail -3 && echo -e "${GREEN}✓ Playwright (Chromium) ready${RESET}" || echo -e "${YELLOW}⚠  Playwright install failed — HTTP fallback active${RESET}"
fi

# ── Python tools ───────────────────────────────────────────────
echo -e "\n${CYAN}Checking Python tools...${RESET}"
if command -v python3 &>/dev/null; then
  echo -e "${GREEN}✓ Python $(python3 --version 2>&1 | cut -d' ' -f2)${RESET}"
  # Install edge-tts for free voice
  pip3 install edge-tts yt-dlp --quiet 2>/dev/null && echo -e "${GREEN}✓ edge-tts + yt-dlp installed (free voice + YouTube)${RESET}" || true
else
  echo -e "${YELLOW}⚠  Python not found — some features limited${RESET}"
fi

# ── Kali tools ────────────────────────────────────────────────
if $IS_KALI; then
  echo -e "\n${CYAN}Installing Kali security tools...${RESET}"
  sudo apt-get update -qq 2>/dev/null
  sudo apt-get install -y -qq nmap nikto gobuster sqlmap theharvester \
    dirb wpscan dnsrecon sslscan enum4linux hydra john \
    tesseract-ocr xdotool scrot xclip wmctrl ffmpeg 2>/dev/null || true
  echo -e "${GREEN}✓ Kali tools ready${RESET}"
elif $IS_LINUX && ! $IS_TERMUX; then
  echo -e "\n${CYAN}Installing Linux tools...${RESET}"
  sudo apt-get install -y -qq xdotool scrot tesseract-ocr xclip wmctrl ffmpeg 2>/dev/null || true
  echo -e "${GREEN}✓ Linux tools ready${RESET}"
  # Docker for Kali container
  if command -v docker &>/dev/null; then
    echo -e "${CYAN}Pulling Kali Docker image (background)...${RESET}"
    docker pull kalilinux/kali-rolling 2>/dev/null &
    echo -e "${GREEN}✓ Kali Docker configured${RESET}"
  fi
elif $IS_MAC; then
  echo -e "\n${CYAN}Checking macOS tools...${RESET}"
  command -v ffmpeg &>/dev/null || brew install ffmpeg 2>/dev/null || true
  command -v tesseract &>/dev/null || brew install tesseract 2>/dev/null || true
  echo -e "${GREEN}✓ macOS tools ready${RESET}"
fi

# ── Blender check ─────────────────────────────────────────────
echo -e "\n${CYAN}Checking Blender (3D modeling)...${RESET}"
if command -v blender &>/dev/null; then
  echo -e "${GREEN}✓ Blender found — BlenderAgent fully operational${RESET}"
else
  echo -e "${YELLOW}⚠  Blender not found — BlenderAgent will use ShapE fallback${RESET}"
  echo -e "${YELLOW}   Install: https://www.blender.org/download/${RESET}"
fi

# ── .env setup ────────────────────────────────────────────────
echo -e "\n${CYAN}Setting up configuration...${RESET}"
if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo -e "${GREEN}✓ .env created${RESET}"
else
  echo -e "${GREEN}✓ .env already exists${RESET}"
fi

# ── Directories ───────────────────────────────────────────────
mkdir -p .apex-data .apex-data/email .apex-data/revenue .apex-data/intelligence \
         .apex-data/videos .apex-data/blender .apex-data/prospects \
         .apex-generated .apex-screenshots .apex-downloads .apex-security-results \
         .apex-browser-profiles .apex-audio plugins skills

# ── Make CLI executable ───────────────────────────────────────
chmod +x apex.js
if $IS_LINUX || $IS_MAC; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  ln -sf "$(pwd)/apex.js" "$INSTALL_DIR/apex" 2>/dev/null || true
fi

# ── VPS setup tip ─────────────────────────────────────────────
if $IS_VPS; then
  echo -e "\n${CYAN}VPS detected — tip for always-on APEX:${RESET}"
  echo -e "${YELLOW}  pm2 start apex.js --name apex${RESET}"
  echo -e "${YELLOW}  pm2 save && pm2 startup${RESET}"
fi

# ── Done ──────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "✅ APEX v2.0 Installation Complete!"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
echo -e "${BOLD}Required:${RESET} Add GEMINI_API_KEY to ${CYAN}.env${RESET}"
echo -e "          Get free: ${CYAN}https://aistudio.google.com/app/apikey${RESET}\n"
echo -e "${BOLD}Start APEX:${RESET}"
echo -e "  ${CYAN}node apex.js${RESET}                    — Interactive mode"
echo -e "  ${CYAN}node apex.js run 'build X'${RESET}      — Single task"
echo -e "  ${CYAN}node apex.js team dev_team 'build X'${RESET} — Team task"
echo -e "  ${CYAN}node apex.js revenue opportunities${RESET} — Find money"
echo -e "  ${CYAN}node apex.js generate image 'a cat'${RESET} — Free image gen"
echo -e "  ${CYAN}node apex.js 3d 'a wooden chair'${RESET}   — 3D model"
echo -e "  ${CYAN}node apex.js mcp${RESET}                — MCP server for IDE"
echo -e "  ${CYAN}node apex.js soul${RESET}               — APEX identity\n"
echo -e "${BOLD}Dashboard:${RESET} ${CYAN}http://localhost:7332${RESET} (auto-starts)\n"
echo -e "${BOLD}Admin code:${RESET} ${YELLOW}tim${RESET} (change in settings)\n"
$IS_KALI && echo -e "${GREEN}🐉 Kali Linux: Full security capabilities active${RESET}\n"
$IS_TERMUX && echo -e "${YELLOW}📱 Termux: Browser uses HTTP fallback. Voice uses espeak.${RESET}\n"
echo -e "${CYAN}APEX is alive. Go build something that matters.${RESET}\n"
