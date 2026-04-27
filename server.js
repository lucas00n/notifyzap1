const express = require("express");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

let sock;
let currentQR = null;

async function startSession() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("QR atualizado");
    }
  });
}

// 👉 endpoint que o Lovable espera
app.post("/session/start", async (req, res) => {
  await startSession();

  setTimeout(() => {
    res.json({ qr: currentQR });
  }, 2000);
});

// 👉 endpoint padrão Lovable
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

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando...");
});
