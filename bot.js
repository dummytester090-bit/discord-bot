import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// 🔒 Initialize Firebase securely
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// 🔹 Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// ----------------- Generate key API (optional) -----------------
app.post('/generatekey', async (req, res) => {
  const { validityMinutes, maxUses } = req.body;
  if (!validityMinutes || !maxUses) return res.json({ success: false, error: 'Invalid request' });

  const key = randomBytes(8).toString('hex');
  const now = new Date();
  const expiryDate = new Date(now.getTime() + validityMinutes * 60 * 1000);

  await db.ref(`keys/${key}`).set({
    createdAt: now.toLocaleString(),
    expiry: expiryDate.toLocaleString(),
    maxUses,
    used: 0
  });

  res.json({ success: true, key });
});

// ----------------- Discord login -----------------
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
