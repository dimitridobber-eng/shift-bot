const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ]
});

// ── Config from Railway Environment Variables ──────────────────────────────
const TOKEN             = process.env.DISCORD_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const SHIFTS_CHANNEL_ID = process.env.SHIFTS_CHANNEL_ID;
const ALLOWED_ROLE_ID   = process.env.ALLOWED_ROLE_ID;
const PING_ROLE_ID      = process.env.PING_ROLE_ID;
// Bot timezone offset in hours from UTC, e.g. 2 for Amsterdam (CEST)
const TIMEZONE_OFFSET   = parseInt(process.env.TIMEZONE_OFFSET || '2');
// ──────────────────────────────────────────────────────────────────────────

// Keep Railway awake
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

// ── Persistent storage ────────────────────────────────────────────────────
const DATA_FILE = '/tmp/shifts.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
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

// Convert "25-03-2026" + "20:00" to a Unix timestamp using the bot's timezone
function toUnixTimestamp(date, time) {
  // date format: DD-MM-YYYY, time format: HH:MM
  const [day, month, year] = date.split('-').map(Number);
  const [hours, minutes]   = time.split(':').map(Number);

  // Build UTC time by subtracting timezone offset
  const utcMs = Date.UTC(year, month - 1, day, hours - TIMEZONE_OFFSET, minutes);
  return Math.floor(utcMs / 1000);
}

// Discord timestamp formats:
// <t:UNIX:F> = full date + time (e.g. Sunday, 5 April 2026 20:00)
// <t:UNIX:R> = relative (e.g. in 2 hours)
function discordTimestamp(unix) {
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Manage shifts')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new shift')
        .addStringOption(opt => opt.setName('date').setDescription('Date (e.g. 25-03-2026)').setRequired(true))
        .addStringOption(opt => opt.setName('time').setDescription('Time in your timezone (e.g. 20:00)').setRequired(true))
        .addStringOption(opt => opt.setName('role').setDescription('Role/position (e.g. Cashier)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a shift by its ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Shift ID number (e.g. 1)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End a shift by its ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Shift ID number (e.g. 1)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all active shifts')
    )
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`📋 Shifts channel ID : ${SHIFTS_CHANNEL_ID}`);
  console.log(`🕐 Timezone offset   : UTC+${TIMEZONE_OFFSET}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    if (channel) {
      if (shiftBoardMessageId) {
        try {
          await channel.messages.fetch(shiftBoardMessageId);
          console.log(`✅ Found existing shift board: ${shiftBoardMessageId}`);
        } catch {
          console.log('⚠️ Saved board message not found, posting new one...');
          shiftBoardMessageId = null;
          await postNewBoard(channel);
        }
      } else {
        const messages = await channel.messages.fetch({ limit: 50 });
        const boardMsg = messages.find(m =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === '📋 Shift Board'
        );
        if (boardMsg) {
          shiftBoardMessageId = boardMsg.id;
          saveData();
          console.log(`✅ Found existing shift board: ${shiftBoardMessageId}`);
        } else {
          await postNewBoard(channel);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error on startup:', err);
  }
});

function hasAllowedRole(member) {
  if (!ALLOWED_ROLE_ID) return true;
  return member.roles.cache.has(ALLOWED_ROLE_ID);
}

function buildShiftBoard() {
  const embed = new EmbedBuilder()
    .setTitle('📋 Shift Board')
    .setColor(0x5865F2)
    .setTimestamp();

  if (shifts.length === 0) {
    embed.setDescription('*No active shifts*');
  } else {
    shifts.forEach(shift => {
      embed.addFields({
        name: `#${shift.id} — ${shift.role}`,
        value: `🕐 ${discordTimestamp(shift.unix)}\n✅ **Status:** Active`,
        inline: false
      });
    });
  }

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
        console.log('✅ Shift board edited!');
        return;
      } catch (err) {
        console.log('⚠️ Could not edit board, posting new one...', err.message);
        shiftBoardMessageId = null;
      }
    }

    await postNewBoard(await client.channels.fetch(SHIFTS_CHANNEL_ID));
  } catch (err) {
    console.error('❌ Error updating shift board:', err);
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'shift') return;

  const sub = interaction.options.getSubcommand();
  console.log(`📥 /shift ${sub} by ${interaction.user.username}`);

  try {
    if (['create', 'end', 'cancel'].includes(sub)) {
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

    if (sub === 'create') {
      const date = interaction.options.getString('date');
      const time = interaction.options.getString('time');
      const role = interaction.options.getString('role');

      const unix  = toUnixTimestamp(date, time);
      const shift = { id: nextId++, date, time, role, unix };
      shifts.push(shift);
      saveData();
      await updateShiftBoard();

      const pingText = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '';

      const confirmEmbed = new EmbedBuilder()
        .setTitle(`✅ Shift #${shift.id} Created!`)
        .setColor(0x57F287)
        .addFields(
          { name: '🔢 Shift ID', value: `#${shift.id}`,                inline: true },
          { name: '🎭 Role',     value: role,                           inline: true },
          { name: '🕐 When',     value: discordTimestamp(unix),         inline: false }
        )
        .setFooter({ text: `Created by ${interaction.user.username}` });

      await interaction.reply({
        content: pingText ? `${pingText} — Shift #${shift.id} has been scheduled!` : `Shift #${shift.id} has been scheduled!`,
        embeds: [confirmEmbed],
        allowedMentions: { roles: PING_ROLE_ID ? [PING_ROLE_ID] : [] }
      });

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
            .setDescription(`Shift **#${shift.id}** (*${shift.role}*) scheduled for <t:${shift.unix}:F> has ended.`)
            .setFooter({ text: `Ended by ${interaction.user.username}` })
        ]
      });

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
            .setDescription(`Shift **#${shift.id}** (*${shift.role}*) scheduled for <t:${shift.unix}:F> has been cancelled.`)
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
        ]
      });

    } else if (sub === 'list') {
      await interaction.reply({ embeds: [buildShiftBoard()] });
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
