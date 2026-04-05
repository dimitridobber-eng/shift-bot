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
const TOKEN             = process.env.DISCORD_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const SHIFTS_CHANNEL_ID = process.env.SHIFTS_CHANNEL_ID;
const ALLOWED_ROLE_ID   = process.env.ALLOWED_ROLE_ID;
const PING_ROLE_ID      = process.env.PING_ROLE_ID;
// ──────────────────────────────────────────────────────────────────────────

// Keep Railway awake
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

let shifts = [];        // { id, date, time, role }
let nextId = 1;         // auto incrementing shift ID
let shiftBoardMessageId = null;

const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Manage shifts')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new shift')
        .addStringOption(opt => opt.setName('date').setDescription('Date (e.g. 25-03-2026)').setRequired(true))
        .addStringOption(opt => opt.setName('time').setDescription('Time (e.g. 14:00)').setRequired(true))
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

// On ready
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`📋 Shifts channel ID: ${SHIFTS_CHANNEL_ID}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  // Find existing shift board on startup
  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
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
        console.log('ℹ️ No existing board found, will post one now...');
        await postNewBoard(channel);
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

  if (shifts.length === 0) {
    embed.setDescription('*No active shifts*');
  } else {
    shifts.forEach(shift => {
      embed.addFields({
        name: `#${shift.id} — ${shift.role}`,
        value: `📅 **Date:** ${shift.date}\n⏰ **Time:** ${shift.time}\n✅ **Status:** Active`,
        inline: false
      });
    });
  }

  return embed;
}

async function postNewBoard(channel) {
  const msg = await channel.send({ embeds: [buildShiftBoard()] });
  shiftBoardMessageId = msg.id;
  console.log('✅ Shift board posted!');
}

async function updateShiftBoard() {
  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Could not find channel ID: ${SHIFTS_CHANNEL_ID}`);
      return;
    }

    if (shiftBoardMessageId) {
      try {
        const msg = await channel.messages.fetch(shiftBoardMessageId);
        await msg.edit({ embeds: [buildShiftBoard()] });
        console.log('✅ Shift board updated!');
      } catch {
        console.log('⚠️ Board message gone, posting new one...');
        await postNewBoard(channel);
      }
    } else {
      await postNewBoard(channel);
    }
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
    // Role check
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

      const shift = { id: nextId++, date, time, role };
      shifts.push(shift);
      await updateShiftBoard();

      const pingText = PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : '';

      const confirmEmbed = new EmbedBuilder()
        .setTitle(`✅ Shift #${shift.id} Created!`)
        .setColor(0x57F287)
        .addFields(
          { name: '🔢 Shift ID', value: `#${shift.id}`, inline: true },
          { name: '🎭 Role',     value: role,            inline: true },
          { name: '📅 Date',     value: date,            inline: true },
          { name: '⏰ Time',     value: time,            inline: true }
        )
        .setFooter({ text: `Created by ${interaction.user.username}` });

      await interaction.reply({
        content: pingText ? `${pingText} — Shift #${shift.id} has been scheduled!` : `Shift #${shift.id} has been scheduled!`,
        embeds: [confirmEmbed]
      });

    } else if (sub === 'end') {
      const id    = interaction.options.getInteger('id');
      const index = shifts.findIndex(s => s.id === id);

      if (index === -1) {
        return await interaction.reply({ content: `⚠️ No active shift found with ID **#${id}**.`, ephemeral: true });
      }

      const shift = shifts.splice(index, 1)[0];
      await updateShiftBoard();

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🏁 Shift #${shift.id} Ended`)
            .setColor(0xFEE75C)
            .setDescription(`Shift **#${shift.id}** (*${shift.role}*) on ${shift.date} at ${shift.time} has ended.`)
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
      await updateShiftBoard();

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`❌ Shift #${shift.id} Cancelled`)
            .setColor(0xED4245)
            .setDescription(`Shift **#${shift.id}** (*${shift.role}*) on ${shift.date} at ${shift.time} has been cancelled.`)
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
