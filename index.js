const { 
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder
} = require('discord.js');
const admin = require('firebase-admin');
const express = require('express');
const fetch = require('node-fetch');

// ===== Keep alive for Render =====
const app = express();
app.get('/', (req, res) => res.send('Bot Alive'));
app.listen(process.env.PORT || 3000, () => console.log('Express running'));

// ===== Firebase Init =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://halurea1-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = admin.database();

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== OWNER =====
const OWNER_ID = 'YOUR_USER_ID_HERE'; // Replace with your Discord ID
const hiredUsers = new Set(); // Hired users can run commands

// ===== Channel Lock System =====
const lockedChannels = new Set(); // Store locked channels

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('hire')
    .setDescription('Hire a user to run bot commands')
    .addUserOption(opt => opt.setName('user').setDescription('User to hire').setRequired(true)),

  new SlashCommandBuilder()
    .setName('fire')
    .setDescription('Remove a hired user')
    .addUserOption(opt => opt.setName('user').setDescription('User to fire').setRequired(true)),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock multiple channels')
    .addChannelOption(opt => opt.setName('channel1').setDescription('Channel to lock').setRequired(true))
    .addChannelOption(opt => opt.setName('channel2').setDescription('Optional channel').setRequired(false))
    .addChannelOption(opt => opt.setName('channel3').setDescription('Optional channel').setRequired(false)),

  new SlashCommandBuilder()
    .setName('keyv')
    .setDescription('Send key redeem panel')
];

// ===== REGISTER COMMANDS =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// ===== HELPERS =====
function formatTime(ts) {
  return `<t:${Math.floor(ts/1000)}:F> (<t:${Math.floor(ts/1000)}:R>)`;
}

function isAuthorized(userId) {
  return userId === OWNER_ID || hiredUsers.has(userId);
}

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (!isAuthorized(interaction.user.id)) 
      return interaction.reply({ content: '❌ Not authorized', ephemeral: true });

    // ===== HIRE =====
    if (interaction.commandName === 'hire') {
      const user = interaction.options.getUser('user');
      hiredUsers.add(user.id);
      return interaction.reply(`✅ Hired ${user.username}`);
    }

    // ===== FIRE =====
    if (interaction.commandName === 'fire') {
      const user = interaction.options.getUser('user');
      hiredUsers.delete(user.id);
      return interaction.reply(`❌ Fired ${user.username}`);
    }

    // ===== LOCK =====
    if (interaction.commandName === 'lock') {
      const channels = [
        interaction.options.getChannel('channel1'),
        interaction.options.getChannel('channel2'),
        interaction.options.getChannel('channel3')
      ].filter(c => c);

      for (let c of channels) {
        lockedChannels.add(c.id);
        await c.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
      }

      return interaction.reply(`🔒 Locked ${channels.map(c=>c.name).join(', ')}`);
    }

    // ===== KEYV PANEL =====
    if (interaction.commandName === 'keyv') {
      const button = new ButtonBuilder()
        .setCustomId('redeem')
        .setLabel('Redeem Key')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);

      // Send in every locked channel
      for (let chId of lockedChannels) {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch && ch.isTextBased()) {
          await ch.send({ content: '🔑 Redeem your key below', components: [row] });
        }
      }

      return interaction.reply({ content: 'Panel sent to locked channels', ephemeral: true });
    }
  }

  // ===== BUTTON =====
  if (interaction.isButton() && interaction.customId === 'redeem') {
    const modal = new ModalBuilder().setCustomId('keyModal').setTitle('Enter your key');
    const input = new TextInputBuilder()
      .setCustomId('keyInput')
      .setLabel('Your Key')
      .setStyle(TextInputStyle.Short);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ===== MODAL SUBMIT =====
  if (interaction.isModalSubmit() && interaction.customId === 'keyModal') {
    const key = interaction.fields.getTextInputValue('keyInput');
    const ref = db.ref('keys/' + key);
    const snap = await ref.once('value');

    if (!snap.exists()) return interaction.reply({ content: '❌ Invalid key', ephemeral: true });

    const data = snap.val();
    const now = Date.now();

    if (now > data.expiryRaw) {
      await ref.remove();
      return interaction.reply({ content: '❌ Key expired', ephemeral: true });
    }

    if (data.used > 0) return interaction.reply({ content: '❌ You already have an active key', ephemeral: true });

    // Lock system: unlock for user
    for (let chId of lockedChannels) {
      const ch = interaction.guild.channels.cache.get(chId);
      if (ch) ch.permissionOverwrites.edit(interaction.user.id, { SendMessages: true });
    }

    // Mark user used key
    await ref.update({ used: 1, userId: interaction.user.id });

    // Embed with live countdown
    const expiry = data.expiryRaw;
    const embed = new EmbedBuilder()
      .setTitle('✅ Key Activated')
      .setDescription(
`Key: \`${key}\`
Uses Left: ${data.maxUses - 1}
Created: ${formatTime(data.createdRaw)}
Expires: ${formatTime(expiry)}`
      );

    const msg = await interaction.reply({ embeds: [embed], fetchReply: true });

    // ===== Realtime countdown =====
    const interval = setInterval(async () => {
      const snap2 = await ref.once('value');
      if (!snap2.exists()) {
        clearInterval(interval);
        return msg.edit({ embeds: [embed.setDescription('Key deleted')] });
      }

      const d = snap2.val();
      const left = d.maxUses - d.used;
      const timeLeft = d.expiryRaw - Date.now();

      if (left <= 0 || timeLeft <= 0) {
        // Delete key + lock channels
        await ref.remove();
        for (let chId of lockedChannels) {
          const ch = interaction.guild.channels.cache.get(chId);
          if (ch) ch.permissionOverwrites.edit(interaction.user.id, { SendMessages: false });
        }
        clearInterval(interval);
        return msg.edit({ embeds: [embed.setDescription('Key expired or used up')] });
      }

      const newEmbed = EmbedBuilder.from(embed)
        .setDescription(
`Key: \`${key}\`
Uses Left: ${left}
Created: ${formatTime(d.createdRaw)}
Expires: ${formatTime(d.expiryRaw)}`
        );
      msg.edit({ embeds: [newEmbed] });
    }, 1000);
  }
});

// ===== MESSAGE TRACKER =====
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  if (!lockedChannels.has(msg.channel.id)) return;

  const snapshot = await db.ref('keys').once('value');
  snapshot.forEach(async child => {
    const d = child.val();
    if (d.userId !== msg.author.id) return;

    let used = d.used + 1;
    if (used >= d.maxUses) {
      await child.ref.remove();
      msg.channel.permissionOverwrites.edit(msg.author.id, { SendMessages: false });
    } else {
      await child.ref.update({ used });
    }
  });
});

client.login(process.env.TOKEN);
