# GAG Auto-Reconnect Agent (Termux + root)

Agent ringan yang mantau Roblox tiap akun lewat **heartbeat API**. Kalau executor berhenti
kirim heartbeat (DC / force-close / crash / kick), agent otomatis **force-stop + relaunch**
Roblox dan join balik ke server yang bener.

Daftar akun **diatur dari dashboard** (menu Reconnect) — `config.json` di HP cuma nyimpen
API key + device ID. Nambah/ubah akun, ganti server, tombol relaunch: semua dari web.
##Command light
```
nohup node ~/gag-agent/agent.js > ~/gag-agent/agent.log 2>&1 &
```
## Cara kerja singkat
1. Poll `GET /api/agent/accounts?deviceId=…` (daftar akun) + `GET /api/sessions` (status online).
2. Akun `online:false` lebih lama dari `offlineGraceMs` → dianggap putus.
3. `su am force-stop <package>` → tunggu → `su am start` deeplink Roblox.
4. Cooldown `relaunchCooldownMs` biar ga spam pas Roblox lagi loading.
5. Gagal terus `maxRetries` kali → jeda `backoffMs` (anti loop pas kena ban/captcha).
6. Perintah `relaunch` dari dashboard = paksa relaunch langsung (skip grace).

## Install (1 baris)
```bash
curl -s https://raw.githubusercontent.com/Tirta71/gag-termux-agent/main/setup.sh | bash
```
Installer otomatis: install node + git, clone repo, minta **API key** (paste sekali),
minta akses root, wake-lock, bikin autostart reboot, dan kasih **Device ID**.

Habis itu:
```bash
cd ~/gag-agent && node agent.js
```

## Daftarin akun (dari dashboard)
1. Buka dashboard → menu **Reconnect**
2. **Tambah akun**: isi User ID Roblox + link/kode share server + mode
3. (Opsional) isi **Device ID** biar akun itu jalan di HP tertentu — kosong = device manapun
4. **Simpan** → agent otomatis narik akun barunya

## Mode join
- `share`   → link server baru `roblox.com/share?code=xxxx&type=Server` (paste linknya, kode diambil otomatis)
- `follow`  → balik ke server terakhir (`gameInstanceId` dari heartbeat)
- `private` → private server format lama (`?privateServerLinkCode=xxxx`)
- `public`  → server random

## Prasyarat
- **Root** + grant akses `su` ke Termux (buat `force-stop` & `am start` app lain).
- Executor (Delta dll): **auto-execute** loader aktif → hub jalan lagi tiap Roblox kebuka.
- Akun Roblox **tetap login**.
- Matiin **battery optimization** buat Termux + Roblox.

## Kill-switch
Bikin file kosong bernama `PAUSE` di folder ini → agent berhenti relaunch (tetap mantau).
Hapus file-nya buat lanjut lagi.

## config.json
| Field | Arti |
|---|---|
| `apiKey` | REPORT_API_KEY (header x-api-key) |
| `deviceId` | ID device ini (auto-generate ke `device.json` kalau kosong) |
| `pollMs` | interval cek (default 10s) |
| `offlineGraceMs` | tunggu segini setelah putus baru relaunch (anti panik lag sesaat) |
| `relaunchCooldownMs` | jarak antar relaunch (kasih waktu Roblox loading) |
| `maxRetries` / `backoffMs` | batas relaunch beruntun sebelum jeda panjang |
| `accounts` | **fallback** kalau API ga kejangkau (biasanya dibiarin kosong `[]`) |

> Daftar akun utama dari API. `accounts` di config cuma cadangan offline.
