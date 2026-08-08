#!/usr/bin/env node
/**
 * GAG Auto-Reconnect Agent (Termux + root)
 * -----------------------------------------
 * Deteksi Roblox DC / FC / crash / kick lewat heartbeat API (+ cek proses lokal via root),
 * lalu auto force-stop & relaunch balik ke server yang bener (follow / share link / private / public).
 *
 * Daftar akun ditarik dari dashboard (API). config.json cuma nyimpen apiKey + deviceId.
 * Kalau API gagal, fallback ke `accounts` di config.json (offline mode).
 *
 * Butuh: Node 18+ (fetch built-in), akses root (su). Jalanin: node agent.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const CFG_PATH = path.join(__dirname, "config.json");
const DEVICE_PATH = path.join(__dirname, "device.json");
const PAUSE_FILE = path.join(__dirname, "PAUSE"); // kill-switch: bikin file ini buat stop semua relaunch

// ---------- util ----------
const logQueue = []; // baris log yang belum dikirim ke API
function log(...a) {
  const now = Date.now();
  const t = new Date(now).toLocaleString("id-ID", { hour12: false });
  const msg = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(`[${t}]`, msg);
  logQueue.push({ t: now, m: msg });
  if (logQueue.length > 200) logQueue.splice(0, logQueue.length - 200);
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

// deviceId: dari config, atau device.json, atau generate baru sekali.
function getDeviceId(cfg) {
  if (cfg.deviceId) return cfg.deviceId;
  try {
    if (fs.existsSync(DEVICE_PATH)) {
      const d = JSON.parse(fs.readFileSync(DEVICE_PATH, "utf8"));
      if (d.deviceId) return d.deviceId;
    }
  } catch {}
  const id = "dev-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(DEVICE_PATH, JSON.stringify({ deviceId: id }, null, 2));
  } catch {}
  return id;
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
  const safe = cmd.replace(/'/g, `'\\''`);
  return sh(`su -c '${safe}'`);
}

// ---------- root & proses ----------
async function checkRoot() {
  const r = await su("id -u");
  return r.code === 0 && r.out.trim() === "0";
}

async function isRunning(pkg) {
  const r = await su(`pidof ${pkg}`);
  return r.code === 0 && r.out.length > 0;
}

async function forceStop(pkg) {
  await su(`am force-stop ${pkg}`);
}

async function launchDeeplink(url) {
  return su(`am start -a android.intent.action.VIEW -d "${url}"`);
}

function buildDeeplink(acc, session) {
  const pid = acc.placeId || 129954712878723;
  if (acc.joinMode === "share" && acc.shareCode) {
    return `roblox://navigation/share_links?code=${acc.shareCode}&type=Server`;
  }
  if (acc.joinMode === "private" && acc.privateLinkCode) {
    return `roblox://placeId=${pid}&linkCode=${acc.privateLinkCode}`;
  }
  if (acc.joinMode === "follow" && session && session.jobId) {
    return `roblox://placeId=${pid}&gameInstanceId=${session.jobId}`;
  }
  return `roblox://placeId=${pid}`;
}

// ---------- metrics device ----------
function readMemMB() {
  try {
    const t = fs.readFileSync("/proc/meminfo", "utf8");
    const total = /MemTotal:\s+(\d+)/.exec(t);
    const avail = /MemAvailable:\s+(\d+)/.exec(t);
    const totalMb = total ? Math.round(+total[1] / 1024) : 0;
    const freeMb = avail ? Math.round(+avail[1] / 1024) : 0;
    return { total: totalMb, free: freeMb, used: Math.max(0, totalMb - freeMb) };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

function cpuSnapshot() {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (p[3] || 0) + (p[4] || 0);
    const total = p.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch {
    return { idle: 0, total: 0 };
  }
}

async function readCpuPct() {
  const a = cpuSnapshot();
  await new Promise((r) => setTimeout(r, 250));
  const b = cpuSnapshot();
  const dt = b.total - a.total;
  const di = b.idle - a.idle;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
}

async function getProp(name) {
  const r = await sh(`getprop ${name}`);
  return r.out || null;
}

let deviceMeta = null; // model + android (cache, ga berubah)
async function reportDevice(cfg, deviceId, accounts) {
  if (!deviceMeta) {
    deviceMeta = {
      model: await getProp("ro.product.model"),
      android: await getProp("ro.build.version.release"),
    };
  }
  const mem = readMemMB();
  const cpu = await readCpuPct();
  let running = 0;
  const seen = new Set();
  for (const a of accounts) {
    const pkg = a.package || "com.roblox.client";
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    if (await isRunning(pkg)) running++;
  }
  const body = {
    deviceId,
    model: deviceMeta.model,
    android: deviceMeta.android,
    cpu,
    ramUsed: mem.used,
    ramFree: mem.free,
    ramTotal: mem.total,
    running,
    accounts: accounts.length,
  };
  const pending = logQueue.splice(0, logQueue.length); // kirim log baru
  if (pending.length) body.logs = pending;
  try {
    await fetch(`${cfg.apiBase}/api/agent/device`, {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    if (pending.length) logQueue.unshift(...pending); // gagal → balikin biar dikirim lagi
  }
}

// ---------- API ----------
async function apiGet(cfg, path) {
  const res = await fetch(`${cfg.apiBase}${path}`, { headers: { "x-api-key": cfg.apiKey } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function apiPost(cfg, path) {
  try {
    await fetch(`${cfg.apiBase}${path}`, { method: "POST", headers: { "x-api-key": cfg.apiKey } });
  } catch {}
}

async function fetchSessions(cfg) {
  const j = await apiGet(cfg, "/api/sessions");
  const map = {};
  for (const s of j.sessions ?? []) map[String(s.userId)] = s;
  return map;
}

async function fetchAccounts(cfg, deviceId) {
  try {
    const j = await apiGet(cfg, `/api/agent/accounts?deviceId=${encodeURIComponent(deviceId)}`);
    return j.accounts ?? [];
  } catch (e) {
    log(`⚠️  gagal ambil akun dari API (${e.message}) — pakai config.json`);
    return cfg.accounts;
  }
}

// ---------- state per akun ----------
const state = new Map();
function st(userId) {
  if (!state.has(userId))
    state.set(userId, { offlineSince: 0, lastRelaunchAt: 0, retries: 0, pausedUntil: 0 });
  return state.get(userId);
}

async function doRelaunch(cfg, acc, session, s, reason) {
  s.lastRelaunchAt = Date.now();
  const running = await isRunning(acc.package);
  const url = buildDeeplink(acc, session);
  log(`🔄 Relaunch ${acc.userId} (${reason}) | proses ${running ? "hidup(stuck)" : "mati"} | ${url}`);
  await forceStop(acc.package);
  await new Promise((r) => setTimeout(r, 2500));
  const r = await launchDeeplink(url);
  if (r.code !== 0) log(`   ❌ gagal launch: ${r.err || r.out || "code " + r.code}`);
  else log(`   ▶️  launched, tunggu heartbeat balik (~1-2 menit)`);
}

async function handleAccount(cfg, acc, sessions) {
  const now = Date.now();
  const s = st(acc.userId);
  const session = sessions[String(acc.userId)];
  const online = !!(session && session.online);

  // perintah dari dashboard: relaunch paksa (one-shot)
  if (acc.pendingCommand === "relaunch") {
    if (!fs.existsSync(PAUSE_FILE)) {
      s.offlineSince = 0;
      s.retries = 0;
      s.pausedUntil = 0;
      await doRelaunch(cfg, acc, session, s, "perintah web");
    }
    if (acc.id) await apiPost(cfg, `/api/agent/accounts/${acc.id}/ack`);
    return;
  }

  if (online) {
    if (s.offlineSince || s.retries) log(`✅ ${acc.userId} online lagi (server ${session.jobId || "-"})`);
    s.offlineSince = 0;
    s.retries = 0;
    s.pausedUntil = 0;
    return;
  }

  if (!s.offlineSince) {
    s.offlineSince = now;
    log(`⚠️  ${acc.userId} heartbeat putus (DC/FC/crash/kick?) — mulai hitung grace`);
    return;
  }

  if (s.pausedUntil && now < s.pausedUntil) return;
  if (now - s.offlineSince < cfg.offlineGraceMs) return;
  if (s.lastRelaunchAt && now - s.lastRelaunchAt < cfg.relaunchCooldownMs) return;

  if (s.retries >= cfg.maxRetries) {
    s.pausedUntil = now + cfg.backoffMs;
    s.retries = 0;
    log(`⛔ ${acc.userId} udah ${cfg.maxRetries}x relaunch tetep gagal — jeda ${Math.round(cfg.backoffMs / 60000)} menit`);
    return;
  }

  if (fs.existsSync(PAUSE_FILE)) {
    log(`⏸️  PAUSE aktif — skip relaunch ${acc.userId}`);
    return;
  }

  s.retries++;
  await doRelaunch(cfg, acc, session, s, `percobaan ${s.retries}/${cfg.maxRetries}`);
}

// ---------- main loop ----------
let running = true;
async function tick(cfg, deviceId) {
  let sessions, accounts;
  try {
    sessions = await fetchSessions(cfg);
  } catch (e) {
    log(`⚠️  gagal ambil /api/sessions: ${e.message}`);
    return;
  }
  accounts = await fetchAccounts(cfg, deviceId);
  await reportDevice(cfg, deviceId, accounts);
  if (!accounts.length) {
    log("ℹ️  belum ada akun ditugasin ke device ini (tambah dari dashboard)");
    return;
  }
  for (const acc of accounts) {
    try {
      await handleAccount(cfg, acc, sessions);
    } catch (e) {
      log(`⚠️  error handle ${acc.userId}: ${e.message}`);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const deviceId = getDeviceId(cfg);
  log("=== GAG Auto-Reconnect Agent ===");
  log(`API: ${cfg.apiBase} | device: ${deviceId} | poll ${cfg.pollMs / 1000}s`);

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
    await tick(cfg, deviceId);
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main();
