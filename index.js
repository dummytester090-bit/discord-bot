const express = require('express');
const { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const admin = require('firebase-admin');

// =========================
// 🔥 EXPRESS SERVER (FOR RENDER)
// =========================
const app = express();

app.get('/', (req, res) => {
  res.send('Bot is alive ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// =========================
// 🔥 FIREBASE INIT
// =========================
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://halurea1-default-rtdb.asia-southeast1.firebasedatabase.app/"
});

const db = admin.database();

// =========================
// 🔥 DISCORD CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// =========================
// 🔥 CONFIG
// =========================
const OWNER_ID = process.env.OWNER_ID;

// =========================
// 🔥 READY
// =========================
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// =========================
// 🔥 PERMISSION CHECK
// =========================
async function isAuthorized(userId) {
  if (userId === OWNER_ID) return true;

  const snap = await db.ref('admins/' + userId).once('value');
  return snap.exists();
}

// =========================
// 🔥 COMMAND HANDLER
// =========================
client.on('interactionCreate', async (interaction) => {

  // =========================
  // 🔐 SLASH COMMANDS
  // =========================
  if (interaction.isChatInputCommand()) {

    const userId = interaction.user.id;

    // OWNER ONLY
    if (interaction.commandName === 'hire') {
      if (userId !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });

      const user = interaction.options.getUser('user');
      await db.ref('admins/' + user.id).set(true);

      return interaction.reply(`✅ ${user.tag} hired`);
    }

    if (interaction.commandName === 'fire') {
      if (userId !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });

      const user = interaction.options.getUser('user');
      await db.ref('admins/' + user.id).remove();

      return interaction.reply(`🔥 ${user.tag} fired`);
    }

    // OTHER COMMANDS NEED AUTH
    const allowed = await isAuthorized(userId);
    if (!allowed) return interaction.reply({ content: '❌ Not authorized', ephemeral: true });

    // LOCK CHANNEL
    if (interaction.commandName === 'lock') {
      const channel = interaction.options.getChannel('channel');

      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false
      });

      await db.ref('lockedChannels/' + channel.id).set(true);

      return interaction.reply(`🔒 Locked ${channel.name}`);
    }

    // KEY PANEL
    if (interaction.commandName === 'keyv') {
      const channel = interaction.options.getChannel('channel');

      const embed = new EmbedBuilder()
        .setTitle('🔑 Key System')
        .setDescription('Click button to redeem key');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('redeem')
          .setLabel('Redeem Key')
          .setStyle(ButtonStyle.Primary)
      );

      await channel.send({ embeds: [embed], components: [row] });

      return interaction.reply({ content: '✅ Panel sent', ephemeral: true });
    }
  }

  // =========================
  // 🔘 BUTTON CLICK
  // =========================
  if (interaction.isButton()) {
    if (interaction.customId === 'redeem') {

      const modal = new ModalBuilder()
        .setCustomId('redeemModal')
        .setTitle('Enter Key');

      const input = new TextInputBuilder()
        .setCustomId('keyInput')
        .setLabel('Your Key')
        .setStyle(TextInputStyle.Short);

      modal.addComponents(new ActionRowBuilder().addComponents(input));

      return interaction.showModal(modal);
    }
  }

  // =========================
  // 🧾 MODAL SUBMIT
  // =========================
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'redeemModal') {

      const key = interaction.fields.getTextInputValue('keyInput');
      const userId = interaction.user.id;

      const userRef = db.ref('activeKeys/' + userId);
      const existing = await userRef.once('value');

      if (existing.exists()) {
        return interaction.reply({ content: '❌ You already have active key', ephemeral: true });
      }

      const ref = db.ref('keys/' + key);
      const snap = await ref.once('value');

      if (!snap.exists()) {
        return interaction.reply({ content: '❌ Invalid key', ephemeral: true });
      }

      const data = snap.val();

      if (new Date(data.expiry) < new Date()) {
        await ref.remove();
        return interaction.reply({ content: '❌ Expired', ephemeral: true });
      }

      if (data.used >= data.maxUses) {
        await ref.remove();
        return interaction.reply({ content: '❌ No uses left', ephemeral: true });
      }

      await userRef.set(key);

      const lockedSnap = await db.ref('lockedChannels').once('value');

      lockedSnap.forEach(child => {
        const channel = interaction.guild.channels.cache.get(child.key);
        if (channel) {
          channel.permissionOverwrites.edit(userId, {
            SendMessages: true
          });
        }
      });

      const embed = new EmbedBuilder()
        .setTitle('✅ Key Activated')
        .setDescription(`Uses left: ${data.maxUses - data.used}\nExpires: ${data.expiry}`);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

// =========================
// 💬 MESSAGE = USE KEY
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;

  const userSnap = await db.ref('activeKeys/' + userId).once('value');
  if (!userSnap.exists()) return;

  const key = userSnap.val();
  const ref = db.ref('keys/' + key);
  const snap = await ref.once('value');

  if (!snap.exists()) return;

  const data = snap.val();

  await ref.update({ used: data.used + 1 });

  if (data.used + 1 >= data.maxUses) {
    await ref.remove();
    await db.ref('activeKeys/' + userId).remove();

    const lockedSnap = await db.ref('lockedChannels').once('value');

    lockedSnap.forEach(child => {
      const channel = message.guild.channels.cache.get(child.key);
      if (channel) {
        channel.permissionOverwrites.edit(userId, {
          SendMessages: false
        });
      }
    });
  }
});

// =========================
// 🚀 LOGIN
// =========================
client.login(process.env.BOT_TOKEN);
