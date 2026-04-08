// bot.cjs

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { REST, Routes } = require('@discordjs/rest');
const admin = require('firebase-admin');
const express = require('express');

// -------------------- Discord Bot Setup --------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

const OWNER_ID = process.env.OWNER_ID;
const KEY_PANEL_CHANNEL_ID = process.env.KEY_PANEL_CHANNEL_ID;

// -------------------- Firebase Setup --------------------
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});
const db = admin.database();

// -------------------- Locked Channels --------------------
const lockedChannels = new Set();

// -------------------- Slash Commands --------------------
const { SlashCommandBuilder } = require('discord.js');

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
        .setDescription('Manually send the key redemption panel')
].map(cmd => cmd.toJSON());

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

// -------------------- Helper Functions --------------------

// Grant send permissions to a user in all locked channels
async function grantUserPermissions(userId, guild) {
    for (const chId of lockedChannels) {
        const channel = guild.channels.cache.get(chId);
        if (channel) {
            await channel.permissionOverwrites.edit(userId, { SendMessages: true });
        }
    }
}

// Revoke send permissions from a user in all locked channels
async function revokeUserPermissions(userId, guild) {
    for (const chId of lockedChannels) {
        const channel = guild.channels.cache.get(chId);
        if (channel) {
            await channel.permissionOverwrites.delete(userId);
        }
    }
}

// Check if user already has an active key
async function hasActiveKey(userId) {
    const snapshot = await db.ref('keys').orderByChild('redeemer').equalTo(userId).once('value');
    if (!snapshot.exists()) return false;
    
    const now = Date.now();
    for (const keyData of Object.values(snapshot.val())) {
        if (keyData.expiryRaw > now && keyData.used < keyData.maxUses) {
            return true;
        }
    }
    return false;
}

// Ensure the key panel message exists (resend if deleted)
async function ensureKeyPanel() {
    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
    if (!channel) return console.error("Key panel channel not found!");

    // Get stored message ID from Firebase
    const panelRef = db.ref('bot/panelMessageId');
    const snapshot = await panelRef.once('value');
    let messageId = snapshot.val();

    if (messageId) {
        try {
            const message = await channel.messages.fetch(messageId);
            // Message exists, update button row
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('redeem_key')
                    .setLabel('Redeem Key')
                    .setStyle(ButtonStyle.Primary)
            );
            await message.edit({ content: 'Click the button below to redeem your key:', components: [row] });
            return message;
        } catch (error) {
            // Message not found, will create new one
            console.log('Panel message missing, creating new one');
            await panelRef.remove();
        }
    }

    // Create new panel message
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('redeem_key')
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Primary)
    );
    const newMessage = await channel.send({ content: 'Click the button below to redeem your key:', components: [row] });
    await panelRef.set(newMessage.id);
    console.log('✅ Key panel created/restored');
    return newMessage;
}

// Update the panel content with active keys list
async function updatePanelContent() {
    const panelRef = db.ref('bot/panelMessageId');
    const messageId = (await panelRef.once('value')).val();
    if (!messageId) return;

    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
    if (!channel) return;

    try {
        const message = await channel.messages.fetch(messageId);
        const snapshot = await db.ref('keys').once('value');
        let content = '**Active Keys:**\n';
        let hasActive = false;
        const now = Date.now();

        for (const [keyId, data] of Object.entries(snapshot.val() || {})) {
            if (!data.redeemer) continue;
            
            if (data.expiryRaw <= now || data.used >= data.maxUses) {
                // Expired or used up key - remove it
                await db.ref(`keys/${keyId}`).remove();
                await revokeUserPermissions(data.redeemer, client.guilds.cache.first()); // Note: assumes single guild
                continue;
            }
            
            hasActive = true;
            const minutesLeft = Math.floor((data.expiryRaw - now) / 60000);
            const usesLeft = data.maxUses - (data.used || 0);
            content += `<@${data.redeemer}>: ${minutesLeft} min left, ${usesLeft} uses remaining\n`;
        }

        if (!hasActive) {
            content = 'No active keys at the moment.';
        }

        await message.edit({ content });
    } catch (error) {
        console.error('Failed to update panel content', error);
    }
}

// Periodic check to ensure panel exists (runs every 5 minutes)
async function periodicPanelCheck() {
    try {
        const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
        if (!channel) return;
        
        const panelRef = db.ref('bot/panelMessageId');
        const messageId = (await panelRef.once('value')).val();
        
        if (messageId) {
            try {
                await channel.messages.fetch(messageId);
                // Panel exists, do nothing
            } catch (error) {
                // Panel missing, recreate it
                console.log('Periodic check: Panel missing, recreating...');
                await panelRef.remove();
                await ensureKeyPanel();
                await updatePanelContent();
            }
        } else {
            // No message ID stored, create panel
            await ensureKeyPanel();
            await updatePanelContent();
        }
    } catch (error) {
        console.error('Periodic panel check failed:', error);
    }
}

// -------------------- Key Panel Management --------------------
let keyPanelMessage = null;

// For manual panel sending (/keyv)
async function sendKeyPanel() {
    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
    if (!channel) return console.error("Key panel channel not found!");

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('redeem_key')
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Primary)
    );

    // Remove existing stored message ID if any
    await db.ref('bot/panelMessageId').remove();
    
    const newMessage = await channel.send({ content: 'Click the button below to redeem your key:', components: [row] });
    await db.ref('bot/panelMessageId').set(newMessage.id);
    keyPanelMessage = newMessage;
    return newMessage;
}

// -------------------- Message Collector for Key Usage --------------------
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;
    
    // Only process messages in locked channels
    if (!lockedChannels.has(message.channel.id)) return;
    
    // Check if user has an active key
    const snapshot = await db.ref('keys').orderByChild('redeemer').equalTo(message.author.id).once('value');
    if (!snapshot.exists()) return;
    
    // Find the active key (not expired, not used up)
    const now = Date.now();
    let activeKey = null;
    let activeKeyId = null;
    
    for (const [keyId, data] of Object.entries(snapshot.val())) {
        if (data.expiryRaw > now && data.used < data.maxUses) {
            activeKey = data;
            activeKeyId = keyId;
            break;
        }
    }
    
    if (!activeKey) return;
    
    // Reduce usage
    const newUsed = (activeKey.used || 0) + 1;
    if (newUsed >= activeKey.maxUses) {
        await db.ref(`keys/${activeKeyId}`).remove();
        await revokeUserPermissions(message.author.id, message.guild);
        await message.channel.send(`<@${message.author.id}>, your key has expired.`);
        await updatePanelContent();
    } else {
        await db.ref(`keys/${activeKeyId}`).update({ used: newUsed });
        await updatePanelContent();
    }
});

// -------------------- Button Interaction --------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'redeem_key') {
        await interaction.reply({ content: 'Please type your key in this channel within 60 seconds.', ephemeral: true });

        // Check if user already has an active key
        const hasActive = await hasActiveKey(interaction.user.id);
        if (hasActive) {
            return interaction.followUp({ content: '❌ You cannot redeem multiple keys at a time. Please use your current key first.', ephemeral: true });
        }

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

            // Double-check again that user doesn't have active key (race condition)
            const stillHasActive = await hasActiveKey(interaction.user.id);
            if (stillHasActive) {
                return interaction.followUp({ content: '❌ You already have an active key. Please use it first.', ephemeral: true });
            }

            // Assign redeemer
            await ref.update({ redeemer: interaction.user.id });
            
            // Grant permissions in all locked channels
            await grantUserPermissions(interaction.user.id, interaction.guild);
            
            const minutesLeft = Math.floor((data.expiryRaw - now) / 60000);
            const usesLeft = data.maxUses - (data.used || 0);
            
            interaction.followUp({
                content: `✅ Key valid!\nRemaining uses: ${usesLeft}\nExpires in: ${minutesLeft} minutes`,
                ephemeral: true
            });
            
            await updatePanelContent();
        });
        
        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.followUp({ content: '⏰ Time expired. Please try again.', ephemeral: true });
            }
        });
    }
});

// -------------------- Real-time Countdown Update --------------------
setInterval(async () => {
    await updatePanelContent();
}, 60000); // Update every minute

// -------------------- Periodic Panel Recovery (every 5 minutes) --------------------
setInterval(async () => {
    await periodicPanelCheck();
}, 5 * 60 * 1000); // 5 minutes

// -------------------- Slash Command Handling --------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Owner-only commands
    if (interaction.commandName === 'lock' || interaction.commandName === 'unlock') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: "Only owner can use this!", ephemeral: true });
        }
    }

    if (interaction.commandName === 'lock') {
        const channel = interaction.options.getChannel('channel');
        lockedChannels.add(channel.id);
        
        // Remove send permissions for everyone
        await channel.permissionOverwrites.set([{ id: interaction.guild.roles.everyone.id, deny: ['SendMessages'] }]);
        
        interaction.reply(`🔒 Locked ${channel}`);
    }
    
    else if (interaction.commandName === 'unlock') {
        const channel = interaction.options.getChannel('channel');
        lockedChannels.delete(channel.id);
        
        // Reset permissions for everyone
        await channel.permissionOverwrites.set([{ id: interaction.guild.roles.everyone.id, allow: ['SendMessages'] }]);
        
        // Also remove all user-specific overwrites in this channel
        const overwrites = channel.permissionOverwrites.cache.filter(over => over.type === 'member');
        for (const overwrite of overwrites.values()) {
            await channel.permissionOverwrites.delete(overwrite.id);
        }
        
        interaction.reply(`🔓 Unlocked ${channel}`);
    }
    
    else if (interaction.commandName === 'keyv') {
        await interaction.deferReply({ ephemeral: true });
        await sendKeyPanel();
        await interaction.editReply({ content: '✅ Key panel has been sent/updated!', ephemeral: true });
    }
});

// -------------------- Discord Login --------------------
client.login(process.env.DISCORD_TOKEN);

// -------------------- On Ready --------------------
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    // Load locked channels from database (optional persistence)
    const lockedRef = db.ref('bot/lockedChannels');
    const snapshot = await lockedRef.once('value');
    if (snapshot.exists()) {
        const saved = snapshot.val();
        saved.forEach(id => lockedChannels.add(id));
    }
    
    // Ensure key panel exists on startup
    keyPanelMessage = await ensureKeyPanel();
    await updatePanelContent();
    
    // Also run periodic check immediately to be safe
    await periodicPanelCheck();
});

// Save locked channels to DB when modified (optional)
async function saveLockedChannels() {
    await db.ref('bot/lockedChannels').set(Array.from(lockedChannels));
}

// Override add/delete to save
const origAdd = lockedChannels.add.bind(lockedChannels);
lockedChannels.add = (...args) => {
    const result = origAdd(...args);
    saveLockedChannels();
    return result;
};
const origDelete = lockedChannels.delete.bind(lockedChannels);
lockedChannels.delete = (...args) => {
    const result = origDelete(...args);
    saveLockedChannels();
    return result;
};

// -------------------- Tiny Express Server for Render --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
