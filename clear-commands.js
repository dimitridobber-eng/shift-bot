const { REST, Routes } = require('discord.js');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('🗑️ Deleting all global slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('✅ All commands deleted! Wait 1-2 minutes then restart your bot.');
  } catch (err) {
    console.error('❌ Error:', err);
  }
})();
