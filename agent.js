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
  const msg = a
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .join(" ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{2300}-\u{23FF}]/gu, "") // buang emoji/icon
    .replace(/\s+/g, " ")
    .trim();
  console.log(`[${t}]`, msg);
  logQueue.push({ t: now, m: msg });
  if (logQueue.length > 200) logQueue.splice(0, logQueue.length - 200);
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  cfg.pollMs = cfg.pollMs ?? 5000;
  cfg.launchSettleMs = cfg.launchSettleMs ?? 15000; // jeda boot habis relaunch (jgn dobel)
  cfg.loadingPatienceMs = cfg.loadingPatienceMs ?? 60000; // proses hidup tp offline = loading, sabar segini
  cfg.deadConfirmMs = cfg.deadConfirmMs ?? 45000; // pas hop, proses "mati" sesaat itu wajar — konfirmasi dulu segini (device lemot hop bisa lama)
  cfg.maxRetries = cfg.maxRetries ?? 5;
  cfg.backoffMs = cfg.backoffMs ?? 600000;
  cfg.localDetect = cfg.localDetect ?? false; // logcat OFF default (berat, bikin stutter FPS; redundant sama signal)
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

const procCache = new Map(); // pkg -> { ts, alive } — hindari pidof dobel dlm 1 tick
async function isRunning(pkg) {
  const c = procCache.get(pkg);
  if (c && Date.now() - c.ts < 3000) return c.alive; // pakai hasil barusan (masih dlm tick sama)
  const r = await su(`pidof ${pkg}`);
  const alive = r.code === 0 && r.out.length > 0;
  procCache.set(pkg, { ts: Date.now(), alive });
  return alive;
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
let firstDeviceReport = true; // laporan pertama → clear log lama di web
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
  if (firstDeviceReport) body.resetLogs = true; // clear log lama di web pas agent baru start
  try {
    await fetch(`${cfg.apiBase}/api/agent/device`, {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    firstDeviceReport = false;
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

async function apiPost(cfg, path, body) {
  try {
    await fetch(`${cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
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

// nama akun yang enak dibaca (nama > userId)
function disp(acc) {
  return acc.label || acc.username || acc.userId;
}
// ambil kode/alasan singkat dari baris logcat mentah
function reasonFromLine(line) {
  const m = line.match(/reason:?\s*(\d+)/i) || line.match(/error ?code[: ]*(\d+)/i) || line.match(/\b(26\d|27\d|51\d|52\d|61\d)\b/);
  return m ? `error ${m[1]}` : "disconnect";
}

async function doRelaunch(cfg, acc, session, s, reason, overrideCode) {
  s.lastRelaunchAt = Date.now();
  const nm = disp(acc);
  const running = await isRunning(acc.package);
  // overrideCode = join sekali-pakai ke PS akun lain (buat trade)
  const url = overrideCode
    ? `roblox://navigation/share_links?code=${overrideCode}&type=Server`
    : buildDeeplink(acc, session);
  const dest = overrideCode ? "server trade (join)" : acc.joinMode === "share" ? "private server" : "market";
  log(`🔄 [${nm}] buka ulang → ${dest}${running ? " (nutup Roblox yg nyangkut)" : ""}`);
  await forceStop(acc.package);
  await new Promise((r) => setTimeout(r, 2500));
  const r = await launchDeeplink(url);
  if (r.code !== 0) log(`❌ [${nm}] gagal buka Roblox (${r.err || r.out || "code " + r.code})`);
  else log(`▶️ [${nm}] Roblox dibuka, nunggu masuk game…`);
}

// ---------- deteksi lokal (baca logcat tag Roblox) ----------
// HARUS pakai konteks kata — JANGAN match angka polos (Roblox nyetak byk angka di log
// statistik spt "tbeat sc_count 7..." → false positive). Cuma baris disconnect asli yg kena.
const RE_ERROR = /disconnected|lost connection|connection lost|sending disconnect|disconnect with reason|failed to connect|error ?code[:=\s]*\d+/i;
// Sinyal yang BUKAN disconnect → di-skip (background, pindah app, teleport gagal/full 769-773)
const RE_GRACE = /stop\(\) called|pause game session|leaving game|teleport|server is full|game is full|restricted|\b(769|770|771|772|773)\b/i;

let lastLogEpoch = 0; // detik epoch log terakhir yg diproses
async function checkLocalErrors(cfg, accounts, sessions) {
  if (cfg.localDetect === false) return;
  const r = await su("logcat -d -v epoch -t 500 -s Roblox");
  if (r.code !== 0 || !r.out) return;

  let maxTs = lastLogEpoch;
  let errLine = null;
  for (const ln of r.out.split("\n")) {
    const m = ln.match(/^\s*(\d+\.\d+)\s/);
    if (!m) continue;
    const ts = parseFloat(m[1]);
    if (ts > maxTs) maxTs = ts;
    if (ts <= lastLogEpoch) continue; // baris lama, skip
    if (RE_GRACE.test(ln)) continue; // background/leave/teleport → bukan DC
    if (RE_ERROR.test(ln)) errLine = ln;
  }
  lastLogEpoch = maxTs;
  if (!errLine) return;

  // target: 1 device = 1 akun → ambil akun aktif pertama (skip yg nonaktif)
  const target = accounts.find((a) => a.enabled !== false);
  if (!target) return;
  const s = st(target.userId);
  const now = Date.now();

  if (target.suppressUntil && now < target.suppressUntil) return; // lagi teleport/relocate
  if (fs.existsSync(PAUSE_FILE)) return;
  if (s.pausedUntil && now < s.pausedUntil) return;
  if (now - s.lastRelaunchAt < cfg.launchSettleMs) return; // baru aja relaunch, kasih waktu boot
  s.retries = (s.retries || 0) + 1;
  if (s.retries > cfg.maxRetries) {
    s.pausedUntil = now + cfg.backoffMs;
    s.retries = 0;
    log(`⛔ [${disp(target)}] gagal terus ${cfg.maxRetries}x — istirahat ${Math.round(cfg.backoffMs / 60000)} menit`);
    return;
  }
  log(`🔎 [${disp(target)}] ${reasonFromLine(errLine)} kebaca dari Roblox → buka ulang`);
  s.offlineSince = 0;
  await doRelaunch(cfg, target, sessions[String(target.userId)], s, "deteksi lokal");
}

// Keputusan berdasarkan KONDISI NYATA (bukan timer buta):
//  - proses mati (close/crash/launch gagal) → buka ulang
//  - proses hidup + offline → lagi loading/join, sabar sampai loadingPatience; kelamaan → buka ulang
//  - proses hidup + online → sehat
async function handleAccount(cfg, acc, sessions) {
  const now = Date.now();
  const s = st(acc.userId);
  const session = sessions[String(acc.userId)];
  const online = !!(session && session.online);
  const suppressed = acc.suppressUntil && now < acc.suppressUntil; // lagi teleport/relocate
  const sinceLaunch = s.lastRelaunchAt ? now - s.lastRelaunchAt : Infinity;
  const forced = acc.pendingCommand === "relaunch"; // web Rejoin / signal error / join server
  const joinCode = acc.pendingJoinCode || null; // sekali-pakai: join ke PS akun lain (trade)
  if (forced && acc.id) await apiPost(cfg, `/api/agent/accounts/${acc.id}/ack`);

  // NONAKTIF (Stop): tutup Roblox & jgn ngapa-ngapain
  if (acc.enabled === false) {
    if (!s.stopped) {
      s.stopped = true;
      log(`[${disp(acc)}] dinonaktifkan — tutup Roblox`);
      await forceStop(acc.package || "com.roblox.client");
    }
    return;
  }
  if (s.stopped) s.stopped = false; // di-Start lagi

  if (fs.existsSync(PAUSE_FILE)) return;
  if (s.pausedUntil && now < s.pausedUntil) return;
  if (sinceLaunch < cfg.launchSettleMs) return; // baru relaunch → kasih waktu Roblox boot

  // PAKSA (web Rejoin / Join server / signal): relaunch walau online/suppress.
  if (forced) {
    s.retries = (s.retries || 0) + 1;
    if (s.retries > cfg.maxRetries) {
      s.pausedUntil = now + cfg.backoffMs;
      s.retries = 0;
      log(`[${disp(acc)}] gagal ${cfg.maxRetries}x — istirahat ${Math.round(cfg.backoffMs / 60000)} menit`);
      return;
    }
    s.offlineSince = 0;
    await doRelaunch(cfg, acc, session, s, joinCode ? "join server trade" : "perintah relog", joinCode);
    return;
  }

  const alive = await isRunning(acc.package || "com.roblox.client");
  if (alive) { s.deadSince = 0; s.everAlive = true; }

  // PROSES MATI (ketutup/crash) → relaunch. Berlaku juga pas lagi hop/suppress.
  if (!alive) {
    // Konfirmasi 45s CUMA kalau proses PERNAH hidup (transisi hop bisa bikin ilang sesaat).
    // Kalau dari awal mati (cold start / Roblox emang ketutup) → langsung buka, ga nunggu.
    if (suppressed && s.everAlive) {
      if (!s.deadSince) { s.deadSince = now; return; }
      if (now - s.deadSince < cfg.deadConfirmMs) return;
    }
    s.deadSince = 0;
    s.retries = (s.retries || 0) + 1;
    if (s.retries > cfg.maxRetries) {
      s.pausedUntil = now + cfg.backoffMs;
      s.retries = 0;
      log(`[${disp(acc)}] gagal ${cfg.maxRetries}x — istirahat ${Math.round(cfg.backoffMs / 60000)} menit`);
      return;
    }
    log(`[${disp(acc)}] Roblox mati (ketutup/crash) → buka ulang`);
    s.offlineSince = 0;
    await doRelaunch(cfg, acc, session, s, "Roblox mati");
    return;
  }

  // PROSES HIDUP + lagi teleport/hop (sniper) → biarin, jgn ganggu.
  if (suppressed) {
    s.offlineSince = 0;
    if (online) { s.retries = 0; s.pausedUntil = 0; }
    if (!s.hopLogged) { s.hopLogged = true; log(`[${disp(acc)}] lagi pindah server — agent standby`); }
    return;
  }
  if (s.hopLogged) { s.hopLogged = false; log(`[${disp(acc)}] selesai pindah server`); }

  // sehat: online + proses hidup
  if (online) {
    if (s.offlineSince || s.retries) log(`[${disp(acc)}] online · server ${(session.jobId || "-").slice(0, 8)}`);
    s.offlineSince = 0;
    s.retries = 0;
    s.pausedUntil = 0;
    return;
  }

  // proses hidup tapi offline = lagi loading/join → sabar sampai patience
  if (!s.offlineSince) {
    s.offlineSince = now;
    log(`[${disp(acc)}] koneksi putus — cek dulu…`);
    return;
  }
  if (now - s.offlineSince < cfg.loadingPatienceMs) return; // masih wajar loading
  s.retries = (s.retries || 0) + 1;
  if (s.retries > cfg.maxRetries) {
    s.pausedUntil = now + cfg.backoffMs;
    s.retries = 0;
    log(`[${disp(acc)}] gagal ${cfg.maxRetries}x — istirahat ${Math.round(cfg.backoffMs / 60000)} menit`);
    return;
  }
  log(`[${disp(acc)}] nyangkut kelamaan → buka ulang`);
  s.offlineSince = 0;
  await doRelaunch(cfg, acc, session, s, "nyangkut kelamaan");
}

// ---------- main loop ----------
let running = true;
let netDown = false; // biar log "internet putus" ga spam tiap 5s
let noAcctWarned = false;
async function tick(cfg, deviceId) {
  let sessions, accounts;
  try {
    sessions = await fetchSessions(cfg);
    if (netDown) {
      netDown = false;
      log("📶 Internet HP balik — lanjut mantau");
    }
  } catch {
    if (!netDown) {
      netDown = true;
      log("📡 Internet HP putus — nunggu koneksi balik…");
    }
    return;
  }
  accounts = await fetchAccounts(cfg, deviceId);
  // dedupe per userId (hindari 2 entri userId sama saling berantem stop/relaunch).
  // prioritas yang enabled.
  const byUser = new Map();
  for (const a of accounts) {
    const ex = byUser.get(a.userId);
    if (!ex || (a.enabled !== false && ex.enabled === false)) byUser.set(a.userId, a);
  }
  accounts = [...byUser.values()];
  await reportDevice(cfg, deviceId, accounts);
  if (!accounts.length) {
    if (!noAcctWarned) {
      noAcctWarned = true;
      log("ℹ️ Belum ada akun buat device ini — tambah dari dashboard (menu Reconnect)");
    }
    return;
  }
  noAcctWarned = false;
  // deteksi lokal dulu (relaunch cepat walau heartbeat masih keliatan online)
  try {
    await checkLocalErrors(cfg, accounts, sessions);
  } catch (e) {
    log(`⚠️  error deteksi lokal: ${e.message}`);
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
  log("🚀 GAG Auto-Reconnect aktif");
  log(`📱 Device: ${deviceId} · cek tiap ${cfg.pollMs / 1000} detik`);

  if (!(await checkRoot())) {
    log("❌ Root belum aktif — kasih izin root ke Termux dulu, terus jalanin lagi");
    process.exit(1);
  }
  log("🔓 Root OK · siap mantau");
  lastLogEpoch = Date.now() / 1000; // baseline: abaikan log lama, cuma proses yang baru

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
