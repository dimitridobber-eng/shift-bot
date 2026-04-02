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
const SHIFTS_CHANNEL_NAME = process.env.SHIFTS_CHANNEL_NAME || 'shifts';
const ALLOWED_ROLE_ID     = process.env.ALLOWED_ROLE_ID;
const PING_ROLE_ID        = process.env.PING_ROLE_ID;
// ──────────────────────────────────────────────────────────────────────────

// Keep Railway awake
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

let activeShifts = [];
let shiftBoardMessageId = null;

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

// On ready: register commands + find existing shift board message
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  // Find the shift board message in the shifts channel
  try {
    const guild = client.guilds.cache.first();
    if (guild) {
      const channel = guild.channels.cache.find(c => c.name === SHIFTS_CHANNEL_NAME);
      if (channel) {
        const messages = await channel.messages.fetch({ limit: 50 });
        const boardMsg = messages.find(m =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === '📋 Shift Board'
        );
        if (boardMsg) {
          shiftBoardMessageId = boardMsg.id;
          console.log(`✅ Found existing shift board: ${shiftBoardMessageId}`);
        } else {
          console.log('ℹ️ No existing shift board found, will create one on next shift.');
        }
      }
    }
  } catch (err) {
    console.error('❌ Error finding shift board:', err);
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
      console.log('✅ Shift board updated!');
    } else {
      const msg = await channel.send({ embeds: [embed] });
      shiftBoardMessageId = msg.id;
      console.log('✅ Shift board created!');
    }
  } catch (err) {
    console.log('⚠️ Could not find old board message, creating new one...');
    const msg = await channel.send({ embeds: [embed] });
    shiftBoardMessageId = msg.id;
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
