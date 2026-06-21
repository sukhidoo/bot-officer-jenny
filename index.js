// ============================================================================
//  Pokémon GO Community — Gatekeeper / Onboarding Bot
//  discord.js v14
//
//  Flow:
//   1. New members can only see #welcome (a button-only channel).
//   2. They click "Start Introduction" -> a modal asks for:
//        - Pokémon GO name
//        - Preferred name
//        - Tell us about you / fun facts
//   3. After submitting, the bot DMs them to (optionally) add a meetup photo.
//   4. On finish: the bot grants the "Verified Member" role (unlocking the
//      server) AND posts a nicely formatted intro card in #introductions.
//
//  See README.md for full setup (intents, role/channel permissions, .env).
// ============================================================================

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

// ----------------------------------------------------------------------------
//  Config (from .env)
// ----------------------------------------------------------------------------
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  rookieRoleId: process.env.ROOKIE_ROLE_ID, // assigned on join, removed on completion
  aceRoleId: process.env.ACE_ROLE_ID,       // granted on completion (unlocks the server)
  introChannelId: process.env.INTRO_CHANNEL_ID,
  // How long (ms) to wait for the optional DM photo before finishing anyway.
  photoTimeoutMs: 120_000,
  // Visual accent for the intro embed.
  embedColor: 0x3ba55d,
};

for (const [key, val] of Object.entries({
  DISCORD_TOKEN: CONFIG.token,
  GUILD_ID: CONFIG.guildId,
  ROOKIE_ROLE_ID: CONFIG.rookieRoleId,
  ACE_ROLE_ID: CONFIG.aceRoleId,
  INTRO_CHANNEL_ID: CONFIG.introChannelId,
})) {
  if (!val) {
    console.error(`Missing required env var: ${key}. Check your .env file.`);
    process.exit(1);
  }
}

// Custom IDs used to route component/modal interactions.
const IDS = {
  startButton: 'intro:start',
  modal: 'intro:modal',
  skipPhotoButton: 'intro:skipphoto',
  field: { pogo: 'pogo', preferred: 'preferred', facts: 'facts' },
};

// ----------------------------------------------------------------------------
//  In-memory state
//  Holds answers between the modal submit and the optional photo step.
//  NOTE: this is intentionally simple — if the bot restarts mid-onboarding,
//  the user just clicks the button again. For most communities that's fine.
// ----------------------------------------------------------------------------
const pending = new Map(); // userId -> { pogoName, preferredName, funFacts, modalInteraction, dmCollector, finalized }

// ----------------------------------------------------------------------------
//  Client
// ----------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: "Server Members Intent" (role mgmt)
    GatewayIntentBits.DirectMessages, // to receive the photo DM
  ],
  // Partials let us handle DM channels/messages that aren't cached yet.
  partials: [Partials.Channel, Partials.Message],
});

// ----------------------------------------------------------------------------
//  Ready: register the /setup-intro slash command for the guild
// ----------------------------------------------------------------------------
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const setupCmd = new SlashCommandBuilder()
    .setName('setup-intro')
    .setDescription('Post the introduction panel (button) in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  try {
    const guild = await c.guilds.fetch(CONFIG.guildId);
    await guild.commands.set([setupCmd.toJSON()]);
    console.log('Registered /setup-intro for guild', CONFIG.guildId);
  } catch (err) {
    console.error('Failed to register slash command:', err);
  }
});

// ----------------------------------------------------------------------------
//  New member joins -> give them the "Rookie Trainer" role (the gated state)
//  Requires the Server Members Intent (already enabled below).
// ----------------------------------------------------------------------------
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== CONFIG.guildId || member.user.bot) return;
  try {
    await member.roles.add(CONFIG.rookieRoleId, 'Joined server — awaiting onboarding');
  } catch (err) {
    console.error('Could not add Rookie Trainer on join (check hierarchy / Manage Roles):', err);
  }
});

// ----------------------------------------------------------------------------
//  Interaction router
// ----------------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-intro') {
      return handleSetup(interaction);
    }
    if (interaction.isButton() && interaction.customId === IDS.startButton) {
      return handleStartButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === IDS.modal) {
      return handleModalSubmit(interaction);
    }
    if (interaction.isButton() && interaction.customId === IDS.skipPhotoButton) {
      return handleSkipPhoto(interaction);
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction
        .reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

// ----------------------------------------------------------------------------
//  /setup-intro  -> posts the welcome panel with the Start button
// ----------------------------------------------------------------------------
async function handleSetup(interaction) {
  const embed = new EmbedBuilder()
    .setColor(CONFIG.embedColor)
    .setTitle('👋 Welcome, Trainer!')
    .setDescription(
      [
        'To unlock the rest of the server, introduce yourself.',
        '',
        'Click the button below and tell us:',
        '• Your **Pokémon GO** name',
        '• What you’d like to be **called** (e.g. John)',
        '• A few **fun facts** about you',
        '',
        'You’ll also get the option to add a photo so people can recognize you at meetups. 📸',
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.startButton)
      .setLabel('Start Introduction')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: 'Panel posted. ✅', flags: MessageFlags.Ephemeral });
}

// ----------------------------------------------------------------------------
//  Start button -> show the modal (unless already verified)
// ----------------------------------------------------------------------------
async function handleStartButton(interaction) {
  if (!interaction.inGuild()) return;

  const alreadyVerified = interaction.member.roles.cache.has(CONFIG.aceRoleId);
  if (alreadyVerified) {
    return interaction.reply({
      content: 'You’re already verified — you have full access. 🎉',
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = new ModalBuilder().setCustomId(IDS.modal).setTitle('Introduce Yourself');

  const pogo = new TextInputBuilder()
    .setCustomId(IDS.field.pogo)
    .setLabel('Your Pokémon GO name')
    .setPlaceholder('e.g. AshKetchum2010')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  const preferred = new TextInputBuilder()
    .setCustomId(IDS.field.preferred)
    .setLabel('What should we call you?')
    .setPlaceholder('e.g. John')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(60)
    .setRequired(true);

  const facts = new TextInputBuilder()
    .setCustomId(IDS.field.facts)
    .setLabel('Tell us about you / fun facts')
    .setPlaceholder('Favorite team, how long you’ve played, what you’re hoping to find here…')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(pogo),
    new ActionRowBuilder().addComponents(preferred),
    new ActionRowBuilder().addComponents(facts)
  );

  await interaction.showModal(modal);
}

// ----------------------------------------------------------------------------
//  Modal submit -> stash answers, then DM for the optional photo
// ----------------------------------------------------------------------------
async function handleModalSubmit(interaction) {
  const userId = interaction.user.id;

  const entry = {
    pogoName: interaction.fields.getTextInputValue(IDS.field.pogo).trim(),
    preferredName: interaction.fields.getTextInputValue(IDS.field.preferred).trim(),
    funFacts: interaction.fields.getTextInputValue(IDS.field.facts).trim(),
    modalInteraction: interaction,
    dmCollector: null,
    finalized: false,
  };
  pending.set(userId, entry);

  // The fallback button lets people with closed DMs finish without a photo.
  const skipRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.skipPhotoButton)
      .setLabel('Finish without photo')
      .setStyle(ButtonStyle.Secondary)
  );

  // Try to DM for a photo.
  let dmOk = false;
  try {
    const dm = await interaction.user.createDM();
    await dm.send(
      'Thanks for introducing yourself! 📸\n' +
        'If you’d like people to recognize you at meetups, **upload a photo here** (just drag an image into this DM).\n' +
        `Or reply **skip**. I’ll wait about ${Math.round(CONFIG.photoTimeoutMs / 1000)} seconds, then finish you up either way.`
    );
    dmOk = true;

    const collector = dm.createMessageCollector({
      filter: (m) => m.author.id === userId,
      time: CONFIG.photoTimeoutMs,
    });
    entry.dmCollector = collector;

    collector.on('collect', async (m) => {
      const img = m.attachments.find(
        (a) => a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
      );
      if (img) {
        collector.stop('photo');
        await finalize(userId, img).catch((e) => console.error(e));
        return;
      }
      if (m.content.trim().toLowerCase() === 'skip') {
        collector.stop('skip');
        await finalize(userId, null).catch((e) => console.error(e));
        return;
      }
      m.reply('Please send an **image**, or reply **skip**.').catch(() => {});
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'time') {
        await finalize(userId, null).catch((e) => console.error(e));
      }
    });
  } catch {
    dmOk = false;
  }

  await interaction.reply({
    content: dmOk
      ? 'Almost done! I just **DMed you** to optionally add a meetup photo. ' +
        'Add one there, or use the button below to finish now.'
      : 'I couldn’t DM you (your DMs may be closed), so I’ll skip the photo step. ' +
        'Click below to finish and unlock the server.',
    components: [skipRow],
    flags: MessageFlags.Ephemeral,
  });
}

// ----------------------------------------------------------------------------
//  "Finish without photo" fallback button
// ----------------------------------------------------------------------------
async function handleSkipPhoto(interaction) {
  const entry = pending.get(interaction.user.id);
  if (!entry || entry.finalized) {
    return interaction.reply({
      content: 'Looks like you’re already set! 🎉',
      flags: MessageFlags.Ephemeral,
    });
  }
  entry.dmCollector?.stop('skip-button');
  await interaction.update({ content: 'Finishing up… ✅', components: [] });
  await finalize(interaction.user.id, null);
}

// ----------------------------------------------------------------------------
//  Finalize: grant role + post the intro card. Runs at most once per user.
// ----------------------------------------------------------------------------
async function finalize(userId, photoAttachment) {
  const entry = pending.get(userId);
  if (!entry || entry.finalized) return;
  entry.finalized = true;
  entry.dmCollector?.stop();

  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    pending.delete(userId);
    return;
  }

  // 1) Swap roles: grant "Ace Trainer" (unlocks server), remove "Rookie Trainer".
  try {
    await member.roles.add(CONFIG.aceRoleId, 'Completed onboarding');
    if (member.roles.cache.has(CONFIG.rookieRoleId)) {
      await member.roles.remove(CONFIG.rookieRoleId, 'Completed onboarding');
    }
  } catch (err) {
    console.error('Could not swap roles (check hierarchy / Manage Roles perm):', err);
  }

  // 2) Build the intro card.
  const embed = new EmbedBuilder()
    .setColor(CONFIG.embedColor)
    .setAuthor({
      name: member.user.tag,
      iconURL: member.user.displayAvatarURL(),
    })
    .setTitle(`👋 Meet ${entry.preferredName}`)
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Pokémon GO Name', value: codeSafe(entry.pogoName), inline: true },
      { name: 'Call Me', value: codeSafe(entry.preferredName), inline: true },
      { name: 'About', value: entry.funFacts || '—' }
    )
    .setFooter({ text: 'New trainer onboarded' })
    .setTimestamp();

  const messageOptions = {
    embeds: [embed],
    // Never let user-provided text ping @everyone/roles; user mention won't notify either.
    allowedMentions: { parse: [] },
  };

  // Attach the meetup photo (re-uploaded so the link never expires).
  if (photoAttachment) {
    const ext = (photoAttachment.name?.match(/\.(png|jpe?g|gif|webp)$/i) || ['', 'png'])[1] || 'png';
    const file = new AttachmentBuilder(photoAttachment.url, { name: `meetup-photo.${ext}` });
    embed.setImage(`attachment://meetup-photo.${ext}`);
    messageOptions.files = [file];
  }

  // 3) Post it.
  try {
    const introChannel = await guild.channels.fetch(CONFIG.introChannelId);
    await introChannel.send(messageOptions);
  } catch (err) {
    console.error('Could not post to intro channel:', err);
  }

  // 4) Confirm to the user, and tidy up the ephemeral reply.
  member.user
    .send('You’re all set — welcome to the community! 🎉 You now have full access to the server.')
    .catch(() => {});
  entry.modalInteraction
    ?.editReply({ content: 'Done! You’ve been verified and your intro is posted. 🎉', components: [] })
    .catch(() => {});

  pending.delete(userId);
}

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------
// Wrap short values in inline code so stray markdown/mentions can't break layout.
function codeSafe(str) {
  const cleaned = (str || '—').replace(/`/g, "'");
  return `\`${cleaned}\``;
}

// ----------------------------------------------------------------------------
client.login(CONFIG.token);
