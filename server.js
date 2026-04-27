import express from "express";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import pino from "pino";

const PORT = process.env.PORT || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth_info_baileys";

if (!BRIDGE_TOKEN) {
  console.error("❌ BRIDGE_TOKEN não configurado");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Estado global
let sock = null;
let currentQr = null;
let connectionState = "disconnected"; // disconnected | connecting | connected
let lastError = null;

const logger = pino({ level: "info" });

// ==================== AUTENTICAÇÃO ====================
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${BRIDGE_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ==================== INICIALIZAÇÃO BAILEYS ====================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📱 Usando WhatsApp v${version.join(".")} (latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["NotifyZap", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log("[update]", {
      connection,
      hasQr: !!qr,
      err: lastDisconnect?.error?.message,
    });

    if (qr) {
      currentQr = qr;
      connectionState = "connecting";
      console.log("✅ QR Code gerado");
    }

    if (connection === "open") {
      currentQr = null;
      connectionState = "connected";
      lastError = null;
      console.log("✅ Conectado ao WhatsApp:", sock.user?.id);
    }

    if (connection === "close") {
      connectionState = "disconnected";
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      lastError = lastDisconnect?.error?.message || null;
      console.log(`🔌 Conexão fechada (code=${code}). Reconnect=${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startSock().catch(console.error), 3000);
      } else {
        console.log("⚠️ Logout detectado. Limpe a pasta de auth e escaneie novo QR.");
      }
    }
  });
}

// ==================== UTILS ====================
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${label} após ${ms}ms`)), ms)
    ),
  ]);
}

// ==================== ENDPOINTS ====================

// Health — público, sem auth (para checagem rápida)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    connected: connectionState === "connected",
    state: connectionState,
    user: sock?.user?.id || null,
    hasQr: !!currentQr,
    lastError,
  });
});

// QR Code — protegido
app.get("/qr", requireAuth, async (req, res) => {
  if (!currentQr) {
    return res.json({
      ok: true,
      hasQr: false,
      connected: connectionState === "connected",
    });
  }
  try {
    const dataUrl = await qrcode.toDataURL(currentQr);
    res.json({ ok: true, hasQr: true, qr: dataUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Status — protegido
app.get("/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    connected: connectionState === "connected",
    state: connectionState,
    user: sock?.user?.id || null,
  });
});

// Logout — protegido (força novo QR)
app.post("/logout", requireAuth, async (req, res) => {
  try {
    if (sock) await sock.logout().catch(() => {});
    connectionState = "disconnected";
    currentQr = null;
    res.json({ ok: true });
    setTimeout(() => startSock().catch(console.error), 1000);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send — protegido, com validação onWhatsApp e timeouts internos
app.post("/send", requireAuth, async (req, res) => {
  try {
    const { to, phone, message } = req.body || {};
    const target = to || phone;

    if (!target || !message) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: to (ou phone) e message",
      });
    }

    if (!sock || connectionState !== "connected") {
      return res.status(503).json({
        ok: false,
        error: `WhatsApp não conectado (estado: ${connectionState}). Escaneie o QR Code.`,
      });
    }

    const digits = normalizePhone(target);
    if (!digits) {
      return res.status(400).json({
        ok: false,
        error: `Número inválido: "${target}". Use DDI+DDD+número (ex: 5511999998888).`,
      });
    }

    const jid = `${digits}@s.whatsapp.net`;

    // Valida se o número existe no WhatsApp (timeout 10s)
    let exists = false;
    try {
      const result = await withTimeout(sock.onWhatsApp(jid), 10_000, "onWhatsApp");
      exists = Array.isArray(result) && result.length > 0 && result[0]?.exists;
    } catch (err) {
      console.error("Erro ao validar número:", err.message);
      return res.status(504).json({
        ok: false,
        error: `Falha ao validar número: ${err.message}`,
      });
    }

    if (!exists) {
      return res.status(400).json({
        ok: false,
        exists: false,
        error: `O número ${digits} não possui WhatsApp.`,
      });
    }

    // Envia a mensagem (timeout 30s)
    let sendResult;
    try {
      sendResult = await withTimeout(
        sock.sendMessage(jid, { text: String(message) }),
        30_000,
        "sendMessage"
      );
    } catch (err) {
      console.error("Erro ao enviar:", err.message);
      return res.status(504).json({
        ok: false,
        delivered: false,
        error: `Falha ao enviar: ${err.message}`,
      });
    }

    if (!sendResult || !sendResult.key) {
      return res.status(500).json({
        ok: false,
        delivered: false,
        error: "WhatsApp não retornou confirmação de envio",
      });
    }

    console.log(`✅ Mensagem enviada para ${digits} (id: ${sendResult.key.id})`);

    return res.json({
      ok: true,
      delivered: true,
      exists: true,
      messageId: sendResult.key.id,
      to: digits,
    });
  } catch (err) {
    console.error("❌ Erro no /send:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro interno ao enviar mensagem",
    });
  }
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`🚀 Bridge rodando na porta ${PORT}`);
});

startSock().catch((err) => {
  console.error("❌ Falha ao iniciar Baileys:", err);
  process.exit(1);
});
