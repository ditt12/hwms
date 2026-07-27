/**
 * index.js — Telegram Userbot + Panel Bot (All-in-One)
 * ======================================================
 * Jalankan: node index.js
 *
 * Satu proses menjalankan:
 *  - GramJS userbot (akun pribadi) → auto-reply channel + PM + broadcast
 *  - node-telegram-bot-api panel   → inline button kontrol via @bot
 *
 * Setup:
 *  1. Jalankan pertama kali → wizard setup otomatis
 *  2. Isi bot_token dari @BotFather di config.json
 *  3. node index.js
 */
"use strict";

const fs        = require("fs");
const path      = require("path");
const readline  = require("readline");
const TelegramBot            = require("node-telegram-bot-api");
const { TelegramClient }     = require("telegram");
const { StringSession }      = require("telegram/sessions");
const { NewMessage }         = require("telegram/events");

const CONFIG_PATH = path.join(__dirname, "config.json");

// ──────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!c.blacklist) c.blacklist = [];
  if (!c.pm) c.pm = { enabled: true, message: "Halo! Saya sedang sibuk 🙏", cooldown_seconds: 300 };
  return c;
}
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8"); }

// ──────────────────────────────────────────────────────────
// HELPER INPUT (wizard)
// ──────────────────────────────────────────────────────────

function createRL() { return readline.createInterface({ input: process.stdin, output: process.stdout }); }
function question(rl, p) { return new Promise(r => rl.question(p, a => r(a.trim()))); }
function hiddenQuestion(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      const rl = createRL(); rl.question(prompt, a => { rl.close(); resolve(a.trim()); }); return;
    }
    let input = ""; process.stdout.write(prompt);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    const fn = c => {
      if (c === "\n" || c === "\r" || c === "\u0004") {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", fn);
        process.stdout.write("\n"); resolve(input.trim());
      } else if (c === "\u0003") { process.exit(1);
      } else if (c === "\u007f") { input = input.slice(0, -1);
      } else { input += c; }
    };
    process.stdin.on("data", fn);
  });
}
async function ask(rl, p, d = null) {
  const suf = d != null ? ` [${d}]` : "";
  while (true) {
    const v = await question(rl, `${p}${suf}: `);
    if (!v && d != null) return d; if (v) return v;
    console.log("  -> Wajib diisi.");
  }
}
async function askYN(rl, p, d = true) {
  const v = (await question(rl, `${p} (${d?"Y/n":"y/N"}): `)).toLowerCase();
  return !v ? d : v === "y" || v === "ya";
}
async function askInt(rl, p, d) {
  const v = await question(rl, `${p} [${d}]: `); if (!v) return d;
  const n = parseInt(v, 10); return isNaN(n) ? d : n;
}

// ──────────────────────────────────────────────────────────
// SETUP WIZARD
// ──────────────────────────────────────────────────────────

async function runSetupWizard() {
  console.log("=".repeat(55));
  console.log(" SETUP WIZARD");
  console.log("=".repeat(55) + "\n");
  const rl = createRL();

  console.log("--- Userbot (akun pribadi) ---");
  console.log("API ID & Hash dari https://my.telegram.org");
  let apiId = await askInt(rl, "API ID", 0);
  while (!apiId) apiId = await askInt(rl, "API ID (wajib)", 0);
  const apiHash = await ask(rl, "API Hash");
  const phone   = await ask(rl, "Nomor telepon (+62...)");
  const session = await ask(rl, "Nama file session", "userbot_session");

  console.log("\n--- Panel Bot (@BotFather) ---");
  console.log("Buat bot di @BotFather, ambil token-nya.");
  const botToken = await ask(rl, "Bot Token (bisa diisi nanti di config.json)");

  console.log("\n--- Keyword & Balasan ---");
  const keywords = []; let idx = 1;
  while (true) {
    console.log(`\n  Keyword #${idx} (ketik 'selesai' untuk selesai)`);
    const kw = await ask(rl, "  Keyword alias (pisah koma)", null, false);
    if (!kw || kw.toLowerCase() === "selesai") { if (!keywords.length) { console.log("  Minimal 1."); continue; } break; }
    const rep = await ask(rl, "  Balasan");
    keywords.push({ aliases: kw.split(",").map(k => k.trim().toLowerCase()).filter(Boolean), reply: rep });
    idx++;
  }

  console.log("\n--- Opsi ---");
  let matchMode = await ask(rl, "Mode 'contains' / 'exact'", "contains");
  if (!["contains","exact"].includes(matchMode)) matchMode = "contains";

  const config = {
    api_id: apiId, api_hash: apiHash, phone, session_name: session,
    bot_token: botToken,
    keywords, blacklist: [],
    pm: { enabled: true, message: "Halo! Saya sedang sibuk 🙏", cooldown_seconds: 300 },
    match_mode: matchMode, case_sensitive: false,
    cooldown_seconds: await askInt(rl, "Cooldown post channel (detik)", 30),
    only_first_match: await askYN(rl, "Hanya match keyword pertama?", true),
    quote_reply: await askYN(rl, "Reply sebagai quote?", true),
    poll_interval: await askInt(rl, "Interval polling (detik)", 3),
    // state disimpan inline di config
    autoReply: true,
    pmReply: true,
    broadcast: null,
  };
  rl.close();
  saveConfig(config);
  console.log(`\nKonfigurasi tersimpan.\n`);
  return config;
}

// ──────────────────────────────────────────────────────────
// MATCHING
// ──────────────────────────────────────────────────────────

function isBlacklisted(text, blacklist, cs) {
  if (!blacklist?.length) return false;
  const hay = cs ? text : text.toLowerCase();
  return blacklist.some(w => hay.includes(cs ? w : w.toLowerCase()));
}
function findReply(text, keywords, mode, cs, onlyFirst) {
  if (!text) return null;
  const hay = cs ? text : text.toLowerCase();
  const out = [];
  for (const kw of keywords) {
    for (const alias of kw.aliases) {
      const n = cs ? alias : alias.toLowerCase();
      const found = mode === "exact" ? hay.split(/\s+/).includes(n) : hay.includes(n);
      if (found) { out.push(kw.reply); break; }
    }
  }
  return out.length ? (onlyFirst ? out[0] : out.join("\n")) : null;
}

// ──────────────────────────────────────────────────────────
// SESSION
// ──────────────────────────────────────────────────────────

function sessionPath(name) { return path.join(__dirname, `${name}.session`); }
function loadSession(name) {
  const p = sessionPath(name);
  if (!fs.existsSync(p)) return undefined;
  const s = fs.readFileSync(p, "utf-8").trim();
  return s.length ? s : undefined;
}
function saveSession(name, str) { fs.writeFileSync(sessionPath(name), str, "utf-8"); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────
// PANEL KEYBOARD & TEXT BUILDERS
// ──────────────────────────────────────────────────────────

function mainKeyboard(cfg) {
  const ar = cfg.autoReply ? "🟢 AR Channel ON"  : "🔴 AR Channel OFF";
  const pm = cfg.pmReply   ? "🟢 AR PM ON"       : "🔴 AR PM OFF";
  const bc = cfg.broadcast ? "⏹ Stop Broadcast"  : "📢 Broadcast";
  return { inline_keyboard: [
    [{ text: ar, callback_data: "toggle_ar" }, { text: pm, callback_data: "toggle_pm" }],
    [{ text: `🔑 Keyword (${cfg.keywords.length})`, callback_data: "menu_kw" },
     { text: `🚫 Blacklist (${cfg.blacklist.length})`, callback_data: "menu_bl" }],
    [{ text: bc, callback_data: cfg.broadcast ? "bc_stop" : "bc_menu" },
     { text: "⚙️ Setting PM", callback_data: "menu_pm" }],
    [{ text: "🔄 Refresh", callback_data: "refresh" }],
  ]};
}

function mainText(cfg) {
  const ar = cfg.autoReply ? "🟢 ON" : "🔴 OFF";
  const pm = cfg.pmReply   ? "🟢 ON" : "🔴 OFF";
  const bc = cfg.broadcast ? `🔁 tiap ${cfg.broadcast.intervalSec}s` : "off";
  return `🤖 *BOT PANEL*\n\n📨 AR Channel : ${ar}\n💬 AR PM      : ${pm}\n📢 Broadcast  : ${bc}\n🔑 Keywords   : ${cfg.keywords.length}\n🚫 Blacklist  : ${cfg.blacklist.length} kata`;
}

function kwKeyboard(keywords, page = 0) {
  const PAGE = 5, start = page * PAGE;
  const rows = keywords.slice(start, start + PAGE).map((kw, i) => [{
    text: `🗑 #${start+i+1} ${kw.aliases.join(",")}`, callback_data: `kw_del_${start+i}`
  }]);
  const nav = [];
  if (page > 0)                         nav.push({ text: "◀", callback_data: `kw_page_${page-1}` });
  if (start + PAGE < keywords.length)   nav.push({ text: "▶", callback_data: `kw_page_${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "➕ Tambah Keyword", callback_data: "kw_add_prompt" }]);
  rows.push([{ text: "« Kembali", callback_data: "back_main" }]);
  return { inline_keyboard: rows };
}
function kwText(keywords, page = 0) {
  const PAGE = 5, start = page * PAGE;
  if (!keywords.length) return "🔑 *Keyword* — Belum ada";
  let t = `🔑 *Keyword* (${keywords.length})\n\n`;
  keywords.slice(start, start + PAGE).forEach((kw, i) => {
    const rep = kw.reply.length > 50 ? kw.reply.slice(0, 47) + "…" : kw.reply;
    t += `${start+i+1}\\. \`${kw.aliases.join(", ")}\`\n   ↪ ${rep}\n\n`;
  });
  return t.trim();
}

function blKeyboard(blacklist, page = 0) {
  const PAGE = 8, start = page * PAGE;
  const rows = [];
  const slice = blacklist.slice(start, start + PAGE);
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: `🗑 ${slice[i]}`, callback_data: `bl_del_${start+i}` }];
    if (slice[i+1]) row.push({ text: `🗑 ${slice[i+1]}`, callback_data: `bl_del_${start+i+1}` });
    rows.push(row);
  }
  const nav = [];
  if (page > 0)                         nav.push({ text: "◀", callback_data: `bl_page_${page-1}` });
  if (start + PAGE < blacklist.length)  nav.push({ text: "▶", callback_data: `bl_page_${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "➕ Tambah Blacklist", callback_data: "bl_add_prompt" }]);
  rows.push([{ text: "« Kembali", callback_data: "back_main" }]);
  return { inline_keyboard: rows };
}
function blText(blacklist, page = 0) {
  const PAGE = 8, start = page * PAGE;
  if (!blacklist.length) return "🚫 *Blacklist* — Belum ada";
  let t = `🚫 *Blacklist* (${blacklist.length} kata)\n\n`;
  blacklist.slice(start, start + PAGE).forEach((w, i) => { t += `${start+i+1}\\. \`${w}\`\n`; });
  return t.trim();
}

function pmKeyboard(cfg) {
  const tog = cfg.pmReply ? "🔴 Matikan AR PM" : "🟢 Nyalakan AR PM";
  return { inline_keyboard: [
    [{ text: tog, callback_data: "toggle_pm" }],
    [{ text: "✏️ Ubah Pesan Balasan", callback_data: "pm_msg_prompt" }],
    [{ text: "⏱ Ubah Cooldown", callback_data: "pm_cd_prompt" }],
    [{ text: "« Kembali", callback_data: "back_main" }],
  ]};
}
function pmText(cfg) {
  const status   = cfg.pmReply && cfg.pm.enabled ? "🟢 ON" : "🔴 OFF";
  const cooldown = cfg.pm.cooldown_seconds > 0 ? `${cfg.pm.cooldown_seconds}s / user` : "off";
  return `💬 *Auto Reply PM*\n\nStatus   : ${status}\nCooldown : ${cooldown}\n\n*Pesan balasan:*\n${cfg.pm.message}`;
}

function bcKeyboard() {
  return { inline_keyboard: [
    [{ text: "📤 Broadcast Sekali",   callback_data: "bc_once_prompt" }],
    [{ text: "🔁 Broadcast Berulang", callback_data: "bc_loop_prompt" }],
    [{ text: "« Kembali", callback_data: "back_main" }],
  ]};
}

// ──────────────────────────────────────────────────────────
// USERBOT CLASS
// ──────────────────────────────────────────────────────────

class Userbot {
  constructor() {
    this.config      = loadConfig();
    this.seenMsgIds  = new Map();
    this.lastReply   = new Map();
    this.pmLastReply = new Map();
    this.bcTimer     = null;
  }

  reloadConfig() { this.config = loadConfig(); }

  cooldownOk(map, key, ms) {
    const last = map.get(key) || 0;
    if (Date.now() - last < ms) return false;
    map.set(key, Date.now()); return true;
  }

  isChannelPost(msg) { return msg.fwdFrom?.fromId?.className === "PeerChannel"; }
  isPrivateMsg(msg)  { return msg.peerId?.className === "PeerUser"; }

  async getGroups() {
    try {
      const d = await this.client.getDialogs({ limit: 200 });
      return d.filter(x => x.entity?.className === "Channel" && x.entity?.megagroup).map(x => x.id);
    } catch { return []; }
  }

  syncBroadcast() {
    if (this.bcTimer) { clearInterval(this.bcTimer); this.bcTimer = null; }
    const bc = this.config.broadcast;
    if (!bc || !bc.intervalSec) return;
    this.bcTimer = setInterval(() => this.doBroadcast(bc.text), bc.intervalSec * 1000);
    console.log(`[BC] Aktif tiap ${bc.intervalSec}s`);
  }

  async doBroadcast(text) {
    const groups = await this.getGroups();
    let sent = 0, fail = 0;
    for (const id of groups) {
      try { await this.client.sendMessage(id, { message: text }); sent++; await sleep(1500); }
      catch { fail++; }
    }
    console.log(`[BC] sent=${sent} fail=${fail}`);
  }

  async startPolling() {
    const ms = (this.config.poll_interval || 3) * 1000;
    const groups = await this.getGroups();
    console.log(`[POLL] ${groups.length} grup, interval ${this.config.poll_interval || 3}s`);
    for (const id of groups) {
      try {
        const msgs = await this.client.getMessages(id, { limit: 5 });
        this.seenMsgIds.set(id.toString(), new Set(msgs.map(m => m.id)));
      } catch (_) {}
    }
    while (true) {
      await sleep(ms);
      this.reloadConfig();
      if (!this.config.autoReply) continue;
      for (const id of await this.getGroups()) {
        try { await this.pollChat(id); } catch (e) { console.log(`[POLL ERR] ${e.message}`); }
      }
    }
  }

  async pollChat(chatId) {
    const key  = chatId.toString();
    const seen = this.seenMsgIds.get(key) || new Set();
    const msgs = await this.client.getMessages(chatId, { limit: 10 });
    for (const m of msgs.filter(m => !seen.has(m.id)).reverse()) {
      seen.add(m.id);
      await this.processChannelMsg(chatId, m);
    }
    if (seen.size > 200) {
      const arr = [...seen]; this.seenMsgIds.set(key, new Set(arr.slice(-200)));
    } else { this.seenMsgIds.set(key, seen); }
  }

  async processChannelMsg(chatId, msg) {
    if (!this.isChannelPost(msg)) return;
    if (!this.cooldownOk(this.lastReply, `${chatId}:${msg.id}`, (this.config.cooldown_seconds || 30) * 1000)) return;
    const text = msg.message || "";
    if (isBlacklisted(text, this.config.blacklist, this.config.case_sensitive)) return;
    const rep = findReply(text, this.config.keywords, this.config.match_mode || "contains",
      this.config.case_sensitive || false, this.config.only_first_match !== false);
    if (!rep) return;
    console.log(`[MATCH] chat=${chatId} post=${msg.id}`);
    try {
      await this.client.sendMessage(chatId, { message: rep, ...(this.config.quote_reply !== false ? { replyTo: msg.id } : {}) });
      console.log(`[SENT] chat=${chatId} post=${msg.id}`);
    } catch (e) { console.log(`[ERR] ${e.message}`); }
  }

  async handlePM(event) {
    const msg = event.message;
    if (!this.isPrivateMsg(msg) || msg.out) return;
    if (!this.config.pmReply || !this.config.pm.enabled) return;
    const uid = msg.senderId?.toString() || msg.peerId?.userId?.toString();
    if (!uid || uid === this.myId?.toString()) return;
    if (!this.cooldownOk(this.pmLastReply, uid, (this.config.pm.cooldown_seconds || 0) * 1000)) return;
    try {
      await this.client.sendMessage(msg.peerId, { message: this.config.pm.message, replyTo: msg.id });
      console.log(`[PM] Replied to ${uid}`);
    } catch (e) { console.log(`[PM ERR] ${e.message}`); }
  }

  async start() {
    const ss = loadSession(this.config.session_name);
    this.client = new TelegramClient(
      ss ? new StringSession(ss) : new StringSession(),
      this.config.api_id, this.config.api_hash, { connectionRetries: 5 }
    );
    await this.client.start({
      phoneNumber: async () => this.config.phone,
      password:    async () => hiddenQuestion("Password 2FA: "),
      phoneCode:   async () => { const rl = createRL(); const c = await question(rl, "OTP: "); rl.close(); return c; },
      onError: e => console.log("[LOGIN ERR]", e.message),
    });
    saveSession(this.config.session_name, this.client.session.save());
    const me = await this.client.getMe();
    this.myId = me.id;
    console.log(`[USERBOT] Login: ${me.firstName} (@${me.username || "-"})`);
    this.client.addEventHandler(this.handlePM.bind(this), new NewMessage({ incoming: true }));
    this.syncBroadcast();
    this.startPolling().catch(e => { console.error("[POLL FATAL]", e.message); process.exit(1); });
  }
}

// ──────────────────────────────────────────────────────────
// PANEL BOT
// ──────────────────────────────────────────────────────────

function startPanel(userbot) {
  const cfgData = loadConfig();
  const BOT_TOKEN = process.env.BOT_TOKEN || cfgData.bot_token;
  if (!BOT_TOKEN || BOT_TOKEN.length < 10) {
    console.log("[PANEL] bot_token tidak ada di config.json — panel dinonaktifkan.");
    console.log("[PANEL] Tambahkan \"bot_token\": \"xxx:xxx\" di config.json lalu restart.");
    return;
  }

  const bot      = new TelegramBot(BOT_TOKEN, { polling: true });
  const awaiting = new Map(); // chatId -> { type, extra }

  bot.getMe().then(me => {
    console.log(`[PANEL] Bot aktif: @${me.username} — kirim /start ke bot untuk buka panel`);
  }).catch(e => {
    console.error("[PANEL] Token tidak valid:", e.message);
  });

  bot.on("polling_error", e => console.error("[PANEL ERR]", e.code, e.message));

  // ── helpers ──
  function getConfig() { return loadConfig(); }

  async function sendMain(chatId) {
    const c = getConfig();
    return bot.sendMessage(chatId, mainText(getConfig()), {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(c),
    }).catch(e => {
      console.error("[SEND ERR]", e.message);
      return bot.sendMessage(chatId, mainText(c).replace(/[*_`\\]/g, ""), { reply_markup: mainKeyboard(c) });
    });
  }

  async function editMain(chatId, msgId) {
    const c = getConfig();
    await bot.editMessageText(mainText(c), {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", reply_markup: mainKeyboard(c),
    }).catch(() => sendMain(chatId));
  }

  // ── commands ──
  bot.onText(/\/start|\/panel/, async msg => {
    console.log(`[PANEL] /start dari ${msg.from?.username || msg.from?.id}`);
    await sendMain(msg.chat.id);
  });

  // ── callback handler ──
  bot.on("callback_query", async q => {
    const chatId = q.message.chat.id;
    const msgId  = q.message.message_id;
    const data   = q.data;
    await bot.answerCallbackQuery(q.id).catch(() => {});

    // toggle AR channel
    if (data === "toggle_ar") {
      const c = getConfig(); c.autoReply = !c.autoReply; saveConfig(c);
      userbot.reloadConfig();
      return editMain(chatId, msgId);
    }

    // toggle AR PM
    if (data === "toggle_pm") {
      const c = getConfig(); c.pmReply = !c.pmReply; saveConfig(c);
      userbot.reloadConfig();
      // kalau lagi di menu PM, update menu PM
      if (q.message.text?.includes("Auto Reply PM")) {
        return bot.editMessageText(pmText(c), {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown", reply_markup: pmKeyboard(c),
        }).catch(() => {});
      }
      return editMain(chatId, msgId);
    }

    // refresh
    if (data === "refresh") return editMain(chatId, msgId);

    // back
    if (data === "back_main") return editMain(chatId, msgId);

    // ── keyword menu ──
    if (data === "menu_kw" || data.startsWith("kw_page_")) {
      const page = data.startsWith("kw_page_") ? parseInt(data.split("_")[2]) : 0;
      const c = getConfig();
      return bot.editMessageText(kwText(c.keywords, page), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "MarkdownV2", reply_markup: kwKeyboard(c.keywords, page),
      }).catch(e => console.log("[KW ERR]", e.message));
    }

    if (data.startsWith("kw_del_")) {
      const c = getConfig(); const idx = parseInt(data.split("_")[2]);
      c.keywords.splice(idx, 1); saveConfig(c); userbot.reloadConfig();
      const page = Math.max(0, Math.floor(idx / 5) - (idx % 5 === 0 && idx > 0 ? 1 : 0));
      return bot.editMessageText(kwText(c.keywords, page), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "MarkdownV2", reply_markup: kwKeyboard(c.keywords, page),
      }).catch(() => {});
    }

    if (data === "kw_add_prompt") {
      awaiting.set(chatId, { type: "kw_add" });
      return bot.sendMessage(chatId,
        "✏️ Kirim keyword baru:\n\n`alias1,alias2 | pesan balasan`\n\nContoh:\n`harga,price | Harga ada di pinned ya 🙏`",
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    // ── blacklist menu ──
    if (data === "menu_bl" || data.startsWith("bl_page_")) {
      const page = data.startsWith("bl_page_") ? parseInt(data.split("_")[2]) : 0;
      const c = getConfig();
      return bot.editMessageText(blText(c.blacklist, page), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "MarkdownV2", reply_markup: blKeyboard(c.blacklist, page),
      }).catch(() => {});
    }

    if (data.startsWith("bl_del_")) {
      const c = getConfig(); const idx = parseInt(data.split("_")[2]);
      c.blacklist.splice(idx, 1); saveConfig(c); userbot.reloadConfig();
      const page = Math.max(0, Math.floor(idx / 8) - (idx % 8 === 0 && idx > 0 ? 1 : 0));
      return bot.editMessageText(blText(c.blacklist, page), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "MarkdownV2", reply_markup: blKeyboard(c.blacklist, page),
      }).catch(() => {});
    }

    if (data === "bl_add_prompt") {
      awaiting.set(chatId, { type: "bl_add" });
      return bot.sendMessage(chatId,
        "✏️ Kirim kata yang ingin di-blacklist (pisah koma):\n\n`kata1, kata2, kata3`",
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    // ── PM menu ──
    if (data === "menu_pm") {
      const c = getConfig();
      return bot.editMessageText(pmText(c), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown", reply_markup: pmKeyboard(c),
      }).catch(() => {});
    }

    if (data === "pm_msg_prompt") {
      const c = getConfig();
      awaiting.set(chatId, { type: "pm_msg" });
      return bot.sendMessage(chatId,
        `✏️ Kirim pesan balasan PM baru:\n\n*Saat ini:*\n${c.pm.message}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    if (data === "pm_cd_prompt") {
      const c = getConfig();
      awaiting.set(chatId, { type: "pm_cd" });
      return bot.sendMessage(chatId,
        `⏱ Kirim cooldown dalam detik (0 = off):\n\n*Saat ini:* ${c.pm.cooldown_seconds}s`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    // ── broadcast ──
    if (data === "bc_menu") {
      return bot.editMessageText("📢 *Broadcast* — Pilih jenis:", {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown", reply_markup: bcKeyboard(),
      }).catch(() => {});
    }

    if (data === "bc_stop") {
      const c = getConfig(); c.broadcast = null; saveConfig(c);
      userbot.reloadConfig(); userbot.syncBroadcast();
      await bot.sendMessage(chatId, "⏹ Broadcast dihentikan.");
      return editMain(chatId, msgId);
    }

    if (data === "bc_once_prompt") {
      awaiting.set(chatId, { type: "bc_once" });
      return bot.sendMessage(chatId, "✏️ Kirim pesan broadcast (sekali):",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    if (data === "bc_loop_prompt") {
      awaiting.set(chatId, { type: "bc_loop_text" });
      return bot.sendMessage(chatId, "✏️ Kirim pesan broadcast berulang:",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
    }

    if (data === "cancel") {
      awaiting.delete(chatId);
      return bot.sendMessage(chatId, "❌ Dibatalkan.");
    }
  });

  // ── text input handler ──
  bot.on("message", async msg => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const aw     = awaiting.get(chatId);
    if (!aw) return;

    awaiting.delete(chatId);
    const text = msg.text.trim();
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

    if (aw.type === "kw_add") {
      const sep = text.indexOf("|");
      if (sep === -1) { await bot.sendMessage(chatId, "⚠️ Format: `alias1,alias2 | balasan`", { parse_mode: "Markdown" }); return; }
      const aliases = text.slice(0, sep).trim().split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
      const reply   = text.slice(sep + 1).trim();
      if (!aliases.length || !reply) { await bot.sendMessage(chatId, "⚠️ Alias dan balasan tidak boleh kosong."); return; }
      const c = getConfig(); c.keywords.push({ aliases, reply }); saveConfig(c); userbot.reloadConfig();
      await bot.sendMessage(chatId, `✅ Keyword ditambahkan!\n\`${aliases.join(", ")}\`\n↪ ${reply}`, { parse_mode: "Markdown" });
      return;
    }

    if (aw.type === "bl_add") {
      const words = text.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
      const c = getConfig();
      const added = words.filter(w => !c.blacklist.includes(w));
      added.forEach(w => c.blacklist.push(w)); saveConfig(c); userbot.reloadConfig();
      await bot.sendMessage(chatId, added.length
        ? `✅ Ditambahkan: \`${added.join(", ")}\`\nTotal: ${c.blacklist.length} kata`
        : "ℹ️ Semua kata sudah ada.", { parse_mode: "Markdown" });
      return;
    }

    if (aw.type === "pm_msg") {
      const c = getConfig(); c.pm.message = text; saveConfig(c); userbot.reloadConfig();
      await bot.sendMessage(chatId, `✅ Pesan PM diperbarui:\n\n${text}`);
      return;
    }

    if (aw.type === "pm_cd") {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 0) { await bot.sendMessage(chatId, "⚠️ Harus angka ≥ 0."); return; }
      const c = getConfig(); c.pm.cooldown_seconds = n; saveConfig(c); userbot.reloadConfig();
      await bot.sendMessage(chatId, `✅ Cooldown PM: ${n > 0 ? n + "s / user" : "off"}`);
      return;
    }

    if (aw.type === "bc_once") {
      await bot.sendMessage(chatId, "📤 Mengirim broadcast...");
      await userbot.doBroadcast(text);
      await bot.sendMessage(chatId, "✅ Broadcast selesai.");
      return;
    }

    if (aw.type === "bc_loop_text") {
      awaiting.set(chatId, { type: "bc_loop_sec", text });
      await bot.sendMessage(chatId, "⏱ Kirim interval dalam detik (min 10):",
        { reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel" }]] } }
      );
      return;
    }

    if (aw.type === "bc_loop_sec") {
      const sec = parseInt(text, 10);
      if (isNaN(sec) || sec < 10) { await bot.sendMessage(chatId, "⚠️ Minimal 10 detik."); return; }
      const c = getConfig(); c.broadcast = { text: aw.text, intervalSec: sec }; saveConfig(c);
      userbot.reloadConfig(); userbot.syncBroadcast();
      await bot.sendMessage(chatId, `🔁 Broadcast tiap *${sec}* detik dimulai.`, { parse_mode: "Markdown" });
      return;
    }
  });
}

// ──────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) await runSetupWizard();
  const userbot = new Userbot();
  startPanel(userbot);
  await userbot.start();
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
