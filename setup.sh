#!/data/data/com.termux/files/usr/bin/bash
# GAG Auto-Reconnect Agent — installer 1-baris (Termux + root)
# Jalanin: curl -s https://raw.githubusercontent.com/Tirta71/gag-termux-agent/main/setup.sh | bash
set -e

REPO="https://github.com/Tirta71/gag-termux-agent.git"
DIR="$HOME/gag-agent"
TTY=/dev/tty

echo "=========================================="
echo " GAG Auto-Reconnect Agent — installer"
echo "=========================================="

echo "[1/6] Install nodejs + git..."
pkg install -y nodejs git >/dev/null 2>&1 || pkg install -y nodejs git

echo "[2/6] Ambil kode agent..."
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || true
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

echo "[3/6] Setup API key..."
[ -f config.json ] || cp config.example.json config.json
NEED_KEY=1
if [ -f config.json ] && ! grep -q "PASTE_REPORT_API_KEY_DISINI" config.json; then
  printf "    Config udah ada API key. Ganti? (y/N): "
  read ANS < "$TTY" || ANS="n"
  [ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || NEED_KEY=0
fi
if [ "$NEED_KEY" = "1" ]; then
  printf "    Paste API key (REPORT_API_KEY): "
  read APIKEY < "$TTY"
  node -e "const f='config.json';const fs=require('fs');const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};c.apiBase=c.apiBase||'https://api.allegiaant.my.id';c.apiKey=process.argv[1].trim();fs.writeFileSync(f,JSON.stringify(c,null,2));" "$APIKEY"
  echo "    ✓ API key tersimpan"
fi

echo "[4/6] Minta akses root (approve popup Magisk)..."
if su -c 'id -u' </dev/null 2>/dev/null | grep -q '^0$'; then
  echo "    ✓ Root OK"
else
  echo "    ⚠ Root belum ke-grant. Buka Magisk/root manager, kasih izin ke Termux, terus jalanin: node agent.js"
fi

echo "[5/6] Wake-lock + autostart pas reboot..."
termux-wake-lock 2>/dev/null || true
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/gag-agent" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd $DIR && node agent.js >> $DIR/agent.log 2>&1
EOF
chmod +x "$HOME/.termux/boot/gag-agent"
echo "    ✓ (butuh app Termux:Boot biar auto-start)"

echo "[6/6] Device ID:"
DEVID=$(node -e "const fs=require('fs');const f='device.json';let d={};try{d=JSON.parse(fs.readFileSync(f))}catch{};if(!d.deviceId){d.deviceId='dev-'+require('crypto').randomBytes(4).toString('hex');fs.writeFileSync(f,JSON.stringify(d,null,2))}console.log(d.deviceId)")
echo "    $DEVID"

echo ""
echo "=========================================="
echo " Beres! Device ID: $DEVID"
echo " Daftarin akun dari dashboard → Reconnect →"
echo " isi Device ID di atas (atau kosongin = semua device)."
echo ""
echo " Jalanin agent sekarang:"
echo "   cd ~/gag-agent && node agent.js"
echo "=========================================="
