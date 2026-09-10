// بوت واتساب ذاتي الاستضافة (Baileys — يتصل بواتساب ويب مباشرة، بدون أي بوابة SaaS خارجية) — قناة
// احتياطية/موازية لبوابة Hermosa المستخدمة حاليًا بـDistCtrl، مو بديل لها (احتياطي فقط حسب طلب المالك).
//
// يحتاج مجلد الجلسة (auth_info) يبقى على تخزين دائم (Railway Volume) — بدونه أي إعادة نشر (redeploy)
// تفقد الربط بالكامل وتحتاج مسح QR من جديد.
import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // فاضي = أي حد يقدر يرسل عبر /send — لازم تُضبط قبل أي استخدام حقيقي
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

let sock = null;
let latestQr = null; // آخر QR كود بانتظار المسح (data URL) — null لو متصل أو لسه ما توفر
let connectionStatus = "starting"; // starting | qr_pending | connected | disconnected

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
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("send error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log(`DistCtrl WhatsApp bot listening on :${PORT}`));
