# GAG Auto-Reconnect Agent (Termux + root)

Agent ringan yang mantau Roblox tiap akun lewat **heartbeat API**. Kalau executor berhenti
kirim heartbeat (DC / force-close / crash / kick), agent otomatis **force-stop + relaunch**
Roblox dan join balik ke server yang bener.

Deteksi utamanya dari heartbeat (`/api/sessions`), plus cek proses lokal via root buat tau
Roblox-nya mati beneran atau nyangkut.

## Cara kerja singkat
1. Poll `GET /api/sessions` tiap `pollMs`.
2. Akun `online:false` lebih lama dari `offlineGraceMs` → dianggap putus.
3. `su am force-stop <package>` → tunggu → `su am start` deeplink Roblox.
4. Cooldown `relaunchCooldownMs` biar ga spam pas Roblox lagi loading.
5. Gagal terus `maxRetries` kali → jeda `backoffMs` (anti loop pas kena ban/captcha).

## Mode join (per akun, di `config.json`)
- `follow`  → balik ke server terakhir (`gameInstanceId` dari heartbeat). **Default.**
- `private` → join private server, isi `privateLinkCode` (kode dari link `?privateServerLinkCode=xxxx`).
- `public`  → server random.

## Setup di HP (Termux, sekali)
```bash
pkg update && pkg install nodejs -y
# taruh folder ini di HP, misal ~/gag-agent
cd ~/gag-agent
# edit config.json: apiKey (REPORT_API_KEY), userId roblox, placeId, package
node agent.js
```

### Biar tahan mati / jalan terus
```bash
termux-wake-lock                      # cegah di-kill sistem
pkg install termux-services -y        # opsional: auto-restart
# matiin battery optimization buat Termux + Roblox di Settings Android
```

### Auto-start pas HP nyala (opsional)
```bash
pkg install termux-boot -y
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/gag-agent <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/gag-agent && node agent.js >> ~/gag-agent/agent.log 2>&1
EOF
chmod +x ~/.termux/boot/gag-agent
```

## Prasyarat
- **Root** + grant akses `su` ke Termux (buat `force-stop` & `am start` app lain).
- Delta (atau executor lain): **auto-execute** loader aktif → hub jalan lagi tiap Roblox kebuka.
- Akun Roblox **tetap login**.

## Kill-switch
Bikin file kosong bernama `PAUSE` di folder ini → agent berhenti relaunch (tetap mantau).
Hapus file-nya buat lanjut lagi.

## config.json
| Field | Arti |
|---|---|
| `apiKey` | REPORT_API_KEY (header x-api-key) |
| `pollMs` | interval cek (default 10s) |
| `offlineGraceMs` | tunggu segini setelah putus baru relaunch (anti panik lag sesaat) |
| `relaunchCooldownMs` | jarak antar relaunch (kasih waktu Roblox loading) |
| `maxRetries` / `backoffMs` | batas relaunch beruntun sebelum jeda panjang |
| `accounts[].userId` | userId Roblox (harus sama kaya yang muncul di dashboard) |
| `accounts[].package` | package Roblox (`com.roblox.client`, atau clone-nya) |
| `accounts[].joinMode` | `follow` / `private` / `public` |

> Catatan: kontrol dari web (tombol start/stop/relaunch + input private server dari dashboard)
> nyusul di langkah berikutnya. Versi ini fokus **deteksi + auto-reconnect otomatis**.
