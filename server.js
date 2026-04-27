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

let sock = null;
let currentQr = null;
let connectionState = "disconnected";
let lastError = null;

const logger = pino({ level: "info" });

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${BRIDGE_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${label} após ${ms}ms`)), ms)
    ),
  ]);
}

// ==================== ENDPOINTS ====================

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

app.get("/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    connected: connectionState === "connected",
    state: connectionState,
    user: sock?.user?.id || null,
  });
});

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

app.post("/send", requireAuth, async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!sock || connectionState !== "connected") {
      return res.status(400).json({ ok: false, error: "WhatsApp não conectado" });
    }
    if (!to || !message) {
      return res.status(400).json({ ok: false, error: "to e message são obrigatórios" });
    }

    // Normaliza: só dígitos
    let digits = String(to).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({ ok: false, error: "Número inválido" });
    }

    // BR: adiciona o "9" extra se faltar (55 + DDD + 8 dígitos = 12)
    if (digits.startsWith("55") && digits.length === 12) {
      digits = digits.slice(0, 4) + "9" + digits.slice(4);
    }

    // Valida se existe no WhatsApp
    let check;
    try {
      const result = await withTimeout(sock.onWhatsApp(digits), 10_000, "onWhatsApp");
      check = Array.isArray(result) ? result[0] : null;
    } catch (err) {
      console.error("Erro ao validar número:", err.message);
      return res.status(504).json({ ok: false, error: `Falha ao validar: ${err.message}` });
    }

    if (!check?.exists) {
      console.log(`❌ Número ${digits} não está no WhatsApp`);
      return res.status(400).json({
        ok: false,
        exists: false,
        error: "Número não está no WhatsApp",
        checked: digits,
      });
    }

    const jid = check.jid;

    // Envia
    let sent;
    try {
      sent = await withTimeout(
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

    if (!sent?.key) {
      return res.status(500).json({
        ok: false,
        delivered: false,
        error: "WhatsApp não retornou confirmação",
      });
    }

    console.log(`✅ Mensagem enviada para ${jid} (id: ${sent.key.id})`);
    return res.json({
      ok: true,
      delivered: true,
      exists: true,
      to: jid,
      messageId: sent.key.id,
    });
  } catch (err) {
    console.error("❌ Erro no /send:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro interno ao enviar",
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
