#!/data/data/com.termux/files/usr/bin/bash
# GAG Auto-Reconnect Agent — installer 1-baris, ZERO input (Termux + root)
# Jalanin: curl -s https://raw.githubusercontent.com/Tirta71/gag-termux-agent/main/setup.sh | bash
# Ga usah ketik apa-apa. Cuma perlu approve popup root sekali.
set -e

REPO="https://github.com/Tirta71/gag-termux-agent.git"
DIR="$HOME/gag-agent"
APIBASE="https://api.allegiaant.my.id"
APIKEY="ae3858d4a2def3306d6cbff26ff2bd72eee9319b1aae27d1"

echo "=========================================="
echo " GAG Auto-Reconnect — install otomatis"
echo "=========================================="

echo "[1/6] Update + install nodejs & git..."
yes | pkg update >/dev/null 2>&1 || true
yes | pkg install nodejs git >/dev/null 2>&1 || pkg install -y nodejs git

echo "[2/6] Ambil kode agent..."
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || true
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

echo "[3/6] Tulis config otomatis (API key udah include)..."
node -e "const fs=require('fs');const f='config.json';let c={};try{c=JSON.parse(fs.readFileSync(f))}catch{try{c=JSON.parse(fs.readFileSync('config.example.json'))}catch{c={}}};c.apiBase='$APIBASE';c.apiKey='$APIKEY';if(!Array.isArray(c.accounts))c.accounts=[];fs.writeFileSync(f,JSON.stringify(c,null,2))"

echo "[4/6] Minta akses root (approve popup Magisk kalau muncul)..."
su -c 'id -u' </dev/null >/dev/null 2>&1 || true
if su -c 'id -u' </dev/null 2>/dev/null | grep -q '^0$'; then
  echo "    Root OK"
else
  echo "    (Root belum ke-grant — approve popup-nya, nanti agent minta lagi)"
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

echo "[6/6] Device ID + jalanin agent..."
DEVID=$(node -e "const fs=require('fs');const f='device.json';let d={};try{d=JSON.parse(fs.readFileSync(f))}catch{};if(!d.deviceId){d.deviceId='dev-'+require('crypto').randomBytes(4).toString('hex');fs.writeFileSync(f,JSON.stringify(d,null,2))}console.log(d.deviceId)")

echo ""
echo "=========================================="
echo " Beres! Device ID: $DEVID"
echo " Daftarin akun di dashboard -> Reconnect,"
echo " isi Device ID di atas."
echo "=========================================="
echo " Agent jalan otomatis sekarang (Ctrl+C buat stop):"
echo ""

# langsung jalanin agent (foreground). Kalau mau background:
#   nohup node agent.js > agent.log 2>&1 &
exec node agent.js
