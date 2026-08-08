#!/usr/bin/env node
/**
 * GAG Auto-Reconnect Agent (Termux + root)
 * -----------------------------------------
 * Deteksi Roblox DC / FC / crash / kick lewat heartbeat API (+ cek proses lokal via root),
 * lalu auto force-stop & relaunch balik ke server yang bener (follow jobId / private server / public).
 *
 * Butuh: Node 18+ (fetch built-in), akses root (su). Jalanin: node agent.js
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const CFG_PATH = path.join(__dirname, "config.json");
const PAUSE_FILE = path.join(__dirname, "PAUSE"); // kill-switch: bikin file ini buat stop relaunch

// ---------- util ----------
function log(...a) {
  const t = new Date().toLocaleString("id-ID", { hour12: false });
  console.log(`[${t}]`, ...a);
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  cfg.pollMs = cfg.pollMs ?? 10000;
  cfg.offlineGraceMs = cfg.offlineGraceMs ?? 45000;
  cfg.relaunchCooldownMs = cfg.relaunchCooldownMs ?? 120000;
  cfg.maxRetries = cfg.maxRetries ?? 5;
  cfg.backoffMs = cfg.backoffMs ?? 600000;
  cfg.accounts = cfg.accounts ?? [];
  return cfg;
}

// jalanin shell command, resolve {code, out, err}
function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        out: (stdout || "").trim(),
        err: (stderr || "").trim(),
      });
    });
  });
}

// jalanin sebagai root
function su(cmd) {
  // escape single quote buat dibungkus su -c '...'
  const safe = cmd.replace(/'/g, `'\\''`);
  return sh(`su -c '${safe}'`);
}

// ---------- root & proses ----------
async function checkRoot() {
  const r = await su("id -u");
  return r.code === 0 && r.out.trim() === "0";
}

// true kalau proses package lagi jalan
async function isRunning(pkg) {
  const r = await su(`pidof ${pkg}`);
  return r.code === 0 && r.out.length > 0;
}

async function forceStop(pkg) {
  await su(`am force-stop ${pkg}`);
}

async function launchDeeplink(url) {
  // pakai su biar konsisten & bisa launch dari background
  return su(`am start -a android.intent.action.VIEW -d "${url}"`);
}

function buildDeeplink(acc, session) {
  const pid = acc.placeId;
  // share link baru Roblox: roblox.com/share?code=xxxx&type=Server
  if (acc.joinMode === "share" && acc.shareCode) {
    return `roblox://navigation/share_links?code=${acc.shareCode}&type=Server`;
  }
  // private server format lama: ?privateServerLinkCode=xxxx
  if (acc.joinMode === "private" && acc.privateLinkCode) {
    return `roblox://placeId=${pid}&linkCode=${acc.privateLinkCode}`;
  }
  if (acc.joinMode === "follow" && session && session.jobId) {
    return `roblox://placeId=${pid}&gameInstanceId=${session.jobId}`;
  }
  // fallback: public random server
  return `roblox://placeId=${pid}`;
}

// ---------- API ----------
async function fetchSessions(cfg) {
  const res = await fetch(`${cfg.apiBase}/api/sessions`, {
    headers: { "x-api-key": cfg.apiKey },
  });
  if (!res.ok) throw new Error(`sessions HTTP ${res.status}`);
  const j = await res.json();
  const map = {};
  for (const s of j.sessions ?? []) map[String(s.userId)] = s;
  return map;
}

// ---------- state per akun ----------
// { offlineSince, lastRelaunchAt, retries, pausedUntil }
const state = new Map();
function st(userId) {
  if (!state.has(userId))
    state.set(userId, { offlineSince: 0, lastRelaunchAt: 0, retries: 0, pausedUntil: 0 });
  return state.get(userId);
}

async function handleAccount(cfg, acc, sessions) {
  const now = Date.now();
  const s = st(acc.userId);
  const session = sessions[String(acc.userId)];
  const online = !!(session && session.online);

  // masih online → reset semua penanda
  if (online) {
    if (s.offlineSince || s.retries) log(`✅ ${acc.userId} online lagi (server ${session.jobId || "-"})`);
    s.offlineSince = 0;
    s.retries = 0;
    s.pausedUntil = 0;
    return;
  }

  // offline: catat kapan mulai
  if (!s.offlineSince) {
    s.offlineSince = now;
    log(`⚠️  ${acc.userId} heartbeat putus (DC/FC/crash/kick?) — mulai hitung grace`);
    return;
  }

  // masih dalam masa backoff (kena limit retry)
  if (s.pausedUntil && now < s.pausedUntil) return;

  // belum lewat grace period → tunggu (biar ga panik pas lag sesaat)
  if (now - s.offlineSince < cfg.offlineGraceMs) return;

  // masih cooldown dari relaunch terakhir (Roblox lagi loading) → tunggu
  if (s.lastRelaunchAt && now - s.lastRelaunchAt < cfg.relaunchCooldownMs) return;

  // kena limit retry → backoff
  if (s.retries >= cfg.maxRetries) {
    s.pausedUntil = now + cfg.backoffMs;
    s.retries = 0;
    log(`⛔ ${acc.userId} udah ${cfg.maxRetries}x relaunch tetep gagal — jeda ${Math.round(cfg.backoffMs / 60000)} menit`);
    return;
  }

  // kill-switch aktif?
  if (fs.existsSync(PAUSE_FILE)) {
    log(`⏸️  PAUSE aktif — skip relaunch ${acc.userId}`);
    return;
  }

  // ---- RELAUNCH ----
  s.retries++;
  s.lastRelaunchAt = now;
  const running = await isRunning(acc.package);
  const url = buildDeeplink(acc, session);
  log(`🔄 Relaunch ${acc.userId} (percobaan ${s.retries}/${cfg.maxRetries}) | proses ${running ? "hidup(stuck)" : "mati"} | ${url}`);

  await forceStop(acc.package);
  await new Promise((r) => setTimeout(r, 2500));
  const r = await launchDeeplink(url);
  if (r.code !== 0) log(`   ❌ gagal launch: ${r.err || r.out || "code " + r.code}`);
  else log(`   ▶️  launched, tunggu heartbeat balik (~1-2 menit)`);
}

// ---------- main loop ----------
let running = true;
async function tick(cfg) {
  let sessions;
  try {
    sessions = await fetchSessions(cfg);
  } catch (e) {
    log(`⚠️  gagal ambil /api/sessions: ${e.message}`);
    return;
  }
  for (const acc of cfg.accounts) {
    try {
      await handleAccount(cfg, acc, sessions);
    } catch (e) {
      log(`⚠️  error handle ${acc.userId}: ${e.message}`);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  log("=== GAG Auto-Reconnect Agent ===");
  log(`API: ${cfg.apiBase} | poll ${cfg.pollMs / 1000}s | akun: ${cfg.accounts.map((a) => a.userId).join(", ") || "(kosong!)"}`);

  if (!(await checkRoot())) {
    log("❌ Root ga kedeteksi (su gagal). Grant root ke Termux dulu. Keluar.");
    process.exit(1);
  }
  log("🔓 Root OK");

  process.on("SIGINT", () => {
    running = false;
    log("👋 Stop (SIGINT)");
    process.exit(0);
  });

  while (running) {
    await tick(cfg);
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main();
