const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const fs   = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ]
});

// ── Config ─────────────────────────────────────────────────────────────────
const TOKEN             = 'YOUR_BOT_TOKEN';
const CLIENT_ID         = 'YOUR_CLIENT_ID';
const SHIFTS_CHANNEL_ID = 'YOUR_SHIFTS_CHANNEL_ID';
const ALLOWED_ROLE_ID   = 'YOUR_ALLOWED_ROLE_ID';   // role that can create/end/cancel shifts
const PING_ROLE_ID      = 'YOUR_PING_ROLE_ID';       // role to ping on new shift (leave '' to disable)
const TIMEZONE_OFFSET   = 2;                          // UTC+2 for Amsterdam (CEST)
// ──────────────────────────────────────────────────────────────────────────

http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

// ── Persistent storage ─────────────────────────────────────────────────────
const DATA_FILE = '/tmp/shifts.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('❌ Error loading data:', err);
  }
  return { shifts: [], nextId: 1, shiftBoardMessageId: null };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ shifts, nextId, shiftBoardMessageId }, null, 2));
  } catch (err) {
    console.error('❌ Error saving data:', err);
  }
}

let { shifts, nextId, shiftBoardMessageId } = loadData();
// ──────────────────────────────────────────────────────────────────────────

function toUnixTimestamp(date, time) {
  const [day, month, year] = date.split('-').map(Number);
  const [hours, minutes]   = time.split(':').map(Number);
  const utcMs = Date.UTC(year, month - 1, day, hours - TIMEZONE_OFFSET, minutes);
  return Math.floor(utcMs / 1000);
}

function discordTimestamp(unix) {
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function hasAllowedRole(member) {
  if (!ALLOWED_ROLE_ID) return true;
  return member.roles.cache.has(ALLOWED_ROLE_ID);
}

// ── Shift board builder ────────────────────────────────────────────────────
function buildShiftBoard() {
  const embed = new EmbedBuilder()
    .setTitle('Shifts Board')
    .setColor(0x2B2D31)
    .setTimestamp();

  if (shifts.length === 0) {
    embed.setDescription('*No active shifts*');
    return embed;
  }

  let description = '';

  for (const shift of shifts) {
    if (shift.type === 'promotional') {
      description += `🗓️ **Promotional Shift** - ${discordTimestamp(shift.unix)} hosted by ${shift.host}`;
      if (shift.cohost) description += ` & ${shift.cohost}`;
      description += `\n`;
      if (shift.helpers) description += `> **Helpers:** ${shift.helpers}\n`;
      description += `> **Status:** 🟡 Pending\n`;
    } else {
      description += `🕐 **Shift #${shift.id}** — **${shift.role}** — ${discordTimestamp(shift.unix)}\n`;
      description += `> **Status:** ✅ Active *(auto-ends 30 min after shift time)*\n`;
    }
    description += '\n';
  }

  embed.setDescription(description.trim());
  return embed;
}

async function postNewBoard(channel) {
  const msg = await channel.send({ embeds: [buildShiftBoard()] });
  shiftBoardMessageId = msg.id;
  saveData();
  console.log(`✅ Shift board posted! ID: ${shiftBoardMessageId}`);
}

async function updateShiftBoard() {
  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    if (!channel) return;
    if (shiftBoardMessageId) {
      try {
        const msg = await channel.messages.fetch(shiftBoardMessageId);
        await msg.edit({ embeds: [buildShiftBoard()] });
        console.log('✅ Shift board updated!');
        return;
      } catch {
        shiftBoardMessageId = null;
      }
    }
    await postNewBoard(channel);
  } catch (err) {
    console.error('❌ Error updating shift board:', err);
  }
}

// ── Auto-delete regular shifts 30 minutes after shift time ─────────────────
function scheduleAutoEnd(shift) {
  if (shift.type !== 'regular') return;

  const now    = Math.floor(Date.now() / 1000);
  const endsAt = shift.unix + 30 * 60;
  const delay  = Math.max((endsAt - now) * 1000, 0);

  console.log(`⏱️ Shift #${shift.id} auto-ends in ${Math.round(delay / 1000)}s`);

  setTimeout(async () => {
    const index = shifts.findIndex(s => s.id === shift.id);
    if (index === -1) return;

    shifts.splice(index, 1);
    saveData();
    await updateShiftBoard();

    try {
      const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`⏰ Shift #${shift.id} Auto-Ended`)
            .setColor(0xFEE75C)
            .setDescription(`Shift **#${shift.id}** (*${shift.role}*) has automatically ended 30 minutes after its start time.`)
        ]
      });
    } catch (err) {
      console.error('❌ Error sending auto-end message:', err);
    }
  }, delay);
}

// ── Slash commands ─────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Manage shifts')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a regular shift')
        .addStringOption(opt => opt.setName('date').setDescription('Date (DD-MM-YYYY)').setRequired(true))
        .addStringOption(opt => opt.setName('time').setDescription('Time in your timezone (HH:MM)').setRequired(true))
        .addStringOption(opt => opt.setName('role').setDescription('Role/position (e.g. Cashier)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('promotional')
        .setDescription('Create a promotional shift')
        .addStringOption(opt => opt.setName('date').setDescription('Date (DD-MM-YYYY)').setRequired(true))
        .addStringOption(opt => opt.setName('time').setDescription('Time in your timezone (HH:MM)').setRequired(true))
        .addStringOption(opt => opt.setName('host').setDescription('Host (mention or name)').setRequired(true))
        .addStringOption(opt => opt.setName('cohost').setDescription('Co-host (mention or name)').setRequired(false))
        .addStringOption(opt => opt.setName('helpers').setDescription('Helpers (mentions or names)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End a shift by ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Shift ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a shift by ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Shift ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all active shifts')
    )
].map(cmd => cmd.toJSON());

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  // Reschedule auto-end timers for existing shifts after restart
  for (const shift of shifts) {
    if (shift.type === 'regular') scheduleAutoEnd(shift);
  }

  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    if (channel) {
      if (shiftBoardMessageId) {
        try {
          await channel.messages.fetch(shiftBoardMessageId);
          console.log(`✅ Found existing shift board: ${shiftBoardMessageId}`);
          await updateShiftBoard();
        } catch {
          console.log('⚠️ Board message not found, posting new one...');
          shiftBoardMessageId = null;
          await postNewBoard(channel);
        }
      } else {
        const messages = await channel.messages.fetch({ limit: 50 });
        const boardMsg = messages.find(m =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === 'Shifts Board'
        );
        if (boardMsg) {
          shiftBoardMessageId = boardMsg.id;
          saveData();
          await updateShiftBoard();
        } else {
          await postNewBoard(channel);
        }
      }
    }
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
});

// ── Interaction handler ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'shift') return;

  const sub = interaction.options.getSubcommand();
  console.log(`📥 /shift ${sub} by ${interaction.user.username}`);

  try {
    if (sub !== 'list') {
      if (!hasAllowedRole(interaction.member)) {
        return await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🚫 No Permission')
              .setColor(0xED4245)
              .setDescription(`You don't have the required role to use this command.`)
          ],
          ephemeral: true
        });
      }
    }

    // ── /shift create ────────────────────────────────────────────────────
    if (sub === 'create') {
      const date = interaction.options.getString('date');
      const time = interaction.options.getString('time');
      const role = interaction.options.getString('role');
      const unix = toUnixTimestamp(date, time);

      const shift = { id: nextId++, type: 'regular', date, time, role, unix };
      shifts.push(shift);
      saveData();
      scheduleAutoEnd(shift);
      await updateShiftBoard();

      const pingText = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '';

      await interaction.reply({
        content: pingText ? `${pingText} — Shift #${shift.id} has been scheduled!` : `Shift #${shift.id} has been scheduled!`,
        embeds: [
          new EmbedBuilder()
            .setTitle(`✅ Shift #${shift.id} Created`)
            .setColor(0x57F287)
            .addFields(
              { name: '🎭 Role',       value: role,                              inline: true  },
              { name: '🕐 When',       value: discordTimestamp(unix),            inline: false },
              { name: '⏱️ Auto-ends', value: '30 minutes after shift time',     inline: false }
            )
            .setFooter({ text: `Created by ${interaction.user.username}` })
        ],
        allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] }
      });

    // ── /shift promotional ───────────────────────────────────────────────
    } else if (sub === 'promotional') {
      const date    = interaction.options.getString('date');
      const time    = interaction.options.getString('time');
      const host    = interaction.options.getString('host');
      const cohost  = interaction.options.getString('cohost') || null;
      const helpers = interaction.options.getString('helpers') || null;
      const unix    = toUnixTimestamp(date, time);

      const shift = { id: nextId++, type: 'promotional', date, time, host, cohost, helpers, unix };
      shifts.push(shift);
      saveData();
      await updateShiftBoard();

      const pingText = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '';
      const fields = [
        { name: '🕐 When', value: discordTimestamp(unix), inline: false },
        { name: '👑 Host', value: host,                   inline: true  },
      ];
      if (cohost)  fields.push({ name: '🤝 Co-host', value: cohost,  inline: true  });
      if (helpers) fields.push({ name: '🙋 Helpers', value: helpers, inline: false });

      await interaction.reply({
        content: pingText ? `${pingText} — Promotional Shift #${shift.id} has been scheduled!` : `Promotional Shift #${shift.id} has been scheduled!`,
        embeds: [
          new EmbedBuilder()
            .setTitle(`📣 Promotional Shift #${shift.id} Created`)
            .setColor(0x5865F2)
            .addFields(...fields)
            .setFooter({ text: `Created by ${interaction.user.username}` })
        ],
        allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] }
      });

    // ── /shift end ───────────────────────────────────────────────────────
    } else if (sub === 'end') {
      const id    = interaction.options.getInteger('id');
      const index = shifts.findIndex(s => s.id === id);

      if (index === -1) {
        return await interaction.reply({ content: `⚠️ No active shift found with ID **#${id}**.`, ephemeral: true });
      }

      const shift = shifts.splice(index, 1)[0];
      saveData();
      await updateShiftBoard();

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🏁 Shift #${shift.id} Ended`)
            .setColor(0xFEE75C)
            .setDescription(`Shift **#${shift.id}** has been manually ended.`)
            .setFooter({ text: `Ended by ${interaction.user.username}` })
        ]
      });

    // ── /shift cancel ────────────────────────────────────────────────────
    } else if (sub === 'cancel') {
      const id    = interaction.options.getInteger('id');
      const index = shifts.findIndex(s => s.id === id);

      if (index === -1) {
        return await interaction.reply({ content: `⚠️ No active shift found with ID **#${id}**.`, ephemeral: true });
      }

      const shift = shifts.splice(index, 1)[0];
      saveData();
      await updateShiftBoard();

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`❌ Shift #${shift.id} Cancelled`)
            .setColor(0xED4245)
            .setDescription(`Shift **#${shift.id}** has been cancelled.`)
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
        ]
      });

    // ── /shift list ──────────────────────────────────────────────────────
    } else if (sub === 'list') {
      await interaction.reply({ embeds: [buildShiftBoard()], ephemeral: true });
    }

  } catch (err) {
    console.error('❌ Command error:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong, please try again.', ephemeral: true });
      }
    } catch {}
  }
});

process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException',  err => console.error('❌ Uncaught exception:', err));

client.login(TOKEN);
