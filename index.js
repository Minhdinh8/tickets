// index.js
// Ticket Support Bot — updated: support controls (Transcript / Open / Delete), confirm for non-prize, close on all responds
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'configs'))) fs.mkdirSync(path.join(DATA_DIR, 'configs'), { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'tickets'))) fs.mkdirSync(path.join(DATA_DIR, 'tickets'), { recursive: true });

// ----------------- cooldown maps -----------------
const userLastTicket = new Map(); // Map<guildId, Map<userId, timestamp>>
const userOptionLast = new Map(); // Map<guildId, Map<userId, Map<optionId, timestamp>>>

const GLOBAL_TICKET_COOLDOWN_MS = 90 * 1000;
const OPTION_COOLDOWN_MS = 30 * 1000;

// ----------------- file helpers -----------------
function channelMetaPath(guildId) {
  const dir = path.join(DATA_DIR, 'tickets', guildId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'channels.json');
}
function loadAllChannelMeta(guildId) {
  const p = channelMetaPath(guildId);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function saveAllChannelMeta(guildId, obj) {
  fs.writeFileSync(channelMetaPath(guildId), JSON.stringify(obj, null, 2));
}
function saveChannelMeta(guildId, channelId, meta) {
  const all = loadAllChannelMeta(guildId);
  all[channelId] = meta;
  saveAllChannelMeta(guildId, all);
}
function loadChannelMeta(guildId, channelId) {
  const all = loadAllChannelMeta(guildId);
  return all[channelId] || null;
}
function deleteChannelMeta(guildId, channelId) {
  const all = loadAllChannelMeta(guildId);
  if (all[channelId]) { delete all[channelId]; saveAllChannelMeta(guildId, all); }
}
function getConfig(guildId) {
  const p = path.join(DATA_DIR, 'configs', `${guildId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function saveConfig(guildId, obj) {
  const p = path.join(DATA_DIR, 'configs', `${guildId}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// ----------------- archive & attachments -----------------
function ensureTicketFolder() {
  const d = path.join(DATA_DIR, 'tickets');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function saveTicketArchive(guildId, ticketId, data) {
  ensureTicketFolder();
  const dir = path.join(DATA_DIR, 'tickets', `${guildId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticketId}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to download ' + url);
  const stream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on('error', reject);
    stream.on('finish', resolve);
  });
}

// ----------------- prize parse -----------------
function parsePrizeAmount(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (s.includes('$')) {
    const digits = s.replace(/[^\d.\-]/g, '');
    const v = parseFloat(digits) || 0;
    return { kind: 'USD', raw: s, amount: v, display: `$${v}` };
  }
  if (/^\(.*\)$/.test(s)) {
    const inner = s.replace(/^\(|\)$/g, '').trim();
    const v = parseFloat(inner.replace(/[^\d.\-]/g, '')) || 0;
    return { kind: 'USD', raw: s, amount: v, display: `$${v}` };
  }
  if (/[cC]/.test(s)) {
    const digits = s.replace(/[^\d.\-]/g, '');
    const v = parseFloat(digits) || 0;
    return { kind: 'COIN', raw: s, amount: v, display: `${v}c` };
  }
  if (/^[\d.\-]+$/.test(s)) {
    const v = parseFloat(s) || 0;
    return { kind: 'COIN', raw: s, amount: v, display: `${v}c` };
  }
  return { kind: 'TEXT', raw: s, amount: null, display: s };
}

// ----------------- transcript channel -----------------
async function ensureTranscriptChannel(guild, cfg) {
  try {
    if (cfg.transcriptChannelId) {
      const existing = await guild.channels.fetch(cfg.transcriptChannelId).catch(()=>null);
      if (existing) return existing;
    }
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
    ];
    guild.roles.cache.forEach(role => {
      if (role.managed) return;
      try {
        if (role.permissions.has(PermissionsBitField.Flags.Administrator) || role.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          overwrites.push({ id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory] });
        }
      } catch {}
    });
    const created = await guild.channels.create({
      name: 'ticket-transcript',
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites
    });
    cfg.transcriptChannelId = created.id;
    saveConfig(guild.id, cfg);
    return created;
  } catch (e) {
    console.warn('ensureTranscriptChannel failed', e?.message || e);
    return null;
  }
}

// ----------------- Express (dashboard API) -----------------
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/guilds', (req, res) => {
  if (!client || !client.isReady()) return res.status(503).json({ error: 'Bot not ready' });
  const list = Array.from(client.guilds.cache.values()).map(g => ({ id: g.id, name: g.name, iconURL: g.iconURL() || null }));
  res.json(list);
});
app.get('/api/guilds/:guildId/channels', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const channels = await guild.channels.fetch();
    const out = [];
    channels.forEach(ch => {
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildCategory) {
        out.push({ id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null });
      }
    });
    out.sort((a,b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === ChannelType.GuildCategory ? -1 : 1)));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config/:guildId', (req, res) => {
  const cfg = getConfig(req.params.guildId) || {
    panelEmbed: { title: 'Ticket Panel', description: 'Select an option to open a ticket', color: 0x1E90FF },
    respondOpeningGlobal: 'Hey there! {user}\nSupport will be with you shortly.',
    detailsEmbed: { title: 'Details', color: 0x2ea043 },
    options: [
      {
        id: 'prize',
        label: 'Prize / Payout',
        description: 'Report a payout',
        isPrize: true,
        prefix: 'PRZ',
        form: [
          { id: 'summary', label: 'Short description / summary', style: 'paragraph', required: true, placeholder: '' },
          { id: 'prizeAmount', label: 'Prize amount', style: 'short', required: true, placeholder: '$100 or 100c' },
          { id: 'prizeDetails', label: 'Prize details', style: 'paragraph', required: false, placeholder: '' }
        ],
        includeAdjustPrize: true,
        respondContent: 'Thank you {user}, staff will review your payout.',
        respondUseEmbed: false
      },
      {
        id: 'other',
        label: 'Other Support',
        description: 'General support',
        isPrize: false,
        prefix: 'OTH',
        form: [{ id: 'summary', label: 'Short description / summary', style: 'paragraph', required: true, placeholder: '' }],
        includeAdjustPrize: false,
        respondContent: 'Thanks {user} — please describe your issue and staff will assist.',
        respondUseEmbed: false
      }
    ],
    categoryId: null,
    ticketCounter: 0,
    pinnedMessage: { enabled: false, content: '', pinnedAfterPost: false, messageId: null }
  };
  res.json(cfg);
});
app.post('/api/config/:guildId', (req, res) => {
  saveConfig(req.params.guildId, req.body);
  res.json({ ok: true });
});
app.post('/api/postpanel', async (req, res) => {
  const { guildId, channelId, pin } = req.body || {};
  if (!guildId || !channelId) return res.status(400).json({ error: 'guildId and channelId required' });
  const cfg = getConfig(guildId);
  if (!cfg) return res.status(404).json({ error: 'No config' });
  try {
    const guild = await client.guilds.fetch(guildId);
    const ch = await guild.channels.fetch(channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const embed = new EmbedBuilder().setTitle(cfg.panelEmbed.title || '').setDescription(cfg.panelEmbed.description || '');
    if (cfg.panelEmbed.color) embed.setColor(cfg.panelEmbed.color);
    const menu = new StringSelectMenuBuilder().setCustomId('ticket_select').setPlaceholder('Make a selection')
      .addOptions(cfg.options.map(o => ({ label: o.label, description: o.description || '', value: o.id })));
    const components = [new ActionRowBuilder().addComponents(menu)];
    const sent = await ch.send({ embeds: [embed], components });
    if (pin) { try { await sent.pin(); } catch {} }
    cfg.pinnedMessage = cfg.pinnedMessage || {}; cfg.pinnedMessage.messageId = sent.id; saveConfig(guildId, cfg);
    await ensureTranscriptChannel(guild, cfg).catch(()=>null);
    res.json({ ok: true, messageId: sent.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard available on http://localhost:${PORT}`));

// ----------------- Discord bot -----------------
const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('Please set DISCORD_TOKEN in .env'); process.exit(1); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// restart guard
let isRestarting = false;
let lastRestartAt = 0;
async function attemptRestart(reason) {
  const now = Date.now();
  if (isRestarting && now - lastRestartAt < 60*1000) return;
  isRestarting = true;
  lastRestartAt = now;
  console.warn('Attempting safe restart due to:', reason?.message || reason);
  try { await client.destroy(); } catch (e) { console.warn('Error destroying client', e?.message || e); }
  await new Promise(r => setTimeout(r, 2000));
  try { await client.login(token); console.log('Client re-login attempted'); } catch (e) { console.error('Re-login failed', e?.message || e); }
  setTimeout(() => { isRestarting = false; }, 60*1000);
}

// safe response helpers
async function safeReply(interaction, options) {
  try {
    if (!interaction) return;
    if (interaction.replied || interaction.deferred) {
      try { return await interaction.followUp({ ephemeral: options.ephemeral ?? true, ...options }); } catch (e) { /* ignore */ }
    } else {
      return await interaction.reply(options);
    }
  } catch (err) {
    if (err && err.code === 40060) {
      try { return await interaction.followUp({ ephemeral: options.ephemeral ?? true, ...options }); } catch (e) {}
    }
    if (err && err.message && err.message.includes('Unknown interaction')) attemptRestart(err);
    console.warn('safeReply failed', err?.message || err);
  }
}
async function safeUpdate(interaction, options) {
  try {
    if (!interaction) return;
    if (interaction.deferred || interaction.replied) {
      try { return await interaction.editReply(options); } catch (e) { /* fallback */ }
      try { return await interaction.followUp({ ephemeral: options.ephemeral ?? true, ...options }); } catch (e) {}
    } else {
      return await interaction.update(options);
    }
  } catch (err) {
    if (err && err.code === 40060) {
      try { return await interaction.followUp({ ephemeral: options.ephemeral ?? true, ...options }); } catch (e) {}
    }
    if (err && err.message && err.message.includes('Unknown interaction')) attemptRestart(err);
    console.warn('safeUpdate failed', err?.message || err);
  }
}

// helper to check whether interaction is intended for this bot
function interactionIsForThisBot(interaction) {
  if (interaction.user?.bot) return false;
  if (interaction.applicationId && client.user && interaction.applicationId !== client.user.id) return false;

  if (interaction.isMessageComponent && interaction.isMessageComponent()) {
    const msgAuthorId = interaction.message?.author?.id;
    if (!msgAuthorId) return false;
    if (msgAuthorId !== client.user.id) return false;
    const cid = String(interaction.customId || '');
    const allowedPrefixes = ['ticket_select', 'ticket_modal::', 'ticket_close::', 'ticket_confirm::', 'support_transcript::', 'support_open::', 'support_delete::', 'disabled'];
    if (!allowedPrefixes.some(p => cid === p || cid.startsWith(p))) return false;
    return true;
  }

  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
    const msgAuthorId = interaction.message?.author?.id;
    if (!msgAuthorId) return false;
    if (msgAuthorId !== client.user.id) return false;
    if (String(interaction.customId || '') !== 'ticket_select') return false;
    return true;
  }

  if (interaction.isModalSubmit && interaction.isModalSubmit()) {
    const cid = String(interaction.customId || '');
    if (!cid.startsWith('ticket_modal::')) return false;
    return true;
  }

  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    if (interaction.applicationId && client.user && interaction.applicationId !== client.user.id) return false;
    if (interaction.user?.bot) return false;
    return true;
  }

  return false;
}

// client error event
client.on('error', (err) => {
  console.error('Client error', err?.message || err);
  if (err && err.message && err.message.includes('Unknown interaction')) attemptRestart(err);
});

// register commands
client.once('ready', async () => {
  console.log('Bot ready', client.user.tag);
  const commands = [
    { name: 'postpanel', description: 'Post the ticket panel in this channel (admin only)' },
    { name: 'confirm', description: 'Send confirm message (owner/admin) to finalize the transaction (then press Confirm button)' },
    { name: 'setprize', description: 'Set/override prize amount for this ticket (admin only)', options: [{ name: 'amount', description: 'Prize amount text (e.g. $100, 100c, (100))', type: 3, required: true }] }
  ];
  for (const g of client.guilds.cache.values()) {
    try { await g.commands.set(commands); } catch (e) { console.warn('register cmd failed', g.id, e?.message || e); }
  }
});

// helpers
function buildPanelRows(cfg) {
  const menu = new StringSelectMenuBuilder().setCustomId('ticket_select').setPlaceholder('Make a selection')
    .addOptions(cfg.options.map(o => ({ label: o.label, description: o.description || '', value: o.id })));
  return [new ActionRowBuilder().addComponents(menu)];
}
async function fetchAllMessages(channel) {
  let all = []; let lastId = null;
  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const msgs = await channel.messages.fetch(opts);
    if (msgs.size === 0) break;
    all = all.concat(Array.from(msgs.values()));
    lastId = msgs.last().id;
    if (msgs.size < 100) break;
  }
  return all;
}

// archive & transcript
async function archiveAndDeleteChannel(interactionOrNull, guildId, channel, meta, actor, actorId) {
  try {
    const messages = await fetchAllMessages(channel);
    const archive = {
      guildId,
      ticketId: meta.ticketId,
      type: meta.type,
      label: meta.label,
      ownerId: meta.ownerId,
      isPrize: meta.isPrize,
      prizeAmount: meta.prizeAmount || null,
      prizeParsed: meta.prizeParsed || null,
      prizeDetails: meta.prizeDetails || null,
      summary: meta.summary || '',
      createdAt: meta.createdAt,
      closedAt: new Date().toISOString(),
      closedBy: actor || null,
      messages: []
    };

    const ticketDir = path.join(DATA_DIR, 'tickets', `${guildId}`);
    if (!fs.existsSync(ticketDir)) fs.mkdirSync(ticketDir, { recursive: true });
    const attachmentDir = path.join(ticketDir, `${meta.ticketId}_attachments`);
    if (!fs.existsSync(attachmentDir)) fs.mkdirSync(attachmentDir, { recursive: true });

    for (const m of messages.reverse()) {
      const rec = { id: m.id, author: { id: m.author.id, tag: m.author.tag }, content: m.content, createdAt: m.createdAt };
      if (m.attachments && m.attachments.size > 0) {
        rec.attachments = [];
        for (const at of m.attachments.values()) {
          const url = at.url;
          const filename = `${m.id}_${path.basename(at.url)}`;
          const outpath = path.join(attachmentDir, filename);
          try { await downloadFile(url, outpath); rec.attachments.push({ filename, url }); } catch (e) { console.warn('attach download failed', e?.message || e); }
        }
      }
      archive.messages.push(rec);
    }

    saveTicketArchive(guildId, meta.ticketId, archive);

    if (meta.isPrize) {
      const cfg = getConfig(guildId) || {};
      const guild = await client.guilds.fetch(guildId).catch(()=>null);
      if (guild) {
        const transcriptCh = await ensureTranscriptChannel(guild, cfg).catch(()=>null);
        if (transcriptCh) {
          const prizeDisplay = meta.prizeParsed ? meta.prizeParsed.display : (meta.prizeAmount || '[prize amount]');
          const actorPart = actorId ? `<@${actorId}>` : (actor ? (typeof actor === 'string' ? actor : actor.tag) : 'Unknown');
          const ownerPart = `<@${meta.ownerId}>`;
          const when = new Date().toLocaleString();
          const ticketName = channel.name || `${meta.prefix || meta.type}-${String(meta.ticketId).padStart(4,'0')}`;
          const text = `${ownerPart} has confirmed that ${actorPart} sent ${prizeDisplay} at ${ticketName} ${when}.`;
          try { await transcriptCh.send({ content: text }); } catch (e) { console.warn('send transcript failed', e?.message || e); }
        }
      }
    }

    deleteChannelMeta(guildId, channel.id);
    try { await channel.delete(`Ticket archived`); } catch (e) { console.warn('delete failed', e?.message || e); }
  } catch (e) {
    console.error('archiveAndDeleteChannel error', e?.message || e);
  }
}

// Create support control message (Transcript / Open / Delete) inside closed channel
async function postSupportControls(channel, meta) {
  try {
    const transcriptBtn = new ButtonBuilder().setCustomId(`support_transcript::${channel.id}`).setLabel('Transcript').setStyle(ButtonStyle.Primary).setEmoji('📜');
    const openBtn = new ButtonBuilder().setCustomId(`support_open::${channel.id}`).setLabel('Open').setStyle(ButtonStyle.Success).setEmoji('🔓');
    const deleteBtn = new ButtonBuilder().setCustomId(`support_delete::${channel.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('⛔');
    const row = new ActionRowBuilder().addComponents(transcriptBtn, openBtn, deleteBtn);
    const embed = new EmbedBuilder().setTitle('Support team ticket controls').setColor(0x2f3136);
    const sent = await channel.send({ embeds: [embed], components: [row] });
    // store control message id so we can edit/delete later
    meta.controlMessageId = sent.id;
    saveChannelMeta(channel.guildId, channel.id, meta);
  } catch (e) {
    console.warn('postSupportControls failed', e?.message || e);
  }
}

// ----------------- interactions -----------------
client.on('interactionCreate', async (interaction) => {
  try {
    // Ignore interactions not for this bot
    if (!interactionIsForThisBot(interaction)) return;

    // Slash commands
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      if (cmd === 'postpanel') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return safeReply(interaction, { content: 'Administrator only', ephemeral: true });
        const cfg = getConfig(interaction.guildId);
        if (!cfg) return safeReply(interaction, { content: 'No config', ephemeral: true });
        const embed = new EmbedBuilder().setTitle(cfg.panelEmbed.title || '').setDescription(cfg.panelEmbed.description || '');
        if (cfg.panelEmbed.color) embed.setColor(cfg.panelEmbed.color);
        const components = buildPanelRows(cfg);
        await safeReply(interaction, { embeds: [embed], components });
        await ensureTranscriptChannel(interaction.guild, cfg).catch(()=>null);
        return;
      }

      if (cmd === 'confirm') {
        const ch = interaction.channel;
        const meta = loadChannelMeta(interaction.guildId, ch.id);
        if (!meta) return safeReply(interaction, { content: 'Use this inside a ticket channel', ephemeral: true });
        const invokerIsOwner = interaction.user.id === meta.ownerId;
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsOwner && !invokerIsAdmin) return safeReply(interaction, { content: 'Only owner or staff can send confirm', ephemeral: true });

        const prizeDisplay = meta.prizeParsed ? meta.prizeParsed.display : (meta.prizeAmount || '[prize amount]');
        const content = `<@${meta.ownerId}> Transaction sent! Please click confirm to confirm that ${prizeDisplay} has been sent to the wallet.`;

        const confirmBtn = new ButtonBuilder().setCustomId(`ticket_confirm::${ch.id}`).setLabel('Confirm').setStyle(ButtonStyle.Success);
        const row = new ActionRowBuilder().addComponents(confirmBtn);
        const sent = await ch.send({ content, components: [row] });
        meta.confirmMessageId = sent.id;
        saveChannelMeta(interaction.guildId, ch.id, meta);
        return safeReply(interaction, { content: 'Confirm message posted.', ephemeral: true });
      }

      if (cmd === 'setprize') {
        const ch = interaction.channel;
        const meta = loadChannelMeta(interaction.guildId, ch.id);
        if (!meta) return safeReply(interaction, { content: 'Use this inside a ticket channel', ephemeral: true });
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsAdmin) return safeReply(interaction, { content: 'Only admins can set prize amount', ephemeral: true });
        const amount = interaction.options.getString('amount');
        const parsed = parsePrizeAmount(amount);
        meta.prizeAmount = amount;
        meta.prizeParsed = parsed;
        saveChannelMeta(interaction.guildId, ch.id, meta);
        try {
          if (meta.respondMessageId && meta.isPrize) {
            const msg = await ch.messages.fetch(meta.respondMessageId).catch(()=>null);
            if (msg && msg.edit) {
              const cfg = getConfig(interaction.guildId);
              const detailEmbed = new EmbedBuilder().setTitle(cfg.detailsEmbed?.title || 'Details').setTimestamp();
              if (cfg.detailsEmbed?.color) detailEmbed.setColor(cfg.detailsEmbed.color);
              for (const key of Object.keys(meta.formValues || {})) {
                if (key === 'prizeAmount') continue;
                const label = (meta.formFieldsMap && meta.formFieldsMap[key]) ? meta.formFieldsMap[key].label : key;
                const value = meta.formValues[key] || '\u200b';
                detailEmbed.addFields({ name: label, value: value.toString().slice(0,1024), inline: false });
              }
              if (meta.prizeParsed) detailEmbed.addFields({ name: 'Prize amount', value: meta.prizeParsed.display, inline: false });
              await msg.edit({ embeds: [detailEmbed] }).catch(()=>null);
            }
          }
        } catch (e) { console.warn('update details failed', e?.message || e); }
        return safeReply(interaction, { content: `Prize updated to ${parsed ? parsed.display : amount}`, ephemeral: true });
      }
    }

    // Select menu → spam protection → show modal
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      const selected = interaction.values[0];
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (!userLastTicket.has(guildId)) userLastTicket.set(guildId, new Map());
      if (!userOptionLast.has(guildId)) userOptionLast.set(guildId, new Map());
      const guildMap = userLastTicket.get(guildId);
      const guildOptionMap = userOptionLast.get(guildId);

      const now = Date.now();
      const lastTicket = guildMap.get(userId) || 0;
      if (now - lastTicket < GLOBAL_TICKET_COOLDOWN_MS) {
        const left = Math.ceil((GLOBAL_TICKET_COOLDOWN_MS - (now - lastTicket)) / 1000);
        return safeReply(interaction, { content: `You are on cooldown. Please wait ${left}s before creating another ticket.`, ephemeral: true });
      }

      if (!guildOptionMap.has(userId)) guildOptionMap.set(userId, new Map());
      const perUserMap = guildOptionMap.get(userId);
      const lastOptionTime = perUserMap.get(selected) || 0;
      if (now - lastOptionTime < OPTION_COOLDOWN_MS) {
        const left = Math.ceil((OPTION_COOLDOWN_MS - (now - lastOptionTime)) / 1000);
        return safeReply(interaction, { content: `Please wait ${left}s before selecting this option again.`, ephemeral: true });
      }

      perUserMap.set(selected, now);
      userOptionLast.set(guildId, guildOptionMap);

      const cfg = getConfig(guildId);
      if (!cfg) return safeReply(interaction, { content: 'Server not configured', ephemeral: true });
      const opt = cfg.options.find(o => o.id === selected);
      if (!opt) return safeReply(interaction, { content: 'Option not found', ephemeral: true });

      let fields = Array.isArray(opt.form) ? opt.form.slice() : [{ id: 'summary', label: 'Short description', style: 'paragraph', required: true }];
      if (opt.isPrize && !fields.find(f=>f.id==='prizeAmount')) {
        fields.push({ id: 'prizeAmount', label: 'Prize amount', style: 'short', required: true, placeholder: '$100 or 100c' });
      }

      const modal = new ModalBuilder().setCustomId(`ticket_modal::${selected}`).setTitle(`Open ticket: ${opt.label}`);
      for (const f of fields.slice(0,5)) {
        const style = (f.style === 'short') ? TextInputStyle.Short : TextInputStyle.Paragraph;
        const input = new TextInputBuilder().setCustomId(f.id).setLabel(f.label || f.id).setStyle(style).setRequired(!!f.required).setPlaceholder(f.placeholder || '');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      }

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('showModal failed', err?.message || err);
        if (err && err.message && err.message.includes('Unknown interaction')) attemptRestart(err);
        return safeReply(interaction, { content: 'Could not open modal — try again.', ephemeral: true });
      }
      return;
    }

    // Modal submit → create ticket
    if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith('ticket_modal::')) return;
      const selected = interaction.customId.split('::')[1];
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      const cfg = getConfig(guildId);
      if (!cfg) return safeReply(interaction, { content: 'Server not configured', ephemeral: true });
      const opt = cfg.options.find(o => o.id === selected);
      if (!opt) return safeReply(interaction, { content: 'Option not found', ephemeral: true });

      if (!userLastTicket.has(guildId)) userLastTicket.set(guildId, new Map());
      const guildMap = userLastTicket.get(guildId);
      const now = Date.now();
      const lastTicket = guildMap.get(userId) || 0;
      if (now - lastTicket < GLOBAL_TICKET_COOLDOWN_MS) {
        const left = Math.ceil((GLOBAL_TICKET_COOLDOWN_MS - (now - lastTicket)) / 1000);
        return safeReply(interaction, { content: `You are on cooldown. Please wait ${left}s before creating another ticket.`, ephemeral: true });
      }

      let fieldsDef = Array.isArray(opt.form) ? opt.form.slice() : [{ id: 'summary', label: 'Short description', style: 'paragraph', required: true }];
      if (opt.isPrize && !fieldsDef.find(f=>f.id==='prizeAmount')) {
        fieldsDef.push({ id: 'prizeAmount', label: 'Prize amount', style: 'short', required: true, placeholder: '$100 or 100c' });
      }

      const formValues = {};
      for (const f of fieldsDef) {
        try { formValues[f.id] = interaction.fields.getTextInputValue(f.id); } catch { formValues[f.id] = null; }
        if (f.required && (!formValues[f.id] || formValues[f.id].trim() === '')) {
          return safeReply(interaction, { content: `Field "${f.label}" is required.`, ephemeral: true });
        }
      }

      const counter = cfg.ticketCounter = (cfg.ticketCounter || 0) + 1;
      saveConfig(guildId, cfg);

      const prefix = (opt.prefix && String(opt.prefix).trim().length>0) ? opt.prefix.trim() : opt.id;
      const ticketName = `${prefix}-${String(counter).padStart(4,'0')}`;

      const guild = interaction.guild;
      const categoryId = cfg.categoryId;
      let category = null;
      if (categoryId) {
        try { category = await guild.channels.fetch(categoryId).catch(()=>null); } catch {}
      }

      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ];
      const channel = await guild.channels.create({
        name: ticketName,
        type: ChannelType.GuildText,
        parent: category ? category.id : undefined,
        permissionOverwrites: overwrites
      });

      const summary = formValues.summary || '';
      const prizeAmountRaw = formValues.prizeAmount || null;
      const prizeParsed = parsePrizeAmount(prizeAmountRaw);
      const prizeDetails = formValues.prizeDetails || null;

      const formFieldsMap = {};
      for (const f of fieldsDef) formFieldsMap[f.id] = { label: f.label, style: f.style, required: !!f.required };

      const metadata = {
        ticketId: counter,
        channelId: channel.id,
        type: opt.id,
        label: opt.label,
        isPrize: !!opt.isPrize,
        prizeAmount: prizeAmountRaw,
        prizeParsed: prizeParsed,
        prizeDetails,
        ownerId: interaction.user.id,
        createdAt: new Date().toISOString(),
        summary,
        formValues,
        formFieldsMap,
        prefix,
        closed: false
      };
      saveChannelMeta(interaction.guildId, channel.id, metadata);

      // set global ticket cooldown now
      guildMap.set(userId, Date.now());
      userLastTicket.set(guildId, guildMap);

      // respond per-option + attach CLOSE button to all respond messages
      const openCloseBtn = new ButtonBuilder().setCustomId(`ticket_close::${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒');
      const respondRow = new ActionRowBuilder().addComponents(openCloseBtn);

      const openingTemplate = opt.respondContent || cfg.respondOpeningGlobal || 'Hello {user}, support will be with you shortly.';
      const openingText = openingTemplate.replace(/\{user\}/g, `<@${interaction.user.id}>`).replace(/\{summary\}/g, summary);

      let openingMessage;
      if (opt.respondUseEmbed) {
        const rEmbed = new EmbedBuilder().setDescription(openingText).setTimestamp();
        if (cfg.panelEmbed && cfg.panelEmbed.color) rEmbed.setColor(cfg.panelEmbed.color);
        const sent = await channel.send({ embeds: [rEmbed], components: [respondRow] });
        openingMessage = sent;
        metadata.respondMessageId = sent.id;
      } else {
        const sent = await channel.send({ content: openingText, components: [respondRow] });
        openingMessage = sent;
        metadata.respondMessageId = sent.id;
      }

      // For prize options: details embed with CLOSE button (close already added above to respond; keep details close too)
      if (metadata.isPrize) {
        const detailsEmbed = new EmbedBuilder().setTitle(cfg.detailsEmbed?.title || 'Details').setTimestamp();
        if (cfg.detailsEmbed?.color) detailsEmbed.setColor(cfg.detailsEmbed.color);
        for (const key of Object.keys(formValues)) {
          if (key === 'prizeAmount') continue;
          const label = formFieldsMap[key] ? formFieldsMap[key].label : key;
          const value = formValues[key] && formValues[key].toString().length > 0 ? formValues[key].toString() : '\u200b';
          detailsEmbed.addFields({ name: label, value: value.slice(0,1024), inline: false });
        }
        if (metadata.prizeParsed) detailsEmbed.addFields({ name: 'Prize amount', value: metadata.prizeParsed.display, inline: false });
        // include CLOSE button here as well
        const detailsCloseBtn = new ButtonBuilder().setCustomId(`ticket_close::${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒');
        const detailsRow = new ActionRowBuilder().addComponents(detailsCloseBtn);
        const detailsMsg = await channel.send({ embeds: [detailsEmbed], components: [detailsRow] });
        // prefer details as respondMessageId for later edits
        metadata.respondMessageId = detailsMsg.id;
      }

      saveChannelMeta(interaction.guildId, channel.id, metadata);
      return safeReply(interaction, { content: `Ticket created: ${channel}`, ephemeral: true });
    }

    // Button interactions
    if (interaction.isButton && interaction.isButton()) {
      const cid = String(interaction.customId || '');
      const [action, channelId] = cid.split('::');
      const ch = interaction.channel;

      // Validate channel
      if (!ch || ch.id !== channelId) {
        return safeReply(interaction, { content: 'This button is not valid here.', ephemeral: true });
      }
      const meta = loadChannelMeta(interaction.guildId, ch.id);
      if (!meta) return safeReply(interaction, { content: 'Ticket metadata missing.', ephemeral: true });

      // CLOSE (owner or admin)
      if (action === 'ticket_close') {
        const invokerIsOwner = interaction.user.id === meta.ownerId;
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsOwner && !invokerIsAdmin) return safeReply(interaction, { content: 'Only ticket owner or staff can close.', ephemeral: true });

        const closedName = `closed-${String(meta.ticketId).padStart(4,'0')}`;
        try { await ch.edit({ name: closedName }); } catch (e) { console.warn('rename failed', e?.message || e); }
        try { await ch.permissionOverwrites.edit(meta.ownerId, { ViewChannel: false, SendMessages: false, ReadMessageHistory: false }).catch(()=>null); } catch (e) {}
        meta.closed = true; meta.closedAt = new Date().toISOString(); meta.closedBy = interaction.user.id;
        saveChannelMeta(interaction.guildId, ch.id, meta);

        // disable existing respond message close buttons & mark closed (if respondMessage present)
        try {
          if (meta.respondMessageId) {
            const m = await ch.messages.fetch(meta.respondMessageId).catch(()=>null);
            if (m && m.edit) {
              const disableRow = new ActionRowBuilder().addComponents([ new ButtonBuilder().setCustomId('disabled').setLabel(`Closed by ${interaction.user.username}`).setStyle(ButtonStyle.Secondary).setDisabled(true).setEmoji('🔒') ]);
              if (m.embeds && m.embeds.length > 0) {
                const newEmbed = EmbedBuilder.from(m.embeds[0]).setFooter({ text: `Closed by ${interaction.user.tag}` });
                await m.edit({ embeds: [newEmbed], components: [disableRow] }).catch(()=>null);
              } else {
                await m.edit({ content: `${m.content || ''}\n\nClosed by <@${interaction.user.id}>`, components: [disableRow] }).catch(()=>null);
              }
            }
          }
        } catch (e) { console.warn('disable close failed', e?.message || e); }

        // Post support controls (Transcript / Open / Delete) visible in channel (clicks permission-checked)
        await postSupportControls(ch, meta);

        return safeReply(interaction, { content: `Ticket closed by <@${interaction.user.id}>`, ephemeral: false });
      }

      // CONFIRM (owner or admin) -> finalize & archive
      if (action === 'ticket_confirm') {
        const invokerIsOwner = interaction.user.id === meta.ownerId;
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsOwner && !invokerIsAdmin) return safeReply(interaction, { content: 'Only owner or staff can confirm.', ephemeral: true });

        try {
          await safeUpdate(interaction, { content: `${interaction.message.content}\n\nConfirmed by <@${interaction.user.id}> — archiving...`, components: [] });
        } catch (e) { /* ignore */ }

        const cfg = getConfig(interaction.guildId) || {};
        await ensureTranscriptChannel(interaction.guild, cfg).catch(()=>null);

        await archiveAndDeleteChannel(interaction, interaction.guildId, ch, meta, interaction.user.tag, interaction.user.id);
        return;
      }

      // SUPPORT: Transcript (admin)
      if (action === 'support_transcript') {
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsAdmin) return safeReply(interaction, { content: 'Only staff can request transcript.', ephemeral: true });
        // Look for archived file
        const guildId = interaction.guildId;
        const ticketId = meta.ticketId;
        const filePath = path.join(DATA_DIR, 'tickets', `${guildId}`, `${ticketId}.json`);
        if (!fs.existsSync(filePath)) return safeReply(interaction, { content: 'Archive not found for this ticket.', ephemeral: true });
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const guild = await client.guilds.fetch(guildId).catch(()=>null);
          const cfg = getConfig(guildId) || {};
          const transcriptCh = guild ? await ensureTranscriptChannel(guild, cfg).catch(()=>null) : null;
          if (!transcriptCh) return safeReply(interaction, { content: 'Transcript channel not available.', ephemeral: true });
          // send a short summary + attach json as file
          await transcriptCh.send({ content: `Transcript for ticket ${meta.prefix || meta.type}-${String(meta.ticketId).padStart(4,'0')} (closed by <@${meta.closedBy || 'unknown'}>):`, files: [{ attachment: Buffer.from(content, 'utf8'), name: `ticket-${ticketId}.json` }] });
          return safeReply(interaction, { content: 'Transcript posted.', ephemeral: true });
        } catch (e) { console.warn('support_transcript failed', e?.message || e); return safeReply(interaction, { content: 'Failed to post transcript.', ephemeral: true }); }
      }

      // SUPPORT: Open (admin) -> reopen channel (restore owner perms, rename)
      if (action === 'support_open') {
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsAdmin) return safeReply(interaction, { content: 'Only staff can reopen tickets.', ephemeral: true });
        try {
          const metaNow = loadChannelMeta(interaction.guildId, ch.id);
          if (!metaNow) return safeReply(interaction, { content: 'Ticket meta missing.', ephemeral: true });
          const newName = `${metaNow.prefix || metaNow.type}-${String(metaNow.ticketId).padStart(4,'0')}`;
          await ch.edit({ name: newName }).catch(()=>null);
          await ch.permissionOverwrites.edit(metaNow.ownerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(()=>null);
          metaNow.closed = false; metaNow.closedAt = null; metaNow.closedBy = null;
          saveChannelMeta(interaction.guildId, ch.id, metaNow);
          // remove support control message if exists
          if (metaNow.controlMessageId) {
            try { const controlMsg = await ch.messages.fetch(metaNow.controlMessageId).catch(()=>null); if (controlMsg) await controlMsg.delete().catch(()=>null); } catch {}
            metaNow.controlMessageId = null; saveChannelMeta(interaction.guildId, ch.id, metaNow);
          }
          return safeReply(interaction, { content: `Ticket reopened as ${newName}`, ephemeral: true });
        } catch (e) { console.warn('support_open failed', e?.message || e); return safeReply(interaction, { content: 'Failed to reopen ticket.', ephemeral: true }); }
      }

      // SUPPORT: Delete (admin) -> archive+delete channel
      if (action === 'support_delete') {
        const invokerIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!invokerIsAdmin) return safeReply(interaction, { content: 'Only staff can delete tickets.', ephemeral: true });
        try {
          await safeReply(interaction, { content: 'Deleting ticket and archiving...', ephemeral: true });
          await archiveAndDeleteChannel(interaction, interaction.guildId, ch, meta, interaction.user.tag, interaction.user.id);
          return; // archiveAndDeleteChannel deletes channel
        } catch (e) { console.warn('support_delete failed', e?.message || e); return safeReply(interaction, { content: 'Failed to delete ticket.', ephemeral: true }); }
      }

      // fallback
      return safeReply(interaction, { content: 'Unknown button action.', ephemeral: true });
    }

  } catch (err) {
    console.error('interaction handler error', err?.stack || err);
    try {
      const msg = err && err.message ? err.message : '';
      if (msg.includes('Unknown interaction') || msg.includes('Unknown Message') || msg.includes('10062')) {
        attemptRestart(err);
      }
    } catch (e) { console.warn('restart check failed', e?.message || e); }

    try { await safeReply(interaction, { content: 'Internal error', ephemeral: true }); } catch {}
  }
});

// message logging
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const meta = loadChannelMeta(message.guildId, message.channelId || message.channel.id);
  if (!meta) return;
  try {
    const guildDir = path.join(DATA_DIR, 'tickets', `${message.guildId}`);
    if (!fs.existsSync(guildDir)) fs.mkdirSync(guildDir, { recursive: true });
    const liveFile = path.join(guildDir, `${meta.ticketId}_live.json`);
    let live = [];
    if (fs.existsSync(liveFile)) {
      try { live = JSON.parse(fs.readFileSync(liveFile,'utf8')); } catch { live = []; }
    }
    live.push({ id: message.id, author: { id: message.author.id, tag: message.author.tag }, content: message.content, createdAt: message.createdAt });
    fs.writeFileSync(liveFile, JSON.stringify(live));
  } catch (e) { console.warn('live write fail', e?.message || e); }
});

// global handlers
process.on('unhandledRejection', (reason) => {
  try {
    console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
    const msg = reason && reason.message ? reason.message : String(reason);
    if (msg && msg.includes('Unknown interaction')) attemptRestart(reason);
  } catch (e) { console.error('error in unhandledRejection handler', e); }
});
process.on('uncaughtException', (err) => {
  try {
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
    attemptRestart(err);
  } catch (e) { console.error('error in uncaughtException handler', e); }
});

// login
client.login(token).catch(err => { console.error('Login failed', err); process.exit(1); });
