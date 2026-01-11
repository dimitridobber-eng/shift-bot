const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    EmbedBuilder,
    REST,
    Routes
} = require('discord.js');
const fs = require('fs');

// ===== CONFIG =====
const TOKEN = 'MTQ1MjAzNzc4NjczMDIzMzg1Ng.Gav0RK.h1GJgF-Z8jn8S7enFWbYCILtLbSngp-Wa41Zs0';
const CLIENT_ID = '1452037786730233856';
const GUILD_ID = '1452797019834810512';
const SHIFTS_CHANNEL_ID = '1452800610272542791';

const STAFF_ROLE_ID = '1457118988558663781';
const PING_ROLE_ID = '1453005359995289762';
const PING_DELETE_TIME = 1 * 60 * 1000; // 1 minute

// ===== DATA =====
const DATA_FILE = './data.json';
let data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== CLIENT =====
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ===== SLASH COMMANDS =====
const commands = [
    new SlashCommandBuilder()
        .setName('shift')
        .setDescription('Shift system')
        .addSubcommand(sc =>
            sc.setName('create')
                .setDescription('Create a shift')
                .addStringOption(o =>
                    o.setName('title')
                        .setDescription('Shift title')
                        .setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('time')
                        .setDescription('Time (YYYY-MM-DD HH:MM)')
                        .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc.setName('end')
                .setDescription('End a shift')
                .addStringOption(o =>
                    o.setName('title')
                        .setDescription('Shift title')
                        .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc.setName('cancel')
                .setDescription('Cancel a shift')
                .addStringOption(o =>
                    o.setName('title')
                        .setDescription('Shift title')
                        .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc.setName('clear')
                .setDescription('Delete ALL shifts')
        )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
    );
    console.log('✅ Slash commands registered');
})();

// ===== HELPERS =====
function parseToTimestamp(input) {
    const [date, time] = input.split(' ');
    if (!date || !time) return null;

    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);

    const d = new Date(year, month - 1, day, hour, minute);
    if (isNaN(d.getTime())) return null;

    return Math.floor(d.getTime() / 1000);
}

// ===== BOARD =====
async function updateBoard() {
    const channel = await client.channels.fetch(SHIFTS_CHANNEL_ID);

    const description =
        data.shifts.length === 0
            ? '*No active shifts*'
            : data.shifts.map((s, i) => {
                const statusText =
                    s.status === 'Canceled'
                        ? '❌ **Canceled**'
                        : '🟢 **Planned**';

                return (
                    `**${i + 1}. ${s.title}**\n` +
                    `🕒 <t:${s.timestamp}:F> (<t:${s.timestamp}:R>)\n` +
                    `📌 Status: ${statusText}`
                );
            }).join('\n\n');

    const embed = new EmbedBuilder()
        .setTitle('📋 Shift Board')
        .setColor(0x2b2d31)
        .setDescription(description);

    try {
        if (data.boardMessageId) {
            const msg = await channel.messages.fetch(data.boardMessageId);
            return msg.edit({ embeds: [embed] });
        }
    } catch {
        console.log('⚠️ Board message missing, creating new one...');
    }

    const newMsg = await channel.send({ embeds: [embed] });
    data.boardMessageId = newMsg.id;
    saveData();
}

// ===== READY =====
client.once('ready', async () => {
    console.log(`🟢 Bot online as ${client.user.tag}`);
    await updateBoard();
});

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'shift') return;

    if (!interaction.member.roles.cache.has(STAFF_ROLE_ID)) {
        return interaction.reply({
            content: '❌ You do not have permission to use this command.',
            ephemeral: true
        });
    }

    const sub = interaction.options.getSubcommand();

    // CREATE
    if (sub === 'create') {
        const title = interaction.options.getString('title');
        const timeInput = interaction.options.getString('time');
        const timestamp = parseToTimestamp(timeInput);

        if (!timestamp) {
            return interaction.reply({
                content: '❌ Invalid time format. Use: YYYY-MM-DD HH:MM',
                ephemeral: true
            });
        }

        data.shifts.push({
            title,
            timestamp,
            status: 'Planned'
        });

        saveData();
        await updateBoard();

        const pingMsg = await interaction.channel.send(`<@&${PING_ROLE_ID}>`);
        setTimeout(() => pingMsg.delete().catch(() => {}), PING_DELETE_TIME);

        return interaction.reply({
            content: `✅ Shift **${title}** created.`,
            ephemeral: true
        });
    }

    // END
    if (sub === 'end') {
        const title = interaction.options.getString('title');
        const index = data.shifts.findIndex(s => s.title === title);

        if (index === -1) {
            return interaction.reply({
                content: '❌ Shift not found.',
                ephemeral: true
            });
        }

        data.shifts.splice(index, 1);
        saveData();
        await updateBoard();

        return interaction.reply({
            content: `🛑 Shift **${title}** ended.`,
            ephemeral: true
        });
    }

    // CANCEL
    if (sub === 'cancel') {
        const title = interaction.options.getString('title');
        const shift = data.shifts.find(s => s.title === title);

        if (!shift) {
            return interaction.reply({
                content: '❌ Shift not found.',
                ephemeral: true
            });
        }

        shift.status = 'Canceled';
        saveData();
        await updateBoard();

        return interaction.reply({
            content: `⚠️ Shift **${title}** has been canceled.`,
            ephemeral: true
        });
    }

    // CLEAR
    if (sub === 'clear') {
        data.shifts = [];
        saveData();
        await updateBoard();

        return interaction.reply({
            content: '🧹 All shifts have been deleted.',
            ephemeral: true
        });
    }
});

// ===== LOGIN =====
client.login(TOKEN);
