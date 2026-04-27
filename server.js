import express from "express";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "123456";
const AUTH_DIR = path.resolve("./auth");

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneNumber = null;
let starting = false;

// ---------- Middleware de auth ----------
function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- Inicialização do Baileys ----------
async function startSock() {
  if (starting) {
    console.log("[startSock] já está iniciando, ignorando chamada duplicada");
    return;
  }
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
      console.log("[connection.update]", {
        connection,
        hasQr: !!qr,
        error: lastDisconnect?.error?.message,
      });

      if (qr) {
        try {
          currentQR = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: "M",
            width: 320,
            margin: 1,
          });
          console.log("✅ QR Code gerado");
        } catch (err) {
          console.error("Erro ao gerar QR:", err);
        }
      }

      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        phoneNumber = sock?.user?.id?.split(":")[0] || null;
        console.log("✅ WhatsApp conectado:", phoneNumber);
      }

      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log("❌ Conexão fechada. Código:", code, "Reconectar?", shouldReconnect);
        sock = null;
        if (shouldReconnect) {
          setTimeout(() => startSock().catch(console.error), 2000);
        }
      }
    });
  } catch (err) {
    console.error("Erro em startSock:", err);
  } finally {
    starting = false;
  }
}

// ---------- Rotas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "notifyzap-bridge", connected: isConnected });
});

app.get("/status", checkAuth, (_req, res) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    hasQr: !!currentQR,
  });
});

app.post("/session/start", checkAuth, async (_req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null, phone: phoneNumber });
  }

  if (!sock) {
    startSock().catch(console.error);
  }

  // Espera até 12s pelo QR ou conexão
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (isConnected) return res.json({ connected: true, qr: null, phone: phoneNumber });
    if (currentQR) return res.json({ connected: false, qr: currentQR });
    await new Promise((r) => setTimeout(r, 500));
  }

  res.json({
    connected: false,
    qr: currentQR,
    message: currentQR ? "QR pronto" : "Aguardando geração do QR (tente novamente em alguns segundos)",
  });
});

app.post("/session/reset", checkAuth, async (_req, res) => {
  console.log("🔄 Reset solicitado — limpando sessão");
  try {
    if (sock) {
      try { sock.end(); } catch (_) {}
      sock = null;
    }
    isConnected = false;
    currentQR = null;
    phoneNumber = null;

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("🗑️  Pasta auth/ removida");
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    setTimeout(() => startSock().catch(console.error), 1000);
    res.json({ ok: true, message: "Sessão resetada — reinicializando Baileys" });
  } catch (err) {
    console.error("Erro no reset:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send", checkAuth, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!isConnected || !sock) {
    return res.status(400).json({ error: "WhatsApp não conectado" });
  }
  if (!phone || !message) {
    return res.status(400).json({ error: "phone e message são obrigatórios" });
  }

  try {
    const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao enviar:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Boot ----------
app.listen(PORT, () => {
  console.log(`🚀 NotifyZap bridge rodando na porta ${PORT}`);
  startSock().catch(console.error);
});
