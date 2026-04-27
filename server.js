import express from "express";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || process.env.AUTH_TOKEN || "123456";
const AUTH_DIR = path.resolve("./auth");

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneNumber = null;
let starting = false;
let consecutiveErrors = 0;
let lastErrorCode = null;

function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function clearAuthDir() {
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log("🗑️  auth/ limpa");
  } catch (e) { console.error("clearAuthDir:", e); }
}

async function startSock() {
  if (starting) return;
  starting = true;
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["NotifyZap", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log("[update]", { connection, hasQr: !!qr, err: lastDisconnect?.error?.message });

      if (qr) {
        try {
          currentQR = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", width: 320, margin: 1 });
          consecutiveErrors = 0;
          console.log("✅ QR gerado");
        } catch (e) { console.error("QR err:", e); }
      }

      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        consecutiveErrors = 0;
        phoneNumber = sock?.user?.id?.split(":")[0] || null;
        console.log("✅ Conectado:", phoneNumber);
      }

      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastErrorCode = code;
        const loggedOut = code === DisconnectReason.loggedOut;
        sock = null;

        // Auto-recovery: se der 405 várias vezes, limpa auth/
        if (code === 405) {
          consecutiveErrors++;
          console.log(`❌ Erro 405 (${consecutiveErrors}x consecutivos)`);
          if (consecutiveErrors >= 3) {
            console.log("🔄 Auto-reset: limpando auth/ por loop de 405");
            clearAuthDir();
            consecutiveErrors = 0;
            setTimeout(() => startSock().catch(console.error), 5000);
            return;
          }
        }

        if (!loggedOut) {
          setTimeout(() => startSock().catch(console.error), 2000);
        }
      }
    });
  } catch (err) {
    console.error("startSock:", err);
  } finally {
    starting = false;
  }
}

app.get("/", (_req, res) => res.json({ ok: true, connected: isConnected }));

app.get("/status", checkAuth, (_req, res) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    hasQr: !!currentQR,
    lastErrorCode,
    consecutiveErrors,
  });
});

app.post("/session/start", checkAuth, async (_req, res) => {
  if (isConnected) return res.json({ connected: true, qr: null, phone: phoneNumber });
  if (!sock) startSock().catch(console.error);

  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (isConnected) return res.json({ connected: true, qr: null, phone: phoneNumber });
    if (currentQR) return res.json({ connected: false, qr: currentQR });
    await new Promise((r) => setTimeout(r, 500));
  }

  res.json({
    connected: false,
    qr: currentQR,
    error: !currentQR && lastErrorCode === 405
      ? "Baileys em loop de erro 405 — auth/ provavelmente corrompido"
      : !currentQR ? "Aguardando geração do QR" : null,
  });
});

app.post("/session/reset", checkAuth, async (_req, res) => {
  console.log("🔄 Reset manual solicitado");
  try {
    if (sock) { try { sock.end(); } catch (_) {} sock = null; }
    isConnected = false;
    currentQR = null;
    phoneNumber = null;
    consecutiveErrors = 0;
    lastErrorCode = null;
    clearAuthDir();
    setTimeout(() => startSock().catch(console.error), 1000);
    res.json({ ok: true, message: "Sessão resetada" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send", checkAuth, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!isConnected || !sock) return res.status(400).json({ error: "WhatsApp não conectado" });
  if (!phone || !message) return res.status(400).json({ error: "phone e message obrigatórios" });
  try {
    const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Bridge na porta ${PORT}`);
  startSock().catch(console.error);
});
