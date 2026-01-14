require('dotenv').config();
const fs = require('fs');
const { DateTime } = require('luxon');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder
} = require('discord.js');

/* ================= CONFIG ================= */
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1459912910217281680';
const GUILD_ID = '1373772001868513301';
const SHIFTS_CHANNEL_ID = '1452800610272542791';
const STAFF_ROLE_ID = '1459851940635869194';
const PING_ROLE_ID = '1453005359995289762'; // shift ping role
const TIMEZONE = 'Europe/Amsterdam';
/* ========================================== */

// ===== CLIENT
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== DATA
function loadData() {
  if (!fs.existsSync('./data.json')) {
    return { boardMessageId: null, shifts: [] };
  }
  return JSON.parse(fs.readFileSync('./data.json', 'utf8'));
}
function saveData(data) {
  fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
}
let data = loadData();

// ===== PERMISSION CHECK
function isStaff(interaction) {
  return interaction.member.roles.cache.has(STAFF_ROLE_ID);
}

// ===== AUTO REMOVE AFTER 30 MIN
function scheduleShiftRemoval(title) {
  setTimeout(async () => {
    data.shifts = data.shifts.filter(s => s.title !== title);
    saveData(data);
    await updateBoard();
  }, 30 * 60 * 1000);
}

// ===== SLASH COMMANDS
const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Shift system')
    .addSubcommand(sc =>
      sc.setName('setup')
        .setDescription('Create shift board')
    )
    .addSubcommand(sc =>
      sc.setName('create')
        .setDescription('Create a shift')
        .addStringOption(o =>
          o.setName('title').setDescription('Shift title').setRequired(true)
        )
        .addStringOption(o =>
          o.setName('date').setDescription('DD-MM-YYYY').setRequired(true)
        )
        .addStringOption(o =>
          o.setName('time').setDescription('HH:mm').setRequired(true)
        )
    )
    .addSubcommand(sc =>
      sc.setName('end')
        .setDescription('End a shift')
        .addStringOption(o =>
          o.setName('title').setDescription('Shift title').setRequired(true)
        )
    )
    .addSubcommand(sc =>
      sc.setName('cancel')
        .setDescription('Cancel a shift')
        .addStringOption(o =>
          o.setName('title').setDescription('Shift title').setRequired(true)
        )
    )
    .addSubcommand(sc =>
      sc.setName('clear')
        .setDescription('Clear all shifts')
    )
].map(c => c.toJSON());

// ===== REGISTER COMMANDS
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash commands registered');
})();

// ===== UPDATE BOARD
async function updateBoard() {
  if (!data.boardMessageId) return;

  try {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    const message = await channel.messages.fetch(data.boardMessageId);

    const embed = new EmbedBuilder()
      .setTitle('📋 Shift Board')
      .setColor(0x2b2d31)
      .setDescription(
        data.shifts.length === 0
          ? '*No active shifts*'
          : data.shifts.map((s, i) => {
              const status =
                s.status === 'Cancelled' ? '❌ Cancelled'
                : s.status === 'Completed' ? '✅ Completed'
                : '🟢 Planned';

              return `**${i + 1}. ${s.title}**
🕒 <t:${s.unix}:R> • <t:${s.unix}:F>
👤 <@${s.hostId}>
📌 **${status}**`;
            }).join('\n\n')
      );

    await message.edit({ embeds: [embed] });
  } catch {
    data.boardMessageId = null;
    saveData(data);
  }
}

// ===== READY
client.once('ready', () => {
  console.log(`🟢 Online as ${client.user.tag}`);
});

// ===== COMMAND HANDLER
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'shift') return;
  if (!isStaff(interaction)) {
    return interaction.reply({ content: '❌ No permission.', ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();

  // SETUP
  if (sub === 'setup') {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    const msg = await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('📋 Shift Board')
        .setDescription('*No active shifts*')
        .setColor(0x2b2d31)]
    });
    data.boardMessageId = msg.id;
    saveData(data);
    return interaction.reply({ content: '✅ Board created.', ephemeral: true });
  }

  // CREATE
  if (sub === 'create') {
    const title = interaction.options.getString('title');
    const date = interaction.options.getString('date');
    const time = interaction.options.getString('time');

    const dt = DateTime.fromFormat(
      `${date} ${time}`,
      'dd-MM-yyyy HH:mm',
      { zone: TIMEZONE }
    );

    if (!dt.isValid) {
      return interaction.reply({ content: '❌ Invalid date or time.', ephemeral: true });
    }

    const unix = Math.floor(dt.toSeconds());

    data.shifts.push({
      title,
      unix,
      hostId: interaction.user.id,
      status: 'Planned'
    });

    saveData(data);
    await updateBoard();

    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);
    const ping = await channel.send(
      `🔔 <@&${PING_ROLE_ID}> **New shift:** **${title}**\n🕒 <t:${unix}:F>`
    );
    setTimeout(() => ping.delete().catch(() => {}), 60 * 1000);

    return interaction.reply({ content: '✅ Shift created.', ephemeral: true });
  }

  // END / CANCEL
  if (sub === 'end' || sub === 'cancel') {
    const title = interaction.options.getString('title');
    const shift = data.shifts.find(s => s.title === title);
    if (!shift) {
      return interaction.reply({ content: '❌ Shift not found.', ephemeral: true });
    }

    shift.status = sub === 'cancel' ? 'Cancelled' : 'Completed';
    saveData(data);
    await updateBoard();
    scheduleShiftRemoval(title);

    return interaction.reply({
      content: '🕒 Shift will auto-delete in 30 minutes.',
      ephemeral: true
    });
  }

  // CLEAR
  if (sub === 'clear') {
    data.shifts = [];
    saveData(data);
    await updateBoard();
    return interaction.reply({ content: '🧹 All shifts cleared.', ephemeral: true });
  }
});

// ===== LOGIN
client.login(TOKEN);
