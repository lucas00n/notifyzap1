const express = require("express");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

let sock;
let qrCodeBase64 = null;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeBase64 = await QRCode.toDataURL(qr);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) start();
    } else if (connection === "open") {
      qrCodeBase64 = null;
      console.log("✅ Conectado");
    }
  });
}

start();

app.get("/qr", (req, res) => {
  if (!qrCodeBase64) return res.send("Sem QR ou já conectado");
  res.send(`<img src="${qrCodeBase64}" />`);
});

app.post("/send", async (req, res) => {
  const { numero, mensagem } = req.body;

  try {
    await sock.sendMessage(numero + "@s.whatsapp.net", {
      text: mensagem
    });

    res.send({ status: "ok" });
  } catch (err) {
    res.status(500).send({ erro: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Rodando...");
});
