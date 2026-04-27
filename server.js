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

// ---------- Send (substitua o app.post("/send", ...) atual) ----------
app.post("/send", auth, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!sock || !isConnected) {
      return res.status(400).json({ ok: false, error: "not connected" });
    }
    if (!to || !message) {
      return res.status(400).json({ ok: false, error: "to and message required" });
    }

    // 1) Normaliza número: só dígitos
    let digits = String(to).replace(/\D/g, "");

    // 2) Se for BR (55) e tiver 12 dígitos (55 + DDD + 8), adiciona o "9"
    //    Ex: 5511964195002 (13) já está ok; 551196419502 (12) -> 5511996419502
    if (digits.startsWith("55") && digits.length === 12) {
      digits = digits.slice(0, 4) + "9" + digits.slice(4);
    }

    // 3) Pergunta ao WhatsApp se esse número EXISTE de verdade
    const [check] = await sock.onWhatsApp(digits);
    if (!check?.exists) {
      console.log(`❌ Número ${digits} não está no WhatsApp`);
      return res.status(400).json({
        ok: false,
        error: "Número não está no WhatsApp",
        checked: digits,
      });
    }

    // 4) Usa o JID retornado pelo onWhatsApp (formato oficial)
    const jid = check.jid;
    const sent = await sock.sendMessage(jid, { text: message });
    console.log(`✅ Mensagem enviada para ${jid} (id: ${sent?.key?.id})`);

    res.json({
      ok: true,
      to: jid,
      messageId: sent?.key?.id,
    });
  } catch (err) {
    console.error("❌ Erro ao enviar:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


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
