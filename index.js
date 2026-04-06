require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
        ActionRowBuilder, ButtonBuilder, ButtonStyle,
        ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
        PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const express = require('express');

// ====== KEEP ALIVE FOR RENDER =====
const app = express();
app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(3000);

// ====== FIREBASE SETUP =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://halurea1-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = admin.database();

// ====== BOT CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ====== CONFIG =====
const OWNER_ID = process.env.OWNER_ID; // YOUR DISCORD ID
let authorizedUsers = new Set();
let lockedChannels = new Set(); // stores locked channel IDs
let activeUserKeys = new Map(); // userID -> key

// ====== SLASH COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('hire')
    .setDescription('Authorize a user')
    .addUserOption(opt => opt.setName('user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('fire')
    .setDescription('Remove authorization')
    .addUserOption(opt => opt.setName('user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock one or more channels')
    .addChannelOption(opt => opt.setName('channel1').setRequired(true))
    .addChannelOption(opt => opt.setName('channel2').setRequired(false))
    .addChannelOption(opt => opt.setName('channel3').setRequired(false)),

  new SlashCommandBuilder()
    .setName('keyv')
    .setDescription('Send key redeem panel')
];

// ====== REGISTER COMMANDS =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );
});

// ====== HELPER FUNCTIONS =====
function formatTime(date) {
  return `<t:${Math.floor(date.getTime()/1000)}:F>`;
}
function formatTimeR(date) {
  return `<t:${Math.floor(date.getTime()/1000)}:R>`;
}

// ====== INTERACTIONS =====
client.on('interactionCreate', async interaction => {

  // ====== AUTH CHECK =====
  if(interaction.isChatInputCommand()) {
    const userId = interaction.user.id;
    if(userId !== OWNER_ID && !authorizedUsers.has(userId)) {
      return interaction.reply({ content: "❌ Not authorized", ephemeral: true });
    }

    if(interaction.commandName === 'hire') {
      const user = interaction.options.getUser('user');
      authorizedUsers.add(user.id);
      return interaction.reply(`✅ ${user.username} is authorized`);
    }

    if(interaction.commandName === 'fire') {
      const user = interaction.options.getUser('user');
      authorizedUsers.delete(user.id);
      return interaction.reply(`❌ ${user.username} is unauthorized`);
    }

    if(interaction.commandName === 'lock') {
      const channels = [];
      ['channel1','channel2','channel3'].forEach(c => {
        const ch = interaction.options.getChannel(c);
        if(ch) channels.push(ch);
      });

      for(const ch of channels) {
        lockedChannels.add(ch.id);
        await ch.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
      }
      return interaction.reply({ content: `🔒 Locked ${channels.length} channels`, ephemeral: true });
    }

    if(interaction.commandName === 'keyv') {
      const button = new ButtonBuilder()
        .setCustomId('redeem')
        .setLabel('Redeem Key')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);

      return interaction.reply({ content: "🔑 Click to redeem your key", components: [row], ephemeral: true });
    }
  }

  // ====== REDEEM BUTTON =====
  if(interaction.isButton() && interaction.customId === 'redeem') {

    const modal = new ModalBuilder()
      .setCustomId('keyModal')
      .setTitle('Enter your key');

    const input = new TextInputBuilder()
      .setCustomId('keyInput')
      .setLabel('Your Key')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Enter key here');

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ====== MODAL SUBMIT =====
  if(interaction.isModalSubmit() && interaction.customId === 'keyModal') {
    const userId = interaction.user.id;
    const key = interaction.fields.getTextInputValue('keyInput');

    if(activeUserKeys.has(userId)) {
      return interaction.reply({ content: "❌ You already have an active key", ephemeral: true });
    }

    const ref = db.ref('keys/' + key);
    const snap = await ref.once('value');

    if(!snap.exists()) return interaction.reply({ content: "❌ Invalid key", ephemeral: true });

    const data = snap.val();
    const now = Date.now();

    if(now > data.expiryRaw) {
      await ref.remove();
      return interaction.reply({ content: "❌ Key expired", ephemeral: true });
    }

    if(data.used >= data.maxUses) {
      await ref.remove();
      return interaction.reply({ content: "❌ Key used up", ephemeral: true });
    }

    // mark active
    activeUserKeys.set(userId, key);

    // unlock locked channels for this user
    for(const chId of lockedChannels) {
      const ch = interaction.guild.channels.cache.get(chId);
      if(ch?.isTextBased()) {
        await ch.permissionOverwrites.edit(userId, { SendMessages: true });
      }
    }

    // send embed with countdown
    const expiryDate = new Date(data.expiryRaw);
    const embed = new EmbedBuilder()
      .setTitle("✅ Key Activated")
      .setDescription(`Uses Left: ${data.maxUses - data.used}\nCreated: ${formatTime(new Date(data.createdRaw))}\nExpires: ${formatTime(expiryDate)}\nTime Left: ${formatTimeR(expiryDate)}`)
      .setColor("Green");

    await interaction.reply({ embeds: [embed], ephemeral: true });

    // start countdown updater
    const interval = setInterval(async () => {
      const snap2 = await ref.once('value');
      if(!snap2.exists() || (snap2.val().used >= snap2.val().maxUses)) {
        clearInterval(interval);
        activeUserKeys.delete(userId);
        return;
      }
      const data2 = snap2.val();
      const expiry = new Date(data2.expiryRaw);
      const embed2 = new EmbedBuilder()
        .setTitle("✅ Key Activated")
        .setDescription(`Uses Left: ${data2.maxUses - data2.used}\nCreated: ${formatTime(new Date(data2.createdRaw))}\nExpires: ${formatTime(expiry)}\nTime Left: ${formatTimeR(expiry)}`)
        .setColor("Green");
      await interaction.editReply({ embeds: [embed2] });
    }, 1000);
  }
});

// ====== MESSAGE TRACKER =====
client.on('messageCreate', async msg => {
  if(msg.author.bot) return;

  // Only track messages in locked channels
  if(!lockedChannels.has(msg.channel.id)) return;

  const userId = msg.author.id;
  if(!activeUserKeys.has(userId)) return;

  const key = activeUserKeys.get(userId);
  const ref = db.ref('keys/' + key);
  const snap = await ref.once('value');
  if(!snap.exists()) return;

  const data = snap.val();
  let used = data.used + 1;

  if(used >= data.maxUses) {
    await ref.remove();
    activeUserKeys.delete(userId);

    // lock channels again for this user
    for(const chId of lockedChannels) {
      const ch = msg.guild.channels.cache.get(chId);
      if(ch?.isTextBased()) ch.permissionOverwrites.delete(userId);
    }
  } else {
    await ref.update({ used });
  }
});

client.login(process.env.TOKEN);
