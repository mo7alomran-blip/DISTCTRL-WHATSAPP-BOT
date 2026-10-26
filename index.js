// بوت واتساب ذاتي الاستضافة (Baileys — يتصل بواتساب ويب مباشرة، بدون أي بوابة SaaS خارجية) — قناة
// احتياطية/موازية لبوابة Hermosa المستخدمة حاليًا بـDistCtrl، مو بديل لها (احتياطي فقط حسب طلب المالك).
//
// يحتاج مجلد الجلسة (auth_info) يبقى على تخزين دائم (Railway Volume) — بدونه أي إعادة نشر (redeploy)
// تفقد الربط بالكامل وتحتاج مسح QR من جديد.
import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  areJidsSameUser,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // فاضي = أي حد يقدر يرسل عبر /send — لازم تُضبط قبل أي استخدام حقيقي
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

let sock = null;
let latestQr = null; // آخر QR كود بانتظار المسح (data URL) — null لو متصل أو لسه ما توفر
let connectionStatus = "starting"; // starting | qr_pending | connected | disconnected

// ── أحداث إضافة/إخراج الرقم من القروبات (طلب المالك 2026-10-26: "توصلني تنبيه انه تم اضافتك في القروب ومن
// الشخص الذي اضافه") — البوت يسجّلها فقط، وDistCtrl يسحبها عبر GET /group-events ويطابق الرقم مع الموظفين
// ويرسل التنبيه للمالك. تُحفظ بملف داخل الـVolume حتى ما تضيع مع إعادة النشر (آخر 300 حدث) ──
const EVENTS_FILE = path.join(AUTH_DIR, "group-events.json");
const MAX_EVENTS = 300;
let groupEvents = [];
try { groupEvents = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")); } catch { groupEvents = []; }
const groupNames = new Map(); // jid → اسم القروب (لازم للإخراج: بعده ما نقدر نجيب بيانات القروب)
const recentEventKeys = new Map(); // "action|jid" → وقت آخر تسجيل (منع التكرار)

function saveEvents() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(groupEvents.slice(-MAX_EVENTS)));
  } catch (e) { console.error("saveEvents failed:", e.message); }
}

const phoneOf = (jid) => (jid && String(jid).endsWith("@s.whatsapp.net") ? String(jid).split("@")[0].split(":")[0] : null);

async function recordGroupEvent({ action, groupId, author, authorPn }) {
  // نفس الحدث يوصل أحيانًا مرتين (إشعار + رسالة نظام) — نتجاهل التكرار خلال دقيقتين
  // (الفحص والحجز متزامنين قبل أي await — وإلا نسختين متزامنتين تعدّي الفحص قبل ما تُسجَّل الأولى)
  const now = Date.now();
  const dupKey = `${action}|${groupId}`;
  if (now - (recentEventKeys.get(dupKey) || 0) < 120000) return;
  recentEventKeys.set(dupKey, now);
  let name = groupNames.get(groupId) || null;
  if (action === "add" || !name) {
    try { const meta = await sock.groupMetadata(groupId); name = meta?.subject || name; if (name) groupNames.set(groupId, name); } catch { /* بعد الإخراج ما تتوفر البيانات */ }
  }
  let pn = phoneOf(authorPn) || phoneOf(author);
  if (!pn && author && String(author).endsWith("@lid")) {
    try { pn = phoneOf(await sock.signalRepository.lidMapping.getPNForLID(author)); } catch { /* غير معروف */ }
  }
  const byMe = !!(author && sock.user && (areJidsSameUser(author, sock.user.id) || areJidsSameUser(author, sock.user.lid)));
  const ev = { id: `${now}-${crypto.randomBytes(3).toString("hex")}`, at: new Date(now).toISOString(), action, group_id: groupId, group_name: name, author_phone: pn, author_jid: author || null, by_me: byMe };
  groupEvents.push(ev);
  if (groupEvents.length > MAX_EVENTS) groupEvents = groupEvents.slice(-MAX_EVENTS);
  saveEvents();
  console.log("group event:", JSON.stringify({ action, group_id: groupId, group_name: name }));
}

const isMe = (p) => {
  if (!sock?.user) return false;
  const ids = typeof p === "string" ? [p] : [p?.id, p?.phoneNumber, p?.lid, p?.jid];
  return ids.some((j) => j && (areJidsSameUser(j, sock.user.id) || (sock.user.lid && areJidsSameUser(j, sock.user.lid))));
};

function normalizeToJid(raw) {
  const str = String(raw || "").trim();
  if (str.includes("@")) return str; // JID جاهز أصلاً (فرد أو قروب)
  let digits = str.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "966" + digits.slice(1); // افتراضي السعودية، نفس منطق whatsapp.js بـDistCtrl
  if (!digits.startsWith("966") && digits.length <= 10) digits = "966" + digits;
  return `${digits}@s.whatsapp.net`;
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // إضافة/إخراج رقم البوت نفسه من قروب (أي مشارك ثاني يُتجاهل)
  sock.ev.on("group-participants.update", ({ id, author, authorPn, participants, action }) => {
    if (!["add", "remove"].includes(action) || !(participants || []).some(isMe)) return;
    recordGroupEvent({ action, groupId: id, author, authorPn }).catch((e) => console.error("recordGroupEvent:", e.message));
  });
  // قروب جديد أنشأه شخص وضمّ الرقم فيه مباشرة
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups || []) {
      if (g?.id && g.subject) groupNames.set(g.id, g.subject);
      if (g?.author || g?.authorPn) recordGroupEvent({ action: "add", groupId: g.id, author: g.author, authorPn: g.authorPn }).catch(() => {});
    }
  });
  sock.ev.on("groups.update", (updates) => {
    for (const u of updates || []) if (u?.id && u.subject) groupNames.set(u.id, u.subject);
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = await qrcode.toDataURL(qr);
      connectionStatus = "qr_pending";
      console.log("QR جديد جاهز — افتح / لمسحه من جوالك");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQr = null;
      console.log("✅ واتساب متصل");
      // أسماء القروبات الحالية — حتى لو انطرد الرقم لاحقًا نعرف اسم القروب بالتنبيه
      sock.groupFetchAllParticipating().then((all) => { for (const g of Object.values(all || {})) groupNames.set(g.id, g.subject); }).catch(() => {});
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log("انقطع الاتصال:", statusCode, loggedOut ? "(تسجيل خروج — نمسح الجلسة القديمة ونبدأ من جديد لـQR جديد)" : "(محاولة إعادة اتصال تلقائية)");
      latestQr = null;
      if (loggedOut) {
        // جلسة تسجيل الخروج القديمة صارت غير صالحة — لازم نمسحها قبل إعادة المحاولة، وإلا Baileys يحاول
        // يستخدمها من جديد ويفشل بصمت (البوت كان يعلق هنا للأبد قبل هذا الإصلاح، بدون أي محاولة تعافي تلقائية)
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        saveEvents(); // سجل أحداث القروبات مو جزء من الجلسة — نرجّعه بعد المسح
      }
      startSock().catch((e) => console.error("فشل إعادة الاتصال:", e));
    }
  });
}

startSock().catch((e) => console.error("فشل بدء تشغيل الجلسة:", e));

const app = express();
app.use(express.json());

// صفحة بسيطة تعرض QR أو حالة الاتصال — تتحدث تلقائيًا كل 3 ثواني لحد ما يصير الربط
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (connectionStatus === "connected") {
    return res.send(`<!doctype html><html dir="rtl"><body style="font-family:Arial;text-align:center;padding:60px;">
      <h1 style="color:#0f766e;">✅ واتساب متصل</h1><p>البوت جاهز يستقبل طلبات إرسال.</p></body></html>`);
  }
  if (latestQr) {
    return res.send(`<!doctype html><html dir="rtl"><head><meta http-equiv="refresh" content="20"></head>
      <body style="font-family:Arial;text-align:center;padding:40px;">
      <h2>امسح الكود من واتساب (الأجهزة المرتبطة ← ربط جهاز)</h2>
      <img src="${latestQr}" style="width:280px;height:280px;" />
      <p style="color:#64748b;">الصفحة تتحدث كل 20 ثانية تلقائيًا</p></body></html>`);
  }
  res.send(`<!doctype html><html dir="rtl"><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:Arial;text-align:center;padding:60px;"><h2>جارٍ التحضير...</h2></body></html>`);
});

app.get("/status", (_req, res) => res.json({ status: connectionStatus }));

// يتحقق هل رقم مسجّل فعليًا بواتساب — مفيد لتشخيص "الرسالة ما توصل" (رقم غلط/مو مسجّل أصلاً، مو مشكلة نظام)
app.get("/check", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  if (connectionStatus !== "connected") {
    return res.status(503).json({ success: false, error: "not_connected" });
  }
  const jid = normalizeToJid(req.query.phone);
  if (!jid) return res.status(400).json({ success: false, error: "invalid_input" });
  try {
    const result = await sock.onWhatsApp(jid);
    res.json({ success: true, exists: !!(result?.[0]?.exists), jid: result?.[0]?.jid || null });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// يسرد كل القروبات اللي الرقم المرتبط عضو فيها — مطلوب لأن /send للقروب يحتاج JID (شكله xxxx@g.us)
// مو اسم القروب، وما فيه طريقة ثانية تجيبه غير من هنا
app.get("/groups", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  if (connectionStatus !== "connected") {
    return res.status(503).json({ success: false, error: "not_connected" });
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => ({ id: g.id, name: g.subject }));
    res.json({ success: true, groups: list });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// سجل إضافة/إخراج الرقم من القروبات (الأحدث آخرًا) — يسحبه DistCtrl دوريًا ويتجاهل اللي سبق عالجه (by id)
app.get("/group-events", (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  res.json({ success: true, events: groupEvents.slice(-MAX_EVENTS) });
});

// إرسال رسالة نصية — محمي بمفتاح مشترك (x-api-key) حتى ما يقدر أي حد يستخدم الرقم المرتبط للإرسال
app.post("/send", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  if (connectionStatus !== "connected") {
    return res.status(503).json({ success: false, error: "not_connected" });
  }
  const { to, message } = req.body || {};
  const jid = normalizeToJid(to);
  if (!jid || !message) return res.status(400).json({ success: false, error: "invalid_input" });
  try {
    const result = await sock.sendMessage(jid, { text: message });
    console.log("send result for", jid, ":", JSON.stringify(result));
    res.json({ success: true, messageId: result?.key?.id || null, remoteJid: result?.key?.remoteJid || null });
  } catch (err) {
    console.error("send error for", jid, ":", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// إرسال مرفق (PDF غالبًا) عبر رابط عام مباشر — Baileys يقدر يجيب المحتوى بنفسه من mediaUrl بدون ما نمرّر
// البايتات له. مطلوب خصوصًا لمرفقات القروبات: DistCtrl (whatsapp.js/sendWhatsAppMediaUrl) يوصل PDF
// للأفراد فقط عبر بوابة Hermosa؛ رقم Hermosa مو عضو بقروبات العمل الفعلية، فأي مرفق "لقروب" كان
// يفشل بصمت قبل هذا الراوت (نفس فكرة /send النصي — القروبات لازم تمر من هنا، رقم Hermosa ما يقدر يوصلها).
app.post("/send-media", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  if (connectionStatus !== "connected") {
    return res.status(503).json({ success: false, error: "not_connected" });
  }
  const { to, mediaUrl, caption, filename, mimetype } = req.body || {};
  const jid = normalizeToJid(to);
  if (!jid || !mediaUrl) return res.status(400).json({ success: false, error: "invalid_input" });
  try {
    const result = await sock.sendMessage(jid, {
      document: { url: mediaUrl },
      mimetype: mimetype || "application/pdf",
      fileName: filename || "file.pdf",
      caption: caption || undefined,
    });
    console.log("send-media result for", jid, ":", JSON.stringify(result));
    res.json({ success: true, messageId: result?.key?.id || null, remoteJid: result?.key?.remoteJid || null });
  } catch (err) {
    console.error("send-media error for", jid, ":", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log(`DistCtrl WhatsApp bot listening on :${PORT}`));
