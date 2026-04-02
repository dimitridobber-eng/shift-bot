const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ]
});

// ── Config from Railway Environment Variables ──────────────────────────────
const TOKEN               = process.env.DISCORD_TOKEN;
const CLIENT_ID           = process.env.CLIENT_ID;
const SHIFTS_CHANNEL_NAME = process.env.SHIFTS_CHANNEL_NAME  || 'shifts';
const ALLOWED_ROLE_ID     = process.env.ALLOWED_ROLE_ID;      // Role ID (not name!)
const PING_ROLE_ID        = process.env.PING_ROLE_ID;         // Role ID (not name!)
// ──────────────────────────────────────────────────────────────────────────

// Keep Railway awake
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

// Store active shifts in memory
let activeShifts = [];
let shiftBoardMessageId = null;

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Manage shifts')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new shift')
        .addStringOption(opt => opt.setName('date').setDescription('Date of the shift (e.g. 25-03-2026)').setRequired(true))
        .addStringOption(opt => opt.setName('time').setDescription('Time of the shift (e.g. 14:00)').setRequired(true))
        .addStringOption(opt => opt.setName('worker').setDescription('Name of the worker').setRequired(true))
        .addStringOption(opt => opt.setName('role').setDescription('Role/position (e.g. Cashier, Manager)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End a shift')
        .addStringOption(opt => opt.setName('worker').setDescription('Worker name to end shift for').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a shift')
        .addStringOption(opt => opt.setName('worker').setDescription('Worker name to cancel shift for').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all active shifts')
    )
].map(cmd => cmd.toJSON());

// Register commands on ready
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`📋 Shifts channel : ${SHIFTS_CHANNEL_NAME}`);
  console.log(`🔒 Allowed role ID: ${ALLOWED_ROLE_ID}`);
  console.log(`🔔 Ping role ID   : ${PING_ROLE_ID}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

// Check if member has the allowed role by ID
function hasAllowedRole(member) {
  if (!ALLOWED_ROLE_ID) return true; // if not set, allow everyone
  return member.roles.cache.has(ALLOWED_ROLE_ID);
}

// Build the shift board embed
function buildShiftBoard() {
  const embed = new EmbedBuilder()
    .setTitle('📋 Shift Board')
    .setColor(0x5865F2)
    .setTimestamp();

  if (activeShifts.length === 0) {
    embed.setDescription('*No active shifts*');
  } else {
    activeShifts.forEach((shift, i) => {
      embed.addFields({
        name: `${i + 1}. ${shift.worker} — ${shift.role}`,
        value: `📅 **Date:** ${shift.date}\n⏰ **Time:** ${shift.time}\n✅ **Status:** Active`,
        inline: false
      });
    });
  }

  return embed;
}

// Update or post the shift board in #shifts
async function updateShiftBoard(guild) {
  const channel = guild.channels.cache.find(c => c.name === SHIFTS_CHANNEL_NAME);
  if (!channel) {
    console.error(`❌ Could not find channel: #${SHIFTS_CHANNEL_NAME}`);
    return;
  }

  const embed = buildShiftBoard();

  try {
    if (shiftBoardMessageId) {
      const msg = await channel.messages.fetch(shiftBoardMessageId);
      await msg.edit({ embeds: [embed] });
    } else {
      const msg = await channel.send({ embeds: [embed] });
      shiftBoardMessageId = msg.id;
    }
  } catch {
    const msg = await channel.send({ embeds: [embed] });
    shiftBoardMessageId = msg.id;
  }
}

// Handle interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'shift') return;

  const sub = interaction.options.getSubcommand();
  console.log(`📥 /shift ${sub} by ${interaction.user.username}`);

  try {
    // 🔒 Role check for create, end, cancel
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
      const date   = interaction.options.getString('date');
      const time   = interaction.options.getString('time');
      const worker = interaction.options.getString('worker');
      const role   = interaction.options.getString('role');

      const existing = activeShifts.find(s => s.worker.toLowerCase() === worker.toLowerCase());
      if (existing) {
        return await interaction.reply({
          content: `⚠️ **${worker}** already has an active shift! End or cancel it first.`,
          ephemeral: true
        });
      }

      activeShifts.push({ date, time, worker, role });
      await updateShiftBoard(interaction.guild);

      const pingText = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '';

      const confirmEmbed = new EmbedBuilder()
        .setTitle('✅ New Shift Created!')
        .setColor(0x57F287)
        .addFields(
          { name: '👤 Worker', value: worker, inline: true },
          { name: '🎭 Role',   value: role,   inline: true },
          { name: '📅 Date',   value: date,   inline: true },
          { name: '⏰ Time',   value: time,   inline: true }
        )
        .setFooter({ text: `Created by ${interaction.user.username}` });

      // Public so everyone sees it
      await interaction.reply({
        content: pingText ? `${pingText} — A new shift has been scheduled!` : 'A new shift has been scheduled!',
        embeds: [confirmEmbed]
      });

    } else if (sub === 'end') {
      const worker = interaction.options.getString('worker');
      const index  = activeShifts.findIndex(s => s.worker.toLowerCase() === worker.toLowerCase());

      if (index === -1) {
        return await interaction.reply({ content: `⚠️ No active shift found for **${worker}**.`, ephemeral: true });
      }

      const shift = activeShifts.splice(index, 1)[0];
      await updateShiftBoard(interaction.guild);

      // Public so everyone sees the board update
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🏁 Shift Ended')
            .setColor(0xFEE75C)
            .setDescription(`**${shift.worker}**'s shift as *${shift.role}* on ${shift.date} at ${shift.time} has ended.`)
            .setFooter({ text: `Ended by ${interaction.user.username}` })
        ]
      });

    } else if (sub === 'cancel') {
      const worker = interaction.options.getString('worker');
      const index  = activeShifts.findIndex(s => s.worker.toLowerCase() === worker.toLowerCase());

      if (index === -1) {
        return await interaction.reply({ content: `⚠️ No active shift found for **${worker}**.`, ephemeral: true });
      }

      const shift = activeShifts.splice(index, 1)[0];
      await updateShiftBoard(interaction.guild);

      // Public so everyone sees the board update
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Shift Cancelled')
            .setColor(0xED4245)
            .setDescription(`**${shift.worker}**'s shift as *${shift.role}* on ${shift.date} at ${shift.time} has been cancelled.`)
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
        ]
      });

    } else if (sub === 'list') {
      // ✅ Now PUBLIC so everyone can see
      await interaction.reply({
        embeds: [buildShiftBoard()]
      });
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
process.on('uncaughtException',  err => console.error('❌ Uncaught exception:',  err));

client.login(TOKEN);
