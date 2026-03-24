const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const SHIFTS_CHANNEL_NAME = 'shifts';       // Your shifts channel name
const ALLOWED_ROLE_NAME = 'Manager';        // Only this role can create/end/cancel shifts
const PING_ROLE_NAME = 'shift ping';        // This role gets pinged when a shift is created

// Store active shifts in memory
let activeShifts = [];
let shiftBoardMessageId = null;

// Slash commands definition
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
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

// Check if a member has the allowed role
function hasAllowedRole(member) {
  return member.roles.cache.some(r => r.name === ALLOWED_ROLE_NAME);
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

// Update or post the shift board
async function updateShiftBoard(guild) {
  const channel = guild.channels.cache.find(c => c.name === SHIFTS_CHANNEL_NAME);
  if (!channel) return;

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

  // ✅ Role permission check for create, end, cancel
  if (['create', 'end', 'cancel'].includes(sub)) {
    if (!hasAllowedRole(interaction.member)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🚫 No Permission')
            .setColor(0xED4245)
            .setDescription(`You need the **${ALLOWED_ROLE_NAME}** role to use this command.`)
        ],
        ephemeral: true
      });
    }
  }

  if (sub === 'create') {
    const date = interaction.options.getString('date');
    const time = interaction.options.getString('time');
    const worker = interaction.options.getString('worker');
    const role = interaction.options.getString('role');

    // Check if worker already has a shift
    const existing = activeShifts.find(s => s.worker.toLowerCase() === worker.toLowerCase());
    if (existing) {
      return interaction.reply({
        content: `⚠️ **${worker}** already has an active shift! End or cancel it first.`,
        ephemeral: true
      });
    }

    activeShifts.push({ date, time, worker, role });
    await updateShiftBoard(interaction.guild);

    // Find the ping role
    const pingRole = interaction.guild.roles.cache.find(r => r.name === PING_ROLE_NAME);
    const pingText = pingRole ? `<@&${pingRole.id}>` : `@${PING_ROLE_NAME}`;

    const confirmEmbed = new EmbedBuilder()
      .setTitle('✅ New Shift Created!')
      .setColor(0x57F287)
      .addFields(
        { name: '👤 Worker', value: worker, inline: true },
        { name: '🎭 Role', value: role, inline: true },
        { name: '📅 Date', value: date, inline: true },
        { name: '⏰ Time', value: time, inline: true }
      )
      .setFooter({ text: `Created by ${interaction.user.username}` });

    // Reply with embed AND ping the role
    await interaction.reply({
      content: `${pingText} — A new shift has been scheduled!`,
      embeds: [confirmEmbed]
    });

  } else if (sub === 'end') {
    const worker = interaction.options.getString('worker');
    const index = activeShifts.findIndex(s => s.worker.toLowerCase() === worker.toLowerCase());

    if (index === -1) {
      return interaction.reply({ content: `⚠️ No active shift found for **${worker}**.`, ephemeral: true });
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
    const index = activeShifts.findIndex(s => s.worker.toLowerCase() === worker.toLowerCase());

    if (index === -1) {
      return interaction.reply({ content: `⚠️ No active shift found for **${worker}**.`, ephemeral: true });
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
    await interaction.reply({ embeds: [buildShiftBoard()], ephemeral: true });
  }
});

client.login(TOKEN);
