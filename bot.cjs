// bot.cjs

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const admin = require('firebase-admin');
const express = require('express');

// -------------------- Discord Bot Setup --------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

const OWNER_ID = process.env.OWNER_ID;

// -------------------- Firebase Setup --------------------
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// -------------------- Locked Channels Tracker --------------------
const lockedChannels = new Set();

// -------------------- Slash Commands --------------------
const commands = [
    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock a channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock').setRequired(true)),
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock a channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to unlock').setRequired(true)),
    new SlashCommandBuilder()
        .setName('keyv')
        .setDescription('Verify your key')
].map(cmd => cmd.toJSON());

// Deploy slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log('✅ Commands registered.');
    } catch (err) {
        console.error(err);
    }
})();

// -------------------- Message Listener (Key Usage) --------------------
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const snapshot = await db.ref('keys').orderByChild('redeemer').equalTo(message.author.id).once('value');
    if (!snapshot.exists()) return;

    const keyData = Object.entries(snapshot.val())[0];
    const key = keyData[0];
    const data = keyData[1];

    if (lockedChannels.has(message.channel.id)) return;

    const newUsed = (data.used || 0) + 1;

    if (newUsed >= data.maxUses) {
        await db.ref(`keys/${key}`).remove();
        message.channel.send(`<@${message.author.id}>, your key has expired.`);
    } else {
        await db.ref(`keys/${key}`).update({ used: newUsed });
    }
});

// -------------------- Slash Command & Button Handling --------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    // ---------------- Slash Commands ----------------
    if (interaction.isChatInputCommand()) {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Only owner can use this!', ephemeral: true });

        const channel = interaction.options.getChannel('channel');

        if (interaction.commandName === 'lock') {
            lockedChannels.add(channel.id);
            interaction.reply(`🔒 Locked ${channel}`);
        }

        if (interaction.commandName === 'unlock') {
            lockedChannels.delete(channel.id);
            interaction.reply(`🔓 Unlocked ${channel}`);
        }

        if (interaction.commandName === 'keyv') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('redeem_key').setLabel('Redeem Key').setStyle(ButtonStyle.Primary)
            );
            interaction.reply({ content: 'Click to redeem your key', components: [row], ephemeral: true });
        }
    }

    // ---------------- Button ----------------
    if (interaction.isButton() && interaction.customId === 'redeem_key') {
        await interaction.reply({ content: 'Please type your key in this channel within 60 seconds', ephemeral: true });

        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async m => {
            const key = m.content.trim();
            const ref = db.ref('keys/' + key);
            const snap = await ref.once('value');
            if (!snap.exists()) return interaction.followUp({ content: '❌ Invalid key', ephemeral: true });

            const data = snap.val();
            const now = Date.now();

            if (data.used >= data.maxUses || now > data.expiryRaw) {
                await ref.remove();
                return interaction.followUp({ content: '❌ Key expired or used up', ephemeral: true });
            }

            await ref.update({ redeemer: interaction.user.id });

            // Unlock all locked channels for this user
            lockedChannels.forEach(chId => {
                const guildChannel = interaction.guild.channels.cache.get(chId);
                if (guildChannel) guildChannel.permissionOverwrites.edit(interaction.user.id, { SendMessages: true });
            });

            interaction.followUp({
                content: `✅ Key valid!\nRemaining uses: ${data.maxUses - (data.used || 0)}\nExpires: ${data.expiry || 'Unknown'}`
            });
        });
    }
});

// -------------------- Discord Login --------------------
client.login(process.env.DISCORD_TOKEN);

// -------------------- Tiny Express Server for Render --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
