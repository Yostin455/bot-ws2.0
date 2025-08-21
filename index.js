"use strict";

/* ===== IMPORTS ===== */
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const { makeWASocket, useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");

/* ===== CONFIG / RUTAS DE IMÁGENES ===== */
const ADMIN_JIDS = [
  "59167568482@s.whatsapp.net",
  "59160457616@s.whatsapp.net",
];

const IMG_SALUDO = path.join(__dirname, "data/medios/saludo.jpg");
const IMG_QR     = path.join(__dirname, "data/medios/qr.jpg");
const IMG_REFERENCIAS = [];

/* ===== TEXTOS ===== */
const TEXTO_OP1 = `💲 *Productos y precios irresistibles*
📦 Planes Compartidos (1 dispositivo): 1 mes: 35 Bs, 2 meses: 60 Bs, 6 meses: 169 Bs, 1 año: 329 Bs
📦 Planes Compartidos (2 dispositivos): 1 mes: 60 Bs, 2 meses: 109 Bs, 6 meses: 309 Bs
👤 Planes Individuales: 1 mes: 139 Bs, 2 meses: 269 Bs, 6 meses: 599 Bs, 1 año: 1579 Bs`;

const TEXTO_OP2 = `Soy yo otra vez… *Samantha*. Esto puedo hacer contigo con *ChatGPT Plus*:
🎨 Imágenes ilimitadas
📎 Analizo PDF, Word, Excel, PowerPoint
📝 Informes, CV, cartas
📊 Excel con análisis
💻 Programación
🗣️ Asistente 24/7
🌍 Traducciones
🎬 Videos automáticos con SORA`;

const TEXTO_COMPARTIDO = `El *plan compartido* es económico, pero compartes cuenta con otros.`;
const TEXTO_INDIVIDUAL = `El *plan individual* es privado y solo para ti.`;
const TEXTO_PAGO = "💳 *Pago*\nEscanea el QR o escribe *4* para hablar con un vendedor.";

/* ===== ESTADO ===== */
const saludados = new Set();
const gruposSaludados = new Set();
const filePath = path.join(__dirname, "qr-login.png");

/* ===== HELPERS ===== */
async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}
async function sendImage(sock, jid, imgPath, caption = "") {
  if (!fs.existsSync(imgPath)) {
    await sendText(sock, jid, caption || "Imagen no disponible.");
    return;
  }
  const buffer = fs.readFileSync(imgPath);
  await sock.sendMessage(jid, { image: buffer, caption });
}
async function avisarAdmins(sock, fromJid, motivo) {
  const aviso = `📢 Cliente en espera\n• Motivo: ${motivo}\n• JID: ${fromJid}`;
  for (const admin of ADMIN_JIDS) {
    await sock.sendMessage(admin, { text: aviso });
  }
}

/* ===== MAIN ===== */
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"));

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate("Chrome"),
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📷 Escanea este QR:");
      qrcode.generate(qr, { small: true });

      try {
        await QRCode.toFile(filePath, qr, { width: 320 });
        console.log("🖼️ QR guardado en:", filePath);
        console.log("🔗 QR link: https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=" + encodeURIComponent(qr));
      } catch (e) {
        console.error("Error guardando QR:", e);
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode || 0;
      console.log("❌ Conexión cerrada:", code);
      if (code !== 401) setTimeout(start, 1500);
    } else if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;

    const texto = msg.message.conversation?.toLowerCase().trim();
    if (!texto) return;

    if (!saludados.has(jid)) {
      await sendImage(sock, jid, IMG_SALUDO, `Hola, soy *Samantha* 🤖✨\n\n${TEXTO_OP1}`);
      saludados.add(jid);
      return;
    }

    if (texto === "1") return sendText(sock, jid, TEXTO_OP1);
    if (texto === "2") return sendText(sock, jid, TEXTO_OP2);
    if (texto === "3") return sendText(sock, jid, "Por ahora no hay referencias.");
    if (texto === "4") return avisarAdmins(sock, jid, "Quiere hablar con un vendedor");
    if (texto === "5") return sendImage(sock, jid, IMG_QR, TEXTO_PAGO);
    if (texto === "6") return sendText(sock, jid, TEXTO_COMPARTIDO);
    if (texto === "7") return sendText(sock, jid, TEXTO_INDIVIDUAL);
    if (texto === "8") return sendImage(sock, jid, IMG_SALUDO, "Volviendo al menú...");
  });
}

start();