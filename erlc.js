const fetch = require('node-fetch'); // For Node versions <18

const {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder
} = require('discord.js');

// Initialize the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Global variables
let storedApiKey = null; // Set via .setup
const dutyStatuses = new Map(); // userId -> { shiftStarted, breakAccumulated, onBreak, breakStart }
const dutyMessageRefs = new Map(); // userId -> duty panel message object
const dutyIntervalIds = new Map(); // userId -> interval id for auto-updating panel
const dutyLeaderboard = new Map(); // userId -> cumulative effective duty time (ms)
const punishments = new Map(); // Roblox username (lowercase) -> array of punishment records

// Helper: Create an embed message.
function createEmbedMessage(description, color = 0x0099ff) {
  return new EmbedBuilder()
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

// Helper: Format milliseconds as "Xh Ym Zs"
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

// Helper: Fetch the Roblox profile link for a username.
async function getRobloxProfile(username) {
  try {
    const res = await fetch(`https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(username)}`);
    const data = await res.json();
    if (data && data.Id) {
      return `https://www.roblox.com/users/${data.Id}/profile`;
    } else {
      return null;
    }
  } catch (err) {
    console.error("Error fetching Roblox profile:", err);
    return null;
  }
}

// Helper: Build the duty panel embed and buttons.
function getDutyEmbedAndButtons(userId, guild) {
  const embed = new EmbedBuilder().setTitle("Duty Management");
  const buttons = new ActionRowBuilder();
  if (!dutyStatuses.has(userId)) {
    embed.setDescription("You are currently **not on duty**. Press **On Duty** to start your shift.")
         .setColor(0xFFA500);
    const onDutyButton = new ButtonBuilder()
      .setCustomId('duty_on')
      .setLabel('On Duty')
      .setStyle(ButtonStyle.Success);
    buttons.addComponents(onDutyButton);
  } else {
    const duty = dutyStatuses.get(userId);
    const now = new Date();
    const totalShiftTime = now - duty.shiftStarted;
    let totalBreakTime = duty.breakAccumulated;
    if (duty.onBreak) totalBreakTime += now - duty.breakStart;
    const effectiveWorkTime = totalShiftTime - totalBreakTime;
    embed.setTitle("Current Shift")
         .setDescription("Shift Started")
         .addFields(
           { name: "Started:", value: `<t:${Math.floor(duty.shiftStarted.getTime()/1000)}:F>`, inline: false },
           { name: "Breaks:", value: formatDuration(totalBreakTime), inline: true },
           { name: "Elapsed Time:", value: formatDuration(effectiveWorkTime), inline: true }
         )
         .setColor(0x00FF00)
         .setTimestamp();
    const toggleLabel = duty.onBreak ? "End Break" : "Toggle Break";
    const toggleButton = new ButtonBuilder()
      .setCustomId('duty_toggle')
      .setLabel(toggleLabel)
      .setStyle(ButtonStyle.Primary);
    const offButton = new ButtonBuilder()
      .setCustomId('duty_off')
      .setLabel('Off Duty')
      .setStyle(ButtonStyle.Danger);
    const refreshButton = new ButtonBuilder()
      .setCustomId('duty_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary);
    buttons.addComponents(toggleButton, offButton, refreshButton);
  }
  return { embed, buttons };
}

// Helper: Send a shift log to the "shift-logs" channel.
async function sendShiftLog(guild, logMessage, embed) {
  const shiftChannel = guild.channels.cache.find(c =>
    c.name === 'shift-logs' && c.type === ChannelType.GuildText
  );
  if (shiftChannel) {
    await shiftChannel.send({ content: logMessage, embeds: embed ? [embed] : [] });
  }
}

// .setup command handler.
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.content === '.setup') {
    if (!message.guild)
      return message.reply({ embeds: [createEmbedMessage("This command can only be used in a server.", 0xff0000)] });
    
    const setupEmbed = new EmbedBuilder()
      .setTitle("ERLC Setup")
      .setDescription(
        "Click the button below to provide your ERLC API key. Once provided, the bot will:\n" +
        "• Log commands via the ERLC API\n" +
        "• Create the following channels under a **helping erlc** category:\n" +
        "   - **command-logs**\n" +
        "   - **join-logs**\n" +
        "   - **shift-logs**\n" +
        "   - **punishment-logs**"
      )
      .setColor(0x0099ff)
      .setTimestamp();
    
    const button = new ButtonBuilder()
      .setCustomId('open_erc_api_modal')
      .setLabel('Enter API Key')
      .setStyle(ButtonStyle.Primary);
    
    const row = new ActionRowBuilder().addComponents(button);
    await message.reply({ embeds: [setupEmbed], components: [row] });

    // Create category and channels.
    const categoryName = "helping erlc";
    let category = message.guild.channels.cache.find(c =>
      c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (!category) {
      category = await message.guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
    }
    
    async function createChannelIfNotExists(channelName) {
      let channel = message.guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText &&
        c.name === channelName &&
        c.parentId === category.id
      );
      if (!channel) {
        channel = await message.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }
      return channel;
    }
    
    const commandLogsChannel = await createChannelIfNotExists("command-logs");
    const joinLogsChannel = await createChannelIfNotExists("join-logs");
    const shiftLogsChannel = await createChannelIfNotExists("shift-logs");
    const punishmentLogsChannel = await createChannelIfNotExists("punishment-logs");

    // DM the user a thank you message with command list.
    const dmMessage = "Thank you for using Helping ERLC! The main inspiration was the bot 'erm'.\n\n**Command List:**\n" +
      "`.ping` - Check bot latency.\n" +
      "`.setup` - Set up the bot (API key and channels).\n" +
      "`.duty manage` - Manage your shift (start, break, end).\n" +
      "`.duty leaderboard` - View the duty leaderboard.\n" +
      "`.duty active` - See which staff are currently on duty.\n" +
      "`.punish RobloxUsername type reason` - Punish a Roblox user.\n" +
      "`.search RobloxUsername` - Search punishments for a Roblox user.";
    try {
      await message.author.send(dmMessage);
    } catch (err) {
      console.error("Could not send DM to user:", err);
    }
  }
});

// Other command handlers (.ping, .duty manage, .duty leaderboard, .duty active, .punish, .search) remain unchanged.

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  
  // .ping command
  if (message.content === '.ping') {
    const msg = await message.reply({ embeds: [createEmbedMessage("Pong!", 0x00ff00)] });
    const latency = msg.createdTimestamp - message.createdTimestamp;
    const apiLatency = Math.round(client.ws.ping);
    return msg.edit({ embeds: [createEmbedMessage(`Pong! Latency: ${latency}ms | API Latency: ${apiLatency}ms`, 0x00ff00)] });
  }
  
  // .duty manage command
  if (message.content === '.duty manage') {
    if (!message.guild)
      return message.reply({ embeds: [createEmbedMessage("This command can only be used in a server.", 0xff0000)] });
    const { embed, buttons } = getDutyEmbedAndButtons(message.author.id, message.guild);
    console.log(`Updating duty panel for user ${message.author.id}`);
    if (dutyMessageRefs.has(message.author.id)) {
      const dutyMsg = dutyMessageRefs.get(message.author.id);
      dutyMsg.edit({ embeds: [embed], components: [buttons] }).catch(err => console.error("Error editing duty panel:", err));
    } else {
      const dutyMsg = await message.reply({ embeds: [embed], components: [buttons] });
      dutyMessageRefs.set(message.author.id, dutyMsg);
    }
  }
  
  // .duty leaderboard command
  if (message.content === '.duty leaderboard') {
    if (!message.guild)
      return message.reply({ embeds: [createEmbedMessage("This command can only be used in a server.", 0xff0000)] });
    let leaderboardArray = [];
    for (const [userId, time] of dutyLeaderboard.entries()) {
      leaderboardArray.push({ userId, time });
    }
    leaderboardArray.sort((a, b) => b.time - a.time);
    const leaderboardEmbed = new EmbedBuilder()
      .setTitle("Duty Leaderboard")
      .setColor(0xFFD700)
      .setTimestamp();
    if (leaderboardArray.length === 0) {
      leaderboardEmbed.setDescription("No duty records yet.");
    } else {
      let desc = "";
      let rank = 1;
      for (const entry of leaderboardArray.slice(0, 10)) {
        desc += `**#${rank}** <@${entry.userId}> - ${formatDuration(entry.time)}\n`;
        rank++;
      }
      leaderboardEmbed.setDescription(desc);
    }
    await message.reply({ embeds: [leaderboardEmbed] });
  }
  
  // .duty active command
  if (message.content === '.duty active') {
    if (!message.guild)
      return message.reply({ embeds: [createEmbedMessage("This command can only be used in a server.", 0xff0000)] });
    if (dutyStatuses.size === 0) {
      await message.reply({ embeds: [createEmbedMessage("No staff are currently on duty.", 0xff0000)] });
      return;
    }
    const activeEmbed = new EmbedBuilder()
      .setTitle("Active Duty Staff")
      .setColor(0x00FF00)
      .setTimestamp();
    let description = "";
    for (const [userId, duty] of dutyStatuses.entries()) {
      const now = new Date();
      const totalShiftTime = now - duty.shiftStarted;
      let totalBreakTime = duty.breakAccumulated;
      if (duty.onBreak) totalBreakTime += now - duty.breakStart;
      const effectiveWorkTime = totalShiftTime - totalBreakTime;
      description += `<@${userId}> - Online for: ${formatDuration(effectiveWorkTime)}\n`;
    }
    activeEmbed.setDescription(description);
    await message.reply({ embeds: [activeEmbed] });
  }
  
  // .punish command
  if (message.content.startsWith('.punish')) {
    const args = message.content.trim().split(/\s+/);
    if (args.length < 4) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("Punish Command Error")
          .setDescription("Usage: `.punish RobloxUsername type reason`")
          .setColor(0xff0000)
          .setTimestamp()]
      });
    }
    const robloxUsername = args[1];
    const type = args[2].toLowerCase();
    const reason = args.slice(3).join(" ");
    const validTypes = ["warning", "kick", "ban", "bolo"];
    if (!validTypes.includes(type)) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("Punish Command Error")
          .setDescription("Invalid punishment type. Valid types: warning, kick, ban, bolo.")
          .setColor(0xff0000)
          .setTimestamp()]
      });
    }
    const punishmentEmbed = new EmbedBuilder()
      .setTitle("Punishment Executed")
      .addFields(
        { name: "Roblox Username", value: robloxUsername, inline: true },
        { name: "Type", value: type, inline: true },
        { name: "Reason", value: reason, inline: false },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true }
      )
      .setColor(0xff0000)
      .setTimestamp();
    const profileLink = await getRobloxProfile(robloxUsername);
    if (profileLink) {
      punishmentEmbed.addFields({ name: "Roblox Profile", value: `[View Profile](${profileLink})`, inline: false });
    } else {
      punishmentEmbed.addFields({ name: "Roblox Profile", value: "Not found", inline: false });
    }
    try {
      await message.reply({ embeds: [punishmentEmbed] });
      const record = { type, reason, moderator: message.author.id, timestamp: new Date() };
      const key = robloxUsername.toLowerCase();
      if (!punishments.has(key)) punishments.set(key, []);
      punishments.get(key).push(record);
      const punishmentLogsChannel = message.guild.channels.cache.find(c =>
        c.name === "punishment-logs" && c.type === ChannelType.GuildText
      );
      if (punishmentLogsChannel) {
        await punishmentLogsChannel.send({ embeds: [punishmentEmbed] });
      }
    } catch (error) {
      console.error("Error executing .punish command:", error);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("Punish Command Error")
          .setDescription("An error occurred while executing the punishment.")
          .setColor(0xff0000)
          .setTimestamp()]
      });
    }
  }
  
  // .search command
  if (message.content.startsWith('.search')) {
    const args = message.content.trim().split(/\s+/);
    if (args.length < 2) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("Search Command Error")
          .setDescription("Usage: `.search RobloxUsername`")
          .setColor(0xff0000)
          .setTimestamp()]
      });
    }
    const searchName = args[1].toLowerCase();
    const records = punishments.get(searchName);
    if (!records || records.length === 0) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("No Records Found")
          .setDescription(`No punishment records found for Roblox username: ${args[1]}`)
          .setColor(0xff0000)
          .setTimestamp()]
      });
    }
    const searchEmbed = new EmbedBuilder()
      .setTitle(`Punishment Records for ${args[1]}`)
      .setColor(0x0099ff)
      .setTimestamp();
    const profileLink = await getRobloxProfile(args[1]);
    if (profileLink) {
      searchEmbed.addFields({ name: "Roblox Profile", value: `[View Profile](${profileLink})`, inline: false });
    }
    let desc = "";
    records.forEach((rec, idx) => {
      desc += `**#${idx + 1}** - Type: ${rec.type}\nReason: ${rec.reason}\nModerator: <@${rec.moderator}>\nTime: <t:${Math.floor(rec.timestamp.getTime()/1000)}:F>\n\n`;
    });
    searchEmbed.setDescription(desc);
    await message.reply({ embeds: [searchEmbed] });
  }
});

// -----------------------
// INTERACTION HANDLERS (Buttons & Modals)
// -----------------------
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('duty_')) {
      const userId = interaction.user.id;
      if (interaction.customId === 'duty_on') {
        if (!dutyStatuses.has(userId)) {
          dutyStatuses.set(userId, { shiftStarted: new Date(), breakAccumulated: 0, onBreak: false, breakStart: null });
        }
        const { embed, buttons } = getDutyEmbedAndButtons(userId, interaction.guild);
        if (dutyMessageRefs.has(userId)) {
          const dutyMsg = dutyMessageRefs.get(userId);
          dutyMsg.edit({ embeds: [embed], components: [buttons] });
        }
        return interaction.update({ embeds: [embed], components: [buttons] });
      } else if (interaction.customId === 'duty_toggle') {
        if (!dutyStatuses.has(userId)) {
          return interaction.reply({ embeds: [createEmbedMessage("You are not on duty.", 0xff0000)], ephemeral: true });
        }
        const duty = dutyStatuses.get(userId);
        const now = new Date();
        if (duty.onBreak) {
          duty.breakAccumulated += now - duty.breakStart;
          duty.onBreak = false;
          duty.breakStart = null;
          sendShiftLog(interaction.guild, `<@${userId}> has ended their break.`, null);
        } else {
          duty.onBreak = true;
          duty.breakStart = now;
          sendShiftLog(interaction.guild, `<@${userId}> has started a break.`, null);
        }
        const { embed, buttons } = getDutyEmbedAndButtons(userId, interaction.guild);
        if (dutyMessageRefs.has(userId)) {
          const dutyMsg = dutyMessageRefs.get(userId);
          dutyMsg.edit({ embeds: [embed], components: [buttons] });
        }
        return interaction.update({ embeds: [embed], components: [buttons] });
      } else if (interaction.customId === 'duty_off') {
        if (!dutyStatuses.has(userId)) {
          return interaction.reply({ embeds: [createEmbedMessage("You are not on duty.", 0xff0000)], ephemeral: true });
        }
        const duty = dutyStatuses.get(userId);
        const now = new Date();
        if (duty.onBreak) {
          duty.breakAccumulated += now - duty.breakStart;
          duty.onBreak = false;
          duty.breakStart = null;
        }
        const totalShiftTime = now - duty.shiftStarted;
        const totalBreakTime = duty.breakAccumulated;
        const effectiveWorkTime = totalShiftTime - totalBreakTime;
        const finalEmbed = new EmbedBuilder()
          .setTitle("Shift Ended")
          .setDescription("Your shift has ended.")
          .addFields(
            { name: "Started:", value: `<t:${Math.floor(duty.shiftStarted.getTime()/1000)}:F>`, inline: false },
            { name: "Breaks:", value: formatDuration(totalBreakTime), inline: true },
            { name: "Elapsed Time:", value: formatDuration(effectiveWorkTime), inline: true }
          )
          .setColor(0xFF0000)
          .setTimestamp();
        dutyStatuses.delete(userId);
        if (dutyIntervalIds.has(userId)) {
          clearInterval(dutyIntervalIds.get(userId));
          dutyIntervalIds.delete(userId);
        }
        if (dutyLeaderboard.has(userId)) {
          dutyLeaderboard.set(userId, dutyLeaderboard.get(userId) + effectiveWorkTime);
        } else {
          dutyLeaderboard.set(userId, effectiveWorkTime);
        }
        if (dutyMessageRefs.has(userId)) {
          const dutyMsg = dutyMessageRefs.get(userId);
          dutyMsg.edit({ embeds: [finalEmbed], components: [] });
          dutyMessageRefs.delete(userId);
        }
        sendShiftLog(interaction.guild, `<@${userId}> has ended their shift.`, finalEmbed);
        return interaction.update({ embeds: [finalEmbed], components: [] });
      } else if (interaction.customId === 'duty_refresh') {
        const { embed, buttons } = getDutyEmbedAndButtons(userId, interaction.guild);
        if (dutyMessageRefs.has(userId)) {
          const dutyMsg = dutyMessageRefs.get(userId);
          dutyMsg.edit({ embeds: [embed], components: [buttons] });
        }
        return interaction.update({ embeds: [embed], components: [buttons] });
      }
    }
  }
  if (interaction.isModalSubmit() && interaction.customId === 'apiKeyModal') {
    const apiKey = interaction.fields.getTextInputValue('erc_api_input');
    storedApiKey = apiKey;
    const categoryName = "helping erlc";
    let category = interaction.guild.channels.cache.find(c =>
      c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (!category) {
      category = await interaction.guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
    }
    const createChannelIfNotExists = async (channelName) => {
      let channel = interaction.guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText &&
        c.name === channelName &&
        c.parentId === category.id
      );
      if (!channel) {
        channel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }
      return channel;
    };
    const commandLogsChannel = await createChannelIfNotExists("command-logs");
    const joinLogsChannel = await createChannelIfNotExists("join-logs");
    const shiftLogsChannel = await createChannelIfNotExists("shift-logs");
    const punishmentLogsChannel = await createChannelIfNotExists("punishment-logs");
    const confirmEmbed = new EmbedBuilder()
      .setTitle("Setup Complete")
      .setDescription("Channels have been created and command logs will now be sent to the ERLC API.")
      .setColor(0x00ff00)
      .addFields(
        { name: "Command Logs", value: `${commandLogsChannel}`, inline: true },
        { name: "Join Logs", value: `${joinLogsChannel}`, inline: true },
        { name: "Shift Logs", value: `${shiftLogsChannel}`, inline: true },
        { name: "Punishment Logs", value: `${punishmentLogsChannel}`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: "ERLC Setup", iconURL: interaction.guild.iconURL() });
    return interaction.reply({ embeds: [confirmEmbed], ephemeral: true });
  }
});

// (Optional) Log every prefix command to the ERLC API.
client.on('messageCreate', async message => {
  if (message.author.bot || !storedApiKey) return;
  if (message.content.startsWith('.')) {
    logCommandToERLC(storedApiKey, message.content, message.author.id, new Date().toISOString());
  }
});

async function logCommandToERLC(apiKey, command, userId, timestamp) {
  const endpoint = "https://api.policeroleplay.community/for-developers/access-requests";
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        type: 'command',
        command: command,
        userId: userId,
        timestamp: timestamp
      })
    });
    if (!response.ok) {
      console.error("Failed to log command to ERLC API:", response.statusText);
    }
  } catch (error) {
    console.error("Error logging command:", error);
  }
}

// Log in to Discord with your bot token (replace 'YOUR_BOT_TOKEN' with your token or use an env variable)
client.login('e91e7fa87feb6706de54d584fa4df4c99d66b57304ea8f1b62ab6d41afacdf8b');
