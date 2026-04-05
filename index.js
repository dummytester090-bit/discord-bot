const { 
  Client, GatewayIntentBits, Partials, 
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, 
  InteractionType, PermissionsBitField 
} = require('discord.js');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const TOKEN = process.env.DISCORD_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const ADMIN_ROLE_NAME = process.env.ADMIN_ROLE || "Admin";

// Firebase init
let serviceAccount;
try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch(err){ console.error("Firebase JSON error:", err); process.exit(1); }

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://halurea1-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = admin.database();

// Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const activeKeys = new Map(); // store unlocked users

client.on('ready', () => console.log(`🤖 Bot logged in as ${client.user.tag}`));

// ===========================
// Slash Commands
// ===========================
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // ---------- /hire @user ----------
    if (commandName === 'hire') {
      if (!interaction.member.roles.cache.some(r => r.name === ADMIN_ROLE_NAME)) {
        return interaction.reply({ content: "❌ You are not admin", ephemeral: true });
      }
      const user = interaction.options.getUser('user');
      const guildMember = await interaction.guild.members.fetch(user.id);
      let role = interaction.guild.roles.cache.find(r => r.name === ADMIN_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({ name: ADMIN_ROLE_NAME, permissions: [] });
      }
      await guildMember.roles.add(role);
      return interaction.reply({ content: `✅ ${user.username} is now Admin`, ephemeral: true });
    }

    // ---------- /keyv #channels ----------
    if (commandName === 'keyv') {
      if (!interaction.member.roles.cache.some(r => r.name === ADMIN_ROLE_NAME)) {
        return interaction.reply({ content: "❌ You are not admin", ephemeral: true });
      }
      const channels = interaction.options.getChannel('channels');

      // Send redeem message
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('redeem_key')
            .setLabel('Redeem Your Key')
            .setStyle(ButtonStyle.Primary)
        );

      await channels.send({ content: "🎟️ **Redeem your key here!**", components: [row] });
      return interaction.reply({ content: `✅ Redeem message sent to ${channels}`, ephemeral: true });
    }
  }

  // ===========================
  // Button Click
  // ===========================
  if (interaction.isButton()) {
    if (interaction.customId === 'redeem_key') {
      // Open modal to input key
      const modal = new ModalBuilder()
        .setCustomId('key_modal')
        .setTitle('Enter your key');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_input')
        .setLabel("Paste your key")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(keyInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
    }
  }

  // ===========================
  // Modal Submit
  // ===========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'key_modal') {
    const key = interaction.fields.getTextInputValue('key_input');
    const userId = interaction.user.id;

    // Verify key via backend
    try {
      const res = await fetch(`${BACKEND_URL}/usekey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();

      if (!data.success) {
        return interaction.reply({ content: `❌ ${data.error}`, ephemeral: true });
      }

      // Save active user
      activeKeys.set(userId, { key, usesLeft: data.remainingUses, expiryRaw: data.expiryRaw });

      // Unlock channels
      // get all channels where the button was sent
      const channel = interaction.channel;
      await channel.permissionOverwrites.edit(userId, { SendMessages: true, ViewChannel: true });

      const unix = Math.floor(data.expiryRaw / 1000);
      await interaction.reply({
        content: `✅ Key Redeemed!\nUses left: ${data.remainingUses}\nExpires: <t:${unix}:F> (<t:${unix}:R>)`,
        ephemeral: true
      });
    } catch(err) {
      console.error(err);
      return interaction.reply({ content: "❌ Server error", ephemeral: true });
    }
  }
});

// ===========================
// Auto decrease uses on message send
// ===========================
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const user = activeKeys.get(message.author.id);
  if (!user) return;

  user.usesLeft--;
  if (user.usesLeft <= 0) {
    // Lock channels
    await message.channel.permissionOverwrites.delete(message.author.id);
    activeKeys.delete(message.author.id);
    return message.reply("🔒 Key expired. Channels locked.");
  }

  const unix = Math.floor(user.expiryRaw / 1000);
  message.reply(`📊 Uses left: ${user.usesLeft}\nExpires: <t:${unix}:R>`);
});

client.login(TOKEN);
