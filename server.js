import express from "express";
import cors from "cors";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const AUTH_DIR = "./auth";

let sock = null;
let currentQR = null;
let qrGeneratedAt = 0;
let qrStale = false;
let isConnected = false;
let currentPhone = null;
let isStarting = false;

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "").trim();
  if (!BRIDGE_TOKEN || token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ---------- Start session ----------
async function startSock() {
  if (isStarting) {
    console.log("⏳ startSock já em andamento, ignorando");
    return;
  }
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 Usando WhatsApp v${version.join(".")} (latest: ${isLatest})`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      qrTimeout: 60_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      browser: ["NotifyZap", "Chrome", "1.0.0"],
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
        currentQR = qr;
        qrGeneratedAt = Date.now();
        qrStale = false;
        console.log("✅ QR Code gerado");
      }

      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        qrStale = false;
        currentPhone = sock.user?.id?.split(":")[0] || null;
        console.log(`🟢 Conectado: ${currentPhone}`);
      }

      if (connection === "close") {
        isConnected = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        // Mantém o último QR como "stale" para o dashboard ainda exibir algo
        if (currentQR) qrStale = true;

        console.log(
          `🔌 Conexão fechada (code=${code}). Reconnect=${shouldReconnect}`
        );

        if (shouldReconnect) {
          isStarting = false;
          setTimeout(() => startSock(), 1500);
        } else {
          // logout total — limpa auth
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          currentQR = null;
          qrStale = false;
          isStarting = false;
        }
      }
    });

    isStarting = false;
  } catch (err) {
    console.error("❌ Erro startSock:", err);
    isStarting = false;
  }
}

// ---------- Endpoints ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/status", auth, (req, res) => {
  res.json({
    connected: isConnected,
    phone: currentPhone,
    qr: currentQR,
    hasQr: !!currentQR,
    qrAge: currentQR ? Date.now() - qrGeneratedAt : 0,
    qrStale,
  });
});

app.post("/session/start", auth, async (req, res) => {
  if (!sock || (!isConnected && !currentQR)) {
    startSock();
  }

  // Aguarda até 8s pelo QR ou conexão
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (isConnected || currentQR) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  res.json({
    connected: isConnected,
    phone: currentPhone,
    qr: currentQR,
    hasQr: !!currentQR,
    qrAge: currentQR ? Date.now() - qrGeneratedAt : 0,
    qrStale,
  });
});

app.post("/session/reset", auth, async (req, res) => {
  console.log("♻️ Reset solicitado");
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
      sock = null;
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    currentQR = null;
    qrStale = false;
    isConnected = false;
    currentPhone = null;
    isStarting = false;
    setTimeout(() => startSock(), 800);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const { to, phone, message } = req.body;
    const target = to || phone; // aceita os dois formatos

    if (!target || !message) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: to (ou phone) e message",
      });
    }

    if (!sock) {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp não conectado. Escaneie o QR Code primeiro.",
      });
    }

    // Normaliza: remove tudo que não for dígito
    const digits = String(target).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({
        ok: false,
        error: `Número inválido: "${target}". Use DDI+DDD+número (ex: 5511999998888).`,
      });
    }

    const jid = `${digits}@s.whatsapp.net`;

    // 🔍 VALIDA se o número está no WhatsApp
    let exists = false;
    try {
      const result = await sock.onWhatsApp(jid);
      exists = Array.isArray(result) && result.length > 0 && result[0]?.exists;
    } catch (err) {
      console.error("Erro ao validar número:", err);
      return res.status(500).json({
        ok: false,
        error: "Falha ao validar número no WhatsApp",
      });
    }

    if (!exists) {
      return res.status(400).json({
        ok: false,
        exists: false,
        error: `O número ${digits} não possui WhatsApp.`,
      });
    }

    // 📤 Envia a mensagem
    const sendResult = await sock.sendMessage(jid, { text: String(message) });

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

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Bridge rodando na porta ${PORT}`);
  startSock();
});
