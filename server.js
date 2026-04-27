const express = require("express");
const fs = require("fs/promises");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN;
const AUTH_DIR = "auth";

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneNumber = null;
let starting = false;

async function startSession() {
  if (starting) return;
  starting = true;
  console.log("🚀 Iniciando sessão Baileys…");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    console.log("connection.update:", { connection, hasQr: !!qr });

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("📱 QR gerado");
    }

    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      phoneNumber = sock.user?.id?.split(":")[0] ?? null;
      console.log("✅ WhatsApp conectado:", phoneNumber);
    }

    if (connection === "close") {
      isConnected = false;
      starting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("❌ Desconectado, code=", code, "reconnect=", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startSession(), 2000);
      } else {
        currentQR = null;
        phoneNumber = null;
      }
    }
  });
}

// 🔐 Auth — aceita "Bearer <token>"
function auth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!TOKEN || token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => res.json({ ok: true }));

app.post("/session/start", auth, async (req, res) => {
  if (!sock) await startSession();

  // espera até 12s pelo QR ou pela conexão
  const start = Date.now();
  while (!currentQR && !isConnected && Date.now() - start < 12000) {
    await new Promise((r) => setTimeout(r, 300));
  }

  res.json({
    qr: currentQR,
    connected: isConnected,
    phone: phoneNumber,
  });
});

// 🔄 Reset — apaga auth/ e força nova sessão (gera QR novo)
app.post("/session/reset", auth, async (_req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch (e) { /* ignore */ }
      sock = null;
    }
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    currentQR = null;
    isConnected = false;
    phoneNumber = null;
    starting = false;
    setTimeout(() => startSession(), 500);
    res.json({ ok: true, message: "Sessão resetada — gerando novo QR" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", auth, async (req, res) => {
  const { phone, message } = req.body;
  if (!sock || !isConnected) {
    return res.status(400).json({ error: "WhatsApp não conectado" });
  }
  try {
    await sock.sendMessage(phone + "@s.whatsapp.net", { text: message });
    res.json({ status: "sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", auth, (_req, res) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    qr: isConnected ? null : currentQR,
  });
});

app.listen(PORT, () => {
  console.log("🚀 Bridge rodando na porta", PORT);
  startSession().catch(console.error);
});
