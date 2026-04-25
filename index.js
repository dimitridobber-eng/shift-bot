const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require(‘http’);
const fs = require(‘fs’);

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildMessages,
]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SHIFTS_CHANNEL_ID = process.env.SHIFTS_CHANNEL_ID;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;
const PING_ROLE_ID = process.env.PING_ROLE_ID;
const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET || ‘2’);

http.createServer(function(req, res) { res.end(‘ok’); }).listen(process.env.PORT || 3000);

const DATA_FILE = ‘/tmp/shifts.json’;

function loadData() {
try {
if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, ‘utf8’));
} catch (e) {}
return { shifts: [], nextId: 1, shiftBoardMessageId: null };
}

function saveData() {
try {
fs.writeFileSync(DATA_FILE, JSON.stringify({ shifts: shifts, nextId: nextId, shiftBoardMessageId: shiftBoardMessageId }, null, 2));
} catch (e) {}
}

var data = loadData();
var shifts = data.shifts;
var nextId = data.nextId;
var shiftBoardMessageId = data.shiftBoardMessageId;

function toUnix(date, time) {
var dp = date.split(’-’).map(Number);
var tp = time.split(’:’).map(Number);
return Math.floor(Date.UTC(dp[2], dp[1] - 1, dp[0], tp[0] - TIMEZONE_OFFSET, tp[1]) / 1000);
}

function ts(unix) {
return ‘<t:’ + unix + ‘:F> (<t:’ + unix + ‘:R>)’;
}

function allowed(member) {
if (!ALLOWED_ROLE_ID) return true;
return member.roles.cache.has(ALLOWED_ROLE_ID);
}

function buildBoard() {
var embed = new EmbedBuilder().setTitle(‘Shifts Board’).setColor(0x2B2D31).setTimestamp();
if (shifts.length === 0) return embed.setDescription(‘No active shifts’);
var desc = ‘’;
for (var i = 0; i < shifts.length; i++) {
var s = shifts[i];
if (s.type === ‘promotional’) {
desc += ’🗓️ **Promotional Shift** - ’ + ts(s.unix) + ’ hosted by ’ + s.host;
if (s.cohost) desc += ’ & ’ + s.cohost;
desc += ‘\n’;
if (s.helpers) desc += ‘> **Helpers:** ’ + s.helpers + ‘\n’;
desc += ‘> **Status:** 🟡 Pending\n\n’;
} else {
desc += ‘🕐 **Shift #’ + s.id + ’** — **’ + s.role + ’** — ’ + ts(s.unix) + ‘\n’;
desc += ‘> **Status:** ✅ Active (auto-ends 30 min after shift time)\n\n’;
}
}
return embed.setDescription(desc.trim());
}

async function postBoard(channel) {
var msg = await channel.send({ embeds: [buildBoard()] });
shiftBoardMessageId = msg.id;
saveData();
}

async function updateBoard() {
try {
var ch = await client.channels.fetch(SHIFTS_CHANNEL_ID);
if (!ch) return;
if (shiftBoardMessageId) {
try {
var msg = await ch.messages.fetch(shiftBoardMessageId);
await msg.edit({ embeds: [buildBoard()] });
return;
} catch (e) { shiftBoardMessageId = null; }
}
await postBoard(ch);
} catch (e) { console.error(‘updateBoard error:’, e); }
}

function scheduleAutoEnd(shift) {
if (shift.type !== ‘regular’) return;
var delay = Math.max((shift.unix + 1800 - Math.floor(Date.now() / 1000)) * 1000, 0);
setTimeout(async function() {
var idx = -1;
for (var i = 0; i < shifts.length; i++) { if (shifts[i].id === shift.id) { idx = i; break; } }
if (idx === -1) return;
shifts.splice(idx, 1);
saveData();
await updateBoard();
try {
var ch = await client.channels.fetch(SHIFTS_CHANNEL_ID);
await ch.send({ embeds: [new EmbedBuilder().setTitle(‘Shift #’ + shift.id + ’ Auto-Ended’).setColor(0xFEE75C).setDescription(‘Shift #’ + shift.id + ’ (’ + shift.role + ‘) ended automatically.’)] });
} catch (e) {}
}, delay);
}

var commands = [
new SlashCommandBuilder().setName(‘shift’).setDescription(‘Manage shifts’)
.addSubcommand(function(s) { return s.setName(‘create’).setDescription(‘Create a regular shift’).addStringOption(function(o) { return o.setName(‘date’).setDescription(‘DD-MM-YYYY’).setRequired(true); }).addStringOption(function(o) { return o.setName(‘time’).setDescription(‘HH:MM’).setRequired(true); }).addStringOption(function(o) { return o.setName(‘role’).setDescription(‘Role/position’).setRequired(true); }); })
.addSubcommand(function(s) { return s.setName(‘promotional’).setDescription(‘Create a promotional shift’).addStringOption(function(o) { return o.setName(‘date’).setDescription(‘DD-MM-YYYY’).setRequired(true); }).addStringOption(function(o) { return o.setName(‘time’).setDescription(‘HH:MM’).setRequired(true); }).addStringOption(function(o) { return o.setName(‘host’).setDescription(‘Host’).setRequired(true); }).addStringOption(function(o) { return o.setName(‘cohost’).setDescription(‘Co-host’).setRequired(false); }).addStringOption(function(o) { return o.setName(‘helpers’).setDescription(‘Helpers’).setRequired(false); }); })
.addSubcommand(function(s) { return s.setName(‘end’).setDescription(‘End a shift by ID’).addIntegerOption(function(o) { return o.setName(‘id’).setDescription(‘Shift ID’).setRequired(true); }); })
.addSubcommand(function(s) { return s.setName(‘cancel’).setDescription(‘Cancel a shift by ID’).addIntegerOption(function(o) { return o.setName(‘id’).setDescription(‘Shift ID’).setRequired(true); }); })
.addSubcommand(function(s) { return s.setName(‘list’).setDescription(‘Show all active shifts’); })
].map(function(c) { return c.toJSON(); });

client.once(‘ready’, async function() {
console.log(’Bot online: ’ + client.user.tag);
var rest = new REST({ version: ‘10’ }).setToken(TOKEN);
try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands }); console.log(‘Commands registered’); } catch (e) { console.error(e); }
for (var i = 0; i < shifts.length; i++) { if (shifts[i].type === ‘regular’) scheduleAutoEnd(shifts[i]); }
try {
var ch = await client.channels.fetch(SHIFTS_CHANNEL_ID);
if (ch) {
if (shiftBoardMessageId) {
try { await ch.messages.fetch(shiftBoardMessageId); await updateBoard(); } catch (e) { shiftBoardMessageId = null; await postBoard(ch); }
} else {
var msgs = await ch.messages.fetch({ limit: 50 });
var found = msgs.find(function(m) { return m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === ‘Shifts Board’; });
if (found) { shiftBoardMessageId = found.id; saveData(); await updateBoard(); } else { await postBoard(ch); }
}
}
} catch (e) { console.error(‘Startup error:’, e); }
});

client.on(‘interactionCreate’, async function(interaction) {
if (!interaction.isChatInputCommand() || interaction.commandName !== ‘shift’) return;
var sub = interaction.options.getSubcommand();
try {
if (sub !== ‘list’ && !allowed(interaction.member)) {
return await interaction.reply({ embeds: [new EmbedBuilder().setTitle(‘No Permission’).setColor(0xED4245).setDescription(‘You do not have the required role.’)], ephemeral: true });
}
if (sub === ‘create’) {
var date = interaction.options.getString(‘date’);
var time = interaction.options.getString(‘time’);
var role = interaction.options.getString(‘role’);
var unix = toUnix(date, time);
var shift = { id: nextId++, type: ‘regular’, date: date, time: time, role: role, unix: unix };
shifts.push(shift); saveData(); scheduleAutoEnd(shift); await updateBoard();
var ping = PING_ROLE_ID ? ‘<@&’ + PING_ROLE_ID + ‘>’ : ‘’;
await interaction.reply({
content: ping ? ping + ’ - Shift #’ + shift.id + ’ scheduled!’ : ‘Shift #’ + shift.id + ’ scheduled!’,
embeds: [new EmbedBuilder().setTitle(‘Shift #’ + shift.id + ’ Created’).setColor(0x57F287).addFields({ name: ‘Role’, value: role, inline: true }, { name: ‘When’, value: ts(unix), inline: false }, { name: ‘Auto-ends’, value: ‘30 min after shift time’, inline: false }).setFooter({ text: ‘Created by ’ + interaction.user.username })],
allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] }
});
} else if (sub === ‘promotional’) {
var date = interaction.options.getString(‘date’);
var time = interaction.options.getString(‘time’);
var host = interaction.options.getString(‘host’);
var cohost = interaction.options.getString(‘cohost’) || null;
var helpers = interaction.options.getString(‘helpers’) || null;
var unix = toUnix(date, time);
var shift = { id: nextId++, type: ‘promotional’, date: date, time: time, host: host, cohost: cohost, helpers: helpers, unix: unix };
shifts.push(shift); saveData(); await updateBoard();
var ping = PING_ROLE_ID ? ‘<@&’ + PING_ROLE_ID + ‘>’ : ‘’;
var embedP = new EmbedBuilder().setTitle(‘Promotional Shift #’ + shift.id + ’ Created’).setColor(0x5865F2);
embedP.addFields({ name: ‘When’, value: ts(unix), inline: false });
embedP.addFields({ name: ‘Host’, value: host, inline: true });
if (cohost) embedP.addFields({ name: ‘Co-host’, value: cohost, inline: true });
if (helpers) embedP.addFields({ name: ‘Helpers’, value: helpers, inline: false });
embedP.setFooter({ text: ‘Created by ’ + interaction.user.username });
await interaction.reply({
content: ping ? ping + ’ - Promotional Shift #’ + shift.id + ’ scheduled!’ : ‘Promotional Shift #’ + shift.id + ’ scheduled!’,
embeds: [embedP],
allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] }
});
} else if (sub === ‘end’) {
var id = interaction.options.getInteger(‘id’);
var idx = -1;
for (var i = 0; i < shifts.length; i++) { if (shifts[i].id === id) { idx = i; break; } }
if (idx === -1) return await interaction.reply({ content: ‘No shift found with ID #’ + id, ephemeral: true });
var shift = shifts.splice(idx, 1)[0]; saveData(); await updateBoard();
await interaction.reply({ embeds: [new EmbedBuilder().setTitle(‘Shift #’ + shift.id + ’ Ended’).setColor(0xFEE75C).setDescription(‘Shift #’ + shift.id + ’ has been manually ended.’).setFooter({ text: ‘Ended by ’ + interaction.user.username })] });
} else if (sub === ‘cancel’) {
var id = interaction.options.getInteger(‘id’);
var idx = -1;
for (var i = 0; i < shifts.length; i++) { if (shifts[i].id === id) { idx = i; break; } }
if (idx === -1) return await interaction.reply({ content: ‘No shift found with ID #’ + id, ephemeral: true });
var shift = shifts.splice(idx, 1)[0]; saveData(); await updateBoard();
await interaction.reply({ embeds: [new EmbedBuilder().setTitle(‘Shift #’ + shift.id + ’ Cancelled’).setColor(0xED4245).setDescription(‘Shift #’ + shift.id + ’ has been cancelled.’).setFooter({ text: ’Cancelled by ’ + interaction.user.username })] });
} else if (sub === ‘list’) {
await interaction.reply({ embeds: [buildBoard()], ephemeral: true });
}
} catch (e) {
console.error(‘Command error:’, e);
try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: ‘Something went wrong.’, ephemeral: true }); } catch (e2) {}
}
});

process.on(‘unhandledRejection’, function(e) { console.error(e); });
process.on(‘uncaughtException’, function(e) { console.error(e); });

client.login(TOKEN);
