// rooms-bot.js — versión final y corregida (panel + resultados -> Google Sheets)
require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { google } = require('googleapis');

// ---------- Config (desde .env) ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID || null;
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID || CHANNEL_ID;
const REPORTS_CHANNEL_ID = process.env.REPORTS_CHANNEL_ID || CHANNEL_ID;
const RESULTS_CHANNEL_ID = process.env.RESULTS_CHANNEL_ID || CHANNEL_ID;
const MONITOR_ROLE_ID = process.env.MONITOR_ROLE_ID || null;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || null;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || null;

console.log("TOKEN:", TOKEN ? "✅" : "❌ No encontrado");
console.log("CLIENT_ID:", CLIENT_ID || "❌ No encontrado");
console.log("GUILD_ID:", GUILD_ID || "❌ No encontrado");
console.log("CHANNEL_ID:", CHANNEL_ID || "(no definido)");
console.log("LOGS_CHANNEL_ID:", LOGS_CHANNEL_ID || "(no definido)");
console.log("REPORTS_CHANNEL_ID:", REPORTS_CHANNEL_ID || "(no definido)");
console.log("RESULTS_CHANNEL_ID:", RESULTS_CHANNEL_ID || "(no definido)");
console.log("MONITOR_ROLE_ID:", MONITOR_ROLE_ID || "(no definido)");
console.log("GOOGLE_CREDENTIALS:", GOOGLE_CREDENTIALS ? "✅" : "❌ No encontrado");
console.log("GOOGLE_SHEET_ID:", GOOGLE_SHEET_ID ? "✅" : "❌ No encontrado");

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Faltan variables obligatorias en .env (DISCORD_TOKEN, CLIENT_ID, GUILD_ID).");
  process.exit(1);
}

// ---------- Archivo rooms.json ----------
const ROOMS_FILE = './rooms.json';
if (!fs.existsSync(ROOMS_FILE)) {
  const initial = {
    "Room 1": null,
    "Room 2": null,
    "Room 3": null,
    "Room 4": null,
    "Room 5": null,
    "Room 6": null
  };
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(initial, null, 2), 'utf8');
}
let roomsData = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
console.log("roomsData cargado:", roomsData);

// ---------- Cliente ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ---------- Helpers ----------
const encode = s => encodeURIComponent(s);
const decode = s => decodeURIComponent(s);

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
}

function getDateTime() {
  return new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function sanitizeSheetName(name) {
  if (!name) return 'Unknown';
  let s = String(name).replace(/[\[\]\*\/\\\?\:]/g, '').trim();
  if (s.length === 0) s = 'Unknown';
  if (s.length > 100) s = s.slice(0, 100);
  return s;
}

function createRoomButtons(data) {
  const names = Object.keys(data);
  const buttons = names.map(name => {
    const ocupado = data[name] !== null;
    return new ButtonBuilder()
      .setCustomId(`select::${encode(name)}`)
      .setLabel(ocupado ? `${name} (Ocupado)` : name)
      .setStyle(ocupado ? ButtonStyle.Danger : ButtonStyle.Success);
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

function createControlButtonsForRoom(roomName) {
  const enc = encode(roomName);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`start::${enc}`).setLabel('Iniciar Turno').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`review::${enc}`).setLabel('Revisión Room').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`end::${enc}`).setLabel('Terminar Turno').setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report::${enc}`).setLabel('Reportar Problema').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`resultado::${enc}`).setLabel('Ingresar Resultado').setStyle(ButtonStyle.Primary)
  );
  return [row1, row2];
}

// ---------- Registro comandos ----------
const rest = new REST({ version: '10' }).setToken(TOKEN);
async function registerCommands() {
  try {
    console.log("Registrando comandos en guild...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: [
        { name: 'panel', description: 'Abrir panel para seleccionar room' },
        { name: 'resultado', description: 'Ingresar resultados del room asignado' }
      ] }
    );
    console.log("✅ /panel y /resultado registrados");
  } catch (err) {
    console.error("Error registrando comandos:", err);
  }
}

// ---------- Ready ----------
client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  registerCommands();
});

// ---------- Function to save results to Google Sheets ----------
async function saveResultsToGoogleSheets(usernameRaw, resultsObj, totalDiario) {
  if (!GOOGLE_CREDENTIALS || !GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_CREDENTIALS o GOOGLE_SHEET_ID no configurados');
  }

  const username = sanitizeSheetName(usernameRaw);
  const credentials = JSON.parse(GOOGLE_CREDENTIALS);
  // Private key may contain escaped newlines; ensure correct format
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

  const jwtClient = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  await jwtClient.authorize();
  const sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });
  const spreadsheetId = GOOGLE_SHEET_ID;

  // Ensure sheet exists
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === username);
  if (!existing) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: username } } }
        ]
      }
    });
    // header row
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${username}!A1:H1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Fecha','AdultWork','Stripchat','Streamate','BongaCams','Total_Diario','Acumulado_Semana','Hora']] }
    });
  }

  // Read existing data
  const existingData = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${username}!A2:H`
  }).catch(e => ({ data: { values: [] } }));
  const rows = existingData.data.values || [];

  // Reset weekly on Sunday (0)
  const today = new Date();
  if (today.getDay() === 0 && rows.length > 0) {
    await sheetsApi.spreadsheets.values.clear({ spreadsheetId, range: `${username}!A2:H` });
    rows.length = 0;
  }

  // Calculate previous accumulated (sum of Total_Diario column in existing rows index 5)
  const acumuladoPrevio = rows.reduce((acc, r) => acc + (parseInt(r[5]) || 0), 0);
  const acumuladoNuevo = acumuladoPrevio + totalDiario;

  const fechaStr = today.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const horaStr = today.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });

  const nuevaFila = [
    fechaStr,
    resultsObj['AdultWork'] || 0,
    resultsObj['Stripchat'] || 0,
    resultsObj['Streamate'] || 0,
    resultsObj['BongaCams'] || 0,
    totalDiario,
    acumuladoNuevo,
    horaStr
  ];

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId,
    range: `${username}!A:H`,
    valueInputOption: 'RAW',
    requestBody: { values: [nuevaFila] }
  });

  return { fecha: fechaStr, hora: horaStr, acumuladoSemana: acumuladoNuevo };
}

// ---------- Interaction handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // /panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      const roomRows = createRoomButtons(roomsData);
      const checklist = new EmbedBuilder()
        .setTitle('🔍 Lista de Revisión del Room')
        .setColor(0x00AE86)
        .setDescription(
          "**1. Instrumentos a revisar:**\nPC, TV, Cámara, Teclado, Mouse, Trípode, Aro de Luz, Caja de Luz, Sombrilla, Espejo, Forro, Colchón, Silla, Sábanas, Cojines, Lámpara, Decoración, Trapero.\n\n" +
          "**2. Higiene adecuada:**\nLimpieza general del room."
        );
      await interaction.reply({ embeds: [checklist], components: roomRows, ephemeral: true });
      return;
    }

    // /resultado (comando opcional)
    if (interaction.isChatInputCommand() && interaction.commandName === 'resultado') {
      const userId = interaction.user.id;
      const roomName = Object.keys(roomsData).find(r => roomsData[r] === userId);
      if (!roomName) {
        await interaction.reply({ content: '❌ No estás asignada a ningún room actualmente.', ephemeral: true });
        return;
      }
      // open same modal as button does
      const modal = new ModalBuilder().setCustomId(`resultado_modal::${encode(roomName)}`).setTitle(`Resultados — ${roomName}`);
      const platforms = ['AdultWork','Stripchat','Streamate','BongaCams'];
      platforms.forEach(p => {
        const input = new TextInputBuilder().setCustomId(`resultado_${p}`).setLabel(`Cantidad ${p}`).setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });
      await interaction.showModal(modal);
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;
      const userId = interaction.user.id;

      // Select room
      if (id.startsWith('select::')) {
        const room = decode(id.slice('select::'.length));
        if (roomsData[room] === null || roomsData[room] === userId) {
          roomsData[room] = userId;
          saveRooms();
        } else {
          await interaction.reply({ content: `❌ ${room} ya está ocupado por otra modelo.`, ephemeral: true });
          return;
        }
        const controlRows = createControlButtonsForRoom(room);
        await interaction.reply({ content: `Has sido asignada a **${room}**. (${getDateTime()})`, components: controlRows, ephemeral: true });
        // optional public update
        try {
          const channel = CHANNEL_ID ? await client.channels.fetch(CHANNEL_ID).catch(()=>null) : null;
          if (channel) {
            const rowsPublic = createRoomButtons(roomsData);
            await channel.send({ content: `🔄 Estado actualizado de rooms — ${getDateTime()}`, components: rowsPublic });
          }
        } catch {}
        return;
      }

      // Room actions
      if (id.startsWith('start::') || id.startsWith('review::') || id.startsWith('end::') || id.startsWith('report::') || id.startsWith('resultado::')) {
        const [prefix, encoded] = id.split('::');
        const room = decode(encoded);
        const timestamp = getDateTime();

        if (roomsData[room] && roomsData[room] !== userId && prefix !== 'report' && prefix !== 'resultado') {
          await interaction.reply({ content: `❌ No puedes ejecutar esta acción: ${room} está asignado a otra persona.`, ephemeral: true });
          return;
        }

        const logChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(()=>null) : null;

        if (prefix === 'start') {
          if (logChannel) await logChannel.send(`🟢 **Inicio de turno** — ${interaction.user.tag} en **${room}** (${timestamp})`);
          await interaction.reply({ content: `✅ Turno iniciado en ${room} — ${timestamp}`, ephemeral: true });
          return;
        }

        if (prefix === 'review') {
          const mention = MONITOR_ROLE_ID ? ` <@&${MONITOR_ROLE_ID}>` : '';
          if (logChannel) await logChannel.send(`🟡 **Revisión solicitada** — ${interaction.user.tag} en **${room}**${mention} (${timestamp})`);
          await interaction.reply({ content: `🔔 Se notificó a los monitores (${timestamp}).`, ephemeral: true });
          return;
        }

        if (prefix === 'end') {
          roomsData[room] = null;
          saveRooms();
          if (logChannel) await logChannel.send(`🔴 **Finalización de turno** — ${interaction.user.tag} en **${room}** (${timestamp})`);
          await interaction.reply({ content: `🛑 Turno finalizado en ${room}. Gracias. (${timestamp})`, ephemeral: true });
          // update public
          try {
            const channel = CHANNEL_ID ? await client.channels.fetch(CHANNEL_ID).catch(()=>null) : null;
            if (channel) {
              const rowsPublic = createRoomButtons(roomsData);
              await channel.send({ content: `🔄 Estado actualizado de rooms — ${timestamp}`, components: rowsPublic });
            }
          } catch {}
          return;
        }

        if (prefix === 'report') {
          const modal = new ModalBuilder().setCustomId(`report_modal::${encode(room)}`).setTitle(`Reportar problema — ${room}`);
          const input = new TextInputBuilder().setCustomId('report_text').setLabel('Describe la eventualidad').setStyle(TextInputStyle.Paragraph).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
          return;
        }

        if (prefix === 'resultado') {
          const modal = new ModalBuilder().setCustomId(`resultado_modal::${encode(room)}`).setTitle(`Resultados — ${room}`);
          const platforms = ['AdultWork','Stripchat','Streamate','BongaCams'];
          platforms.forEach(p => {
            const input = new TextInputBuilder().setCustomId(`resultado_${p}`).setLabel(`Cantidad ${p}`).setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
          });
          await interaction.showModal(modal);
          return;
        }
      }
    }

    // Modal submit
    if (interaction.isModalSubmit()) {
      // Report modal
      if (interaction.customId.startsWith('report_modal::')) {
        const room = decode(interaction.customId.split('::')[1]);
        const text = interaction.fields.getTextInputValue('report_text');
        try {
          const reportsChannel = REPORTS_CHANNEL_ID ? await client.channels.fetch(REPORTS_CHANNEL_ID).catch(()=>null) : null;
          const embed = new EmbedBuilder()
            .setTitle('⚠️ Reporte de problema')
            .addFields(
              { name: 'Room', value: room, inline: true },
              { name: 'Usuario', value: `${interaction.user.tag}`, inline: true },
              { name: 'Reporte', value: text }
            )
            .setFooter({ text: `Fecha y hora: ${getDateTime()}` });
          if (reportsChannel) await reportsChannel.send({ embeds: [embed] });
          await interaction.reply({ content: '✅ Tu reporte ha sido enviado a los monitores. Gracias.', ephemeral: true });
        } catch (err) {
          console.error('Error enviando reporte:', err);
          await interaction.reply({ content: '❌ No se pudo enviar el reporte. Avísale al monitor.', ephemeral: true });
        }
        return;
      }

      // Resultados modal
      if (interaction.customId.startsWith('resultado_modal::')) {
        // IMPORTANT: defer reply immediately to avoid "Unknown interaction"
        await interaction.deferReply({ ephemeral: true });
        const room = decode(interaction.customId.split('::')[1]);
        const username = interaction.user.username || interaction.user.tag;
        const platforms = ['AdultWork','Stripchat','Streamate','BongaCams'];
        const results = {};
        try {
          platforms.forEach(p => {
            const raw = interaction.fields.getTextInputValue(`resultado_${p}`) || '0';
            // remove non digits and parse
            const n = parseInt(String(raw).replace(/\D/g,''), 10);
            results[p] = isNaN(n) ? 0 : n;
          });
        } catch (errFields) {
          console.error('Error leyendo campos del modal:', errFields);
          await interaction.editReply({ content: '❌ No se pudieron leer los campos del formulario. Intenta nuevamente.' });
          return;
        }

        const totalDiario = Object.values(results).reduce((a,b) => a + b, 0);

        // Guardar en Google Sheets (usa helper)
        try {
          const saved = await saveResultsToGoogleSheets(username, results, totalDiario);
          // enviar embed al canal de resultados
          try {
            const resultsChannel = RESULTS_CHANNEL_ID ? await client.channels.fetch(RESULTS_CHANNEL_ID).catch(()=>null) : null;
            const embed = new EmbedBuilder()
              .setTitle('✅ Resultados enviados')
              .setDescription(`Modelo: ${interaction.user.tag}\nRoom: ${room}\nFecha: ${saved.fecha} ${saved.hora}`)
              .addFields(
                ...platforms.map(p => ({ name: p, value: `${results[p]}`, inline: true })),
                { name: 'Total Diario', value: `${totalDiario}`, inline: true },
                { name: 'Acumulado Semana', value: `${saved.acumuladoSemana}`, inline: true }
              )
              .setTimestamp();
            if (resultsChannel) await resultsChannel.send({ embeds: [embed] });
          } catch (errSend) {
            console.error('Error enviando embed a canal de resultados:', errSend);
            // not fatal
          }
          await interaction.editReply({ content: '✅ Tus resultados fueron guardados correctamente y enviados al canal de resultados.' });
        } catch (errGS) {
          console.error('❌ Error guardando en Google Sheets:', errGS);
          await interaction.editReply({ content: `❌ Error guardando en Google Sheets: ${errGS.message || errGS}` });
        }
        return;
      }
    }

  } catch (err) {
    console.error('Error en interactionCreate:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Ocurrió un error interno. Intenta de nuevo.', ephemeral: true });
      } else if (interaction.deferred) {
        await interaction.editReply({ content: '❌ Ocurrió un error interno. Intenta de nuevo.' });
      }
    } catch (replyErr) {
      console.error('Error respondiendo interacción tras fallo:', replyErr);
    }
  }
});

// ---------- login ----------
client.login(TOKEN).catch(err => {
  console.error('Error de login (token inválido?):', err);
});
























