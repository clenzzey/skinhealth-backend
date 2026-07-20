const express = require('express');
const cors = require('cors');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;

// Memory storage
const otpStore = new Map();
const appointments = []; // Stores all booked appointments

// Anti-Spam Rate Limiter Memory (IP based)
const rateLimitMap = new Map();

// Helper: Anti-Spam middleware for OTP requests
function spamProtector(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10-minute window
  const maxRequests = 5; // Max 5 code requests per 10 mins

  if (!rateLimitMap.has(clientIp)) {
    rateLimitMap.set(clientIp, { count: 1, resetTime: now + windowMs });
    return next();
  }

  const limitData = rateLimitMap.get(clientIp);

  if (now > limitData.resetTime) {
    rateLimitMap.set(clientIp, { count: 1, resetTime: now + windowMs });
    return next();
  }

  if (limitData.count >= maxRequests) {
    return res.status(429).json({ 
      success: false, 
      message: 'Too many requests. Please wait a few minutes before trying again.' 
    });
  }

  limitData.count++;
  next();
}

// Clean phone numbers to WhatsApp JID format
function formatJid(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '212' + cleaned.substring(1); // Standardize local Moroccan numbers
  }
  return `${cleaned}@s.whatsapp.net`;
}

// Initialize WhatsApp Web Socket Connection
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      browser: ['Skin & Health Center', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n=================================================');
        console.log('  SCAN THIS QR CODE WITH YOUR WHATSAPP APP');
        console.log('=================================================\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
      } else if (connection === 'open') {
        console.log('\n=================================================');
        console.log('✅ Skin & Health Medical Center Bot Connected!');
        console.log('=================================================\n');
      }
    });
  } catch (err) {
    console.error('Failed to initialize WhatsApp:', err);
    setTimeout(connectToWhatsApp, 5000);
  }
}

connectToWhatsApp();

// --- ROUTE: GET TAKEN SLOTS FOR A SPECIFIC DATE ---
app.get('/api/booked-slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ takenSlots: [] });

  const takenSlots = appointments
    .filter(app => app.date === date)
    .map(app => app.time);

  res.json({ takenSlots });
});

// --- ROUTE 1: SEND 6-DIGIT OTP (Protected by Anti-Spam) ---
app.post('/send-otp', spamProtector, async (req, res) => {
  const { phone, language } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  const jid = formatJid(phone);
  if (!jid) {
    return res.status(400).json({ success: false, message: 'Invalid phone format.' });
  }

  if (!sock || !sock.user) {
    return res.status(503).json({ success: false, message: 'WhatsApp bot connecting. Please wait...' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  otpStore.set(phone, {
    code,
    expires: Date.now() + 5 * 60 * 1000
  });

  const otpTemplates = {
    en: `🏥 *Skin & Health Medical Center*\n🔐 Your verification code is: *${code}*. Valid for 5 minutes.`,
    fr: `🏥 *Centre Médical Skin & Health*\n🔐 Votre code de vérification est : *${code}*. Valable 5 minutes.`,
    ar: `🏥 *مركز Skin & Health الطبي*\n🔐 رمز التحقق الخاص بك هو: *${code}*. الصلاحية: 5 دقائق.`
  };

  const selectedLang = language || 'en';
  const messageText = otpTemplates[selectedLang] || otpTemplates.en;

  try {
    await sock.sendMessage(jid, { text: messageText });
    res.status(200).json({ success: true, message: 'Verification code sent via WhatsApp!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not send WhatsApp code.' });
  }
});

// --- ROUTE 2: VERIFY OTP ---
app.post('/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  const record = otpStore.get(phone);

  if (!record) {
    return res.status(400).json({ success: false, message: 'No code requested. Click Send Code.' });
  }

  if (Date.now() > record.expires) {
    otpStore.delete(phone);
    return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });
  }

  if (record.code !== code.trim()) {
    return res.status(400).json({ success: false, message: 'Invalid 6-digit code.' });
  }

  otpStore.delete(phone);
  res.status(200).json({ success: true, message: 'Phone verified!' });
});

// --- ROUTE 3: BOOK APPOINTMENT ---
app.post('/book-appointment', async (req, res) => {
  const { fullName, phone, date, time, language } = req.body;

  if (!fullName || !phone || !date || !time) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  // Prevent double booking on same date/time
  const isAlreadyBooked = appointments.some(
    app => app.date === date && app.time === time
  );

  if (isAlreadyBooked) {
    return res.status(400).json({ 
      success: false, 
      message: 'This time slot was just booked by another patient. Please choose another slot.' 
    });
  }

  const jid = formatJid(phone);

  const confirmTemplates = {
    en: `🎉 *Appointment Confirmed!*\n🏥 *Skin & Health Medical Center*\n\n👤 *Patient:* ${fullName}\n📅 *Date:* ${date}\n⏰ *Time:* ${time}\n\nWe look forward to seeing you!`,
    fr: `🎉 *Rendez-vous Confirmé !*\n🏥 *Centre Médical Skin & Health*\n\n👤 *Patient:* ${fullName}\n📅 *Date:* ${date}\n⏰ *Heure:* ${time}\n\nNous avons hâte de vous accueillir !`,
    ar: `🎉 *تم تأكيد موعدك بنجاح!*\n🏥 *مركز Skin & Health الطبي*\n\n👤 *المريض:* ${fullName}\n📅 *التاريخ:* ${date}\n⏰ *الوقت:* ${time}\n\nنحن بانتظارك!`
  };

  const selectedLang = language || 'en';
  const confirmationMsg = confirmTemplates[selectedLang] || confirmTemplates.en;

  try {
    if (sock && sock.user) {
      await sock.sendMessage(jid, { text: confirmationMsg });
    }

    const newAppointment = {
      id: Date.now(),
      fullName,
      phone,
      date,
      time,
      language: selectedLang,
      createdAt: new Date().toISOString()
    };

    appointments.push(newAppointment);

    res.status(200).json({ success: true, message: 'Appointment successfully booked!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to process booking.' });
  }
});

// --- ROUTE 4: DOCTOR ADMIN API (Fetch all appointments) ---
app.get('/api/admin/appointments', (req, res) => {
  res.json({ success: true, appointments });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});