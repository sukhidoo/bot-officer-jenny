// ============================================================================
//  Pokémon GO Community — Gatekeeper / Onboarding Bot
//  discord.js v14
//
//  Flow:
//   1. New members can only see #welcome (a button-only channel).
//   2. "Start Introduction" -> a modal asks for PoGo name / preferred name /
//      fun facts, then a DM for an optional meetup photo.
//   3. On finish: swap "Rookie Trainer" -> "Ace Trainer" (unlocks the server)
//      and post a formatted intro card in #introductions.
//   4. "Edit my intro card" (in #edit-intro-card) lets a member update their
//      card later — the bot edits their ORIGINAL card in place.
//
//  Card ownership (which message belongs to whom) is stored in data/intros.json
//  so edits survive bot restarts.
//
//  See README.md for full setup (intents, role/channel permissions, .env).
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');

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
  photoTimeoutMs: 300_000,
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
  editButton: 'intro:edit',
  modal: 'intro:modal',           // create flow
  editModal: 'intro:editmodal',   // edit flow
  skipPhotoButton: 'intro:skipphoto',
  field: { pogo: 'pogo', preferred: 'preferred', facts: 'facts' },
};

// ----------------------------------------------------------------------------
//  Persistent store: userId -> { messageId, pogoName, preferredName,
//                                funFacts, photoName }
//  A small JSON file on disk so intro cards can be edited after a restart.
// ----------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'intros.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {}; // file doesn't exist yet / unreadable -> start empty
  }
}
function saveStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Could not write intro store:', err);
  }
}
function getRecord(userId) {
  return loadStore()[userId] || null;
}
function setRecord(userId, rec) {
  const store = loadStore();
  store[userId] = { ...(store[userId] || {}), ...rec };
  saveStore(store);
}
function deleteRecord(userId) {
  const store = loadStore();
  delete store[userId];
  saveStore(store);
}

// ----------------------------------------------------------------------------
//  In-memory state: holds answers between the modal submit and the photo step.
// ----------------------------------------------------------------------------
const pending = new Map(); // userId -> { mode, pogoName, ..., modalInteraction, dmCollector, finalized }

// ----------------------------------------------------------------------------
//  Client
// ----------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: "Server Members Intent" (role mgmt)
    GatewayIntentBits.DirectMessages, // to receive the photo DM
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ----------------------------------------------------------------------------
//  Ready: register the slash commands for the guild
// ----------------------------------------------------------------------------
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-intro')
      .setDescription('Post the introduction panel (button) in this channel.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('setup-edit')
      .setDescription('Post the "edit my intro card" panel in this channel.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('reset-card')
      .setDescription('Admin: reset a member — delete their intro card and send them back to Rookie Trainer.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((opt) =>
        opt.setName('member').setDescription('The member to reset').setRequired(true)
      ),
  ];

  try {
    const guild = await c.guilds.fetch(CONFIG.guildId);
    await guild.commands.set(commands.map((cmd) => cmd.toJSON()));
    console.log('Registered /setup-intro and /setup-edit for guild', CONFIG.guildId);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

// ----------------------------------------------------------------------------
//  New member joins -> give them the "Rookie Trainer" role (the gated state)
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
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-intro') return handleSetup(interaction, 'create');
      if (interaction.commandName === 'setup-edit') return handleSetup(interaction, 'edit');
      if (interaction.commandName === 'reset-card') return handleResetCard(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId === IDS.startButton) return handleStartButton(interaction);
      if (interaction.customId === IDS.editButton) return handleEditButton(interaction);
      if (interaction.customId === IDS.skipPhotoButton) return handleSkipPhoto(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === IDS.modal) return handleModalSubmit(interaction, 'create');
      if (interaction.customId === IDS.editModal) return handleModalSubmit(interaction, 'edit');
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
//  /setup-intro and /setup-edit -> post the appropriate panel + button
// ----------------------------------------------------------------------------
async function handleSetup(interaction, mode) {
  const isEdit = mode === 'edit';

  const embed = new EmbedBuilder()
    .setColor(CONFIG.embedColor)
    .setTitle(isEdit ? '✏️ Update Your Intro Card' : '👋 Welcome, Trainer!')
    .setDescription(
      isEdit
        ? [
            'Want to change your Pokémon GO name, what we call you, your fun',
            'facts, or your meetup photo? Click below — your current details will',
            'be pre-filled so you only change what you want.',
          ].join('\n')
        : [
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
      .setCustomId(isEdit ? IDS.editButton : IDS.startButton)
      .setLabel(isEdit ? 'Edit my intro card' : 'Start Introduction')
      .setEmoji(isEdit ? '✏️' : '📝')
      .setStyle(isEdit ? ButtonStyle.Primary : ButtonStyle.Success)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: 'Panel posted. ✅', flags: MessageFlags.Ephemeral });
}

// ----------------------------------------------------------------------------
//  /reset-card  (admin) -> delete a member's card + send them back to Rookie
// ----------------------------------------------------------------------------
async function handleResetCard(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('member');
  if (target.bot) {
    return interaction.editReply('That’s a bot — nothing to reset. 🤖');
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(target.id).catch(() => null);
  const steps = [];

  // 1) Swap roles back: remove Ace Trainer, add Rookie Trainer.
  if (member) {
    try {
      await member.roles.add(CONFIG.rookieRoleId, `Card reset by ${interaction.user.tag}`);
      if (member.roles.cache.has(CONFIG.aceRoleId)) {
        await member.roles.remove(CONFIG.aceRoleId, `Card reset by ${interaction.user.tag}`);
      }
      steps.push('🔁 Roles set back to **Rookie Trainer**.');
    } catch (err) {
      console.error('Reset: role swap failed:', err);
      steps.push('⚠️ Could not change roles (check the bot’s role is above both, and Manage Roles).');
    }
  } else {
    steps.push('ℹ️ That user isn’t in the server, so no roles were changed.');
  }

  // 2) Delete their intro card from #introductions, if we have it on record.
  const record = getRecord(target.id);
  if (record?.messageId) {
    try {
      const introChannel = await guild.channels.fetch(CONFIG.introChannelId);
      const msg = await introChannel.messages.fetch(record.messageId);
      await msg.delete();
      steps.push('🗑️ Their intro card was deleted.');
    } catch {
      steps.push('ℹ️ Couldn’t find their card to delete (it may already be gone).');
    }
  } else {
    steps.push('ℹ️ No saved intro card was on record for them.');
  }

  // 3) Clear their saved record + any in-progress onboarding state.
  deleteRecord(target.id);
  pending.delete(target.id);

  // 4) Let the member know (best effort).
  target
    .send(
      'A server admin has reset your introduction. Head back to the welcome ' +
        'channel when you have a moment to re-introduce yourself. 🙂'
    )
    .catch(() => {});

  await interaction.editReply(`Reset complete for <@${target.id}>:\n${steps.join('\n')}`);
}

// ----------------------------------------------------------------------------
//  Build the intro modal, optionally pre-filled (for edits)
// ----------------------------------------------------------------------------
function buildIntroModal(mode, prefill = {}) {
  const isEdit = mode === 'edit';
  const modal = new ModalBuilder()
    .setCustomId(isEdit ? IDS.editModal : IDS.modal)
    .setTitle(isEdit ? 'Edit Your Intro' : 'Introduce Yourself');

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

  if (prefill.pogoName) pogo.setValue(prefill.pogoName);
  if (prefill.preferredName) preferred.setValue(prefill.preferredName);
  if (prefill.funFacts) facts.setValue(prefill.funFacts);

  modal.addComponents(
    new ActionRowBuilder().addComponents(pogo),
    new ActionRowBuilder().addComponents(preferred),
    new ActionRowBuilder().addComponents(facts)
  );
  return modal;
}

// ----------------------------------------------------------------------------
//  Start button -> show the modal (unless already verified)
// ----------------------------------------------------------------------------
async function handleStartButton(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.member.roles.cache.has(CONFIG.aceRoleId)) {
    return interaction.reply({
      content: 'You’re already verified — you have full access. 🎉 ' +
        'Want to change your card? Use the **Edit my intro card** button.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildIntroModal('create'));
}

// ----------------------------------------------------------------------------
//  Edit button -> show a pre-filled modal (must already be verified)
// ----------------------------------------------------------------------------
async function handleEditButton(interaction) {
  if (!interaction.inGuild()) return;

  if (!interaction.member.roles.cache.has(CONFIG.aceRoleId)) {
    return interaction.reply({
      content: 'You’ll need to introduce yourself first in the welcome channel before you can edit a card. 🙂',
      flags: MessageFlags.Ephemeral,
    });
  }

  const existing = getRecord(interaction.user.id) || {};
  await interaction.showModal(buildIntroModal('edit', existing));
}

// ----------------------------------------------------------------------------
//  Modal submit -> stash answers, then DM for the (optional) photo
// ----------------------------------------------------------------------------
async function handleModalSubmit(interaction, mode) {
  const userId = interaction.user.id;
  const isEdit = mode === 'edit';

  const entry = {
    mode,
    pogoName: interaction.fields.getTextInputValue(IDS.field.pogo).trim(),
    preferredName: interaction.fields.getTextInputValue(IDS.field.preferred).trim(),
    funFacts: interaction.fields.getTextInputValue(IDS.field.facts).trim(),
    modalInteraction: interaction,
    dmCollector: null,
    finalized: false,
  };
  pending.set(userId, entry);

  const skipRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.skipPhotoButton)
      .setLabel(isEdit ? 'Keep my current photo' : 'Finish without photo')
      .setStyle(ButtonStyle.Secondary)
  );

  const dmPrompt = isEdit
    ? 'Want to change your meetup photo? 📸\n' +
      '**Upload a new image here** to replace it, or reply **keep** to leave it as-is.\n' +
      `I’ll wait about ${Math.round(CONFIG.photoTimeoutMs / 1000)} seconds, then save your changes.`
    : 'Thanks for introducing yourself! 📸\n' +
      'If you’d like people to recognize you at meetups, **upload a photo here** (just drag an image into this DM).\n' +
      `Or reply **skip**. I’ll wait about ${Math.round(CONFIG.photoTimeoutMs / 1000)} seconds, then finish you up either way.`;

  let dmOk = false;
  try {
    const dm = await interaction.user.createDM();
    await dm.send(dmPrompt);
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
      const word = m.content.trim().toLowerCase();
      if (word === 'skip' || word === 'keep') {
        collector.stop('skip');
        await finalize(userId, null).catch((e) => console.error(e));
        return;
      }
      m.reply(`Please send an **image**, or reply **${isEdit ? 'keep' : 'skip'}**.`).catch(() => {});
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'time') await finalize(userId, null).catch((e) => console.error(e));
    });
  } catch {
    dmOk = false;
  }

  const ephemeral = isEdit
    ? dmOk
      ? 'I just **DMed you** to optionally change your photo. Update it there, or use the button below to keep your current one.'
      : 'I couldn’t DM you (your DMs may be closed), so I’ll keep your current photo. Click below to save your changes.'
    : dmOk
      ? 'Almost done! I just **DMed you** to optionally add a meetup photo. Add one there, or use the button below to finish now.'
      : 'I couldn’t DM you (your DMs may be closed), so I’ll skip the photo step. Click below to finish and unlock the server.';

  await interaction.reply({ content: ephemeral, components: [skipRow], flags: MessageFlags.Ephemeral });
}

// ----------------------------------------------------------------------------
//  Skip / Keep button
// ----------------------------------------------------------------------------
async function handleSkipPhoto(interaction) {
  const entry = pending.get(interaction.user.id);
  if (!entry || entry.finalized) {
    return interaction.reply({ content: 'Looks like you’re already set! 🎉', flags: MessageFlags.Ephemeral });
  }
  entry.dmCollector?.stop('skip-button');
  await interaction.update({ content: 'Saving… ✅', components: [] });
  await finalize(interaction.user.id, null);
}

// ----------------------------------------------------------------------------
//  Finalize: post a NEW card, or EDIT the member's existing one in place.
//  Runs at most once per pending entry.
// ----------------------------------------------------------------------------
async function finalize(userId, photoAttachment) {
  const entry = pending.get(userId);
  if (!entry || entry.finalized) return;
  entry.finalized = true;
  entry.dmCollector?.stop();

  const isEdit = entry.mode === 'edit';
  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    pending.delete(userId);
    return;
  }

  // Role swap only happens on first-time onboarding.
  if (!isEdit) {
    try {
      await member.roles.add(CONFIG.aceRoleId, 'Completed onboarding');
      if (member.roles.cache.has(CONFIG.rookieRoleId)) {
        await member.roles.remove(CONFIG.rookieRoleId, 'Completed onboarding');
      }
    } catch (err) {
      console.error('Could not swap roles (check hierarchy / Manage Roles perm):', err);
    }
  }

  const existing = getRecord(userId); // may be null (first card, or pre-update member)

  // Build the card.
  const embed = new EmbedBuilder()
    .setColor(CONFIG.embedColor)
    .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
    .setTitle(`👋 Meet ${entry.preferredName}`)
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Pokémon GO Name', value: codeSafe(entry.pogoName), inline: true },
      { name: 'Call Me', value: codeSafe(entry.preferredName), inline: true },
      { name: 'About', value: entry.funFacts || '—' }
    )
    .setFooter({ text: isEdit ? 'Intro updated' : 'New trainer onboarded' })
    .setTimestamp();

  // Photo handling.
  //  - new photo uploaded  -> attach it (replace any existing)
  //  - no new photo + edit + had a photo -> keep the existing attachment
  //  - otherwise -> no image
  let photoName = null;
  let newFile = null;
  if (photoAttachment) {
    const ext = (photoAttachment.name?.match(/\.(png|jpe?g|gif|webp)$/i) || ['', 'png'])[1] || 'png';
    photoName = `meetup-photo.${ext}`;
    newFile = new AttachmentBuilder(photoAttachment.url, { name: photoName });
    embed.setImage(`attachment://${photoName}`);
  } else if (existing?.photoName) {
    photoName = existing.photoName;
    embed.setImage(`attachment://${photoName}`); // references the kept attachment
  }

  // Post a new message or edit the existing one in place.
  let messageId = existing?.messageId || null;
  try {
    const introChannel = await guild.channels.fetch(CONFIG.introChannelId);
    let edited = false;

    if (messageId) {
      try {
        const msg = await introChannel.messages.fetch(messageId);
        const opts = { embeds: [embed], allowedMentions: { parse: [] } };
        if (newFile) {
          opts.files = [newFile]; // add new photo
          opts.attachments = [];  // and drop the old one
        } // else: omit files/attachments -> existing attachment is retained
        await msg.edit(opts);
        edited = true;
      } catch {
        messageId = null; // old card was deleted -> fall through to posting fresh
      }
    }

    if (!edited) {
      const opts = { embeds: [embed], allowedMentions: { parse: [] } };
      if (newFile) opts.files = [newFile];
      const posted = await introChannel.send(opts);
      messageId = posted.id;
    }
  } catch (err) {
    console.error('Could not post/edit intro card:', err);
  }

  // Persist the record so future edits land on the same message.
  setRecord(userId, {
    messageId,
    pogoName: entry.pogoName,
    preferredName: entry.preferredName,
    funFacts: entry.funFacts,
    photoName,
  });

  // Confirm to the member, tidy the ephemeral reply.
  const dmMsg = isEdit
    ? 'Your intro card has been updated! ✨'
    : 'You’re all set — welcome to the community! 🎉 You now have full access to the server.';
  const replyMsg = isEdit
    ? 'Updated your intro card. ✨'
    : 'Done! You’ve been verified and your intro is posted. 🎉';

  member.user.send(dmMsg).catch(() => {});
  entry.modalInteraction?.editReply({ content: replyMsg, components: [] }).catch(() => {});

  pending.delete(userId);
}

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------
function codeSafe(str) {
  const cleaned = (str || '—').replace(/`/g, "'");
  return `\`${cleaned}\``;
}

// ----------------------------------------------------------------------------
client.login(CONFIG.token);
