const express = require("express");
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

let sock;
let currentQR = null;
let isConnected = false;
let phoneNumber = null;
let starting = false;

async function startSession() {
  if (starting) return;
  starting = true;

  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("QR gerado");
    }

    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      phoneNumber = sock.user?.id?.split(":")[0] ?? null;
      console.log("WhatsApp conectado:", phoneNumber);
    }

    if (connection === "close") {
      isConnected = false;
      starting = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("Reconectando...");
        startSession();
      }
    }
  });
}

// 🔐 Auth middleware — aceita "Bearer <token>"
function auth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!TOKEN || token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Healthcheck público (sem auth) — pra Railway saber que está vivo
app.get("/", (req, res) => res.json({ ok: true }));

// 📲 Start session (gera QR)
app.post("/session/start", auth, async (req, res) => {
  if (!sock) await startSession();

  // espera até 8s pelo QR ou pela conexão
  const start = Date.now();
  while (!currentQR && !isConnected && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 300));
  }

  res.json({
    qr: currentQR,
    connected: isConnected,
    phone: phoneNumber,
  });
});

// 📩 Enviar mensagem
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

// 🔍 Status
app.get("/status", auth, (req, res) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    qr: isConnected ? null : currentQR,
  });
});

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
