const express = require("express");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN;

let sock;
let currentQR = null;
let isConnected = false;

async function startSession() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
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
      console.log("WhatsApp conectado");
    }

    if (connection === "close") {
      isConnected = false;

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("Reconectando...");
        startSession();
      }
    }
  });
}

// 🔐 Middleware de segurança
app.use((req, res, next) => {
  const token = req.headers["authorization"];
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
});

// 📲 Start session (gera QR)
app.post("/session/start", async (req, res) => {
  await startSession();

  setTimeout(() => {
    res.json({ qr: currentQR });
  }, 2000);
});

// 📩 Enviar mensagem
app.post("/send", async (req, res) => {
  const { phone, message } = req.body;

  try {
    await sock.sendMessage(phone + "@s.whatsapp.net", {
      text: message
    });

    res.json({ status: "enviado" });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// 🔍 Status
app.get("/status", (req, res) => {
  res.json({
    conectado: isConnected
  });
});

app.listen(PORT, () => {
  console.log("Servidor rodando...");
});
