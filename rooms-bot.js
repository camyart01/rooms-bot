// rooms-bot.js — versión mejorada con hora/fecha, acumulado semanal y hojas por username
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
const XLSX = require('xlsx');

// ---------- Config (desde .env) ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;           
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID || CHANNEL_ID;       
const REPORTS_CHANNEL_ID = process.env.REPORTS_CHANNEL_ID || CHANNEL_ID; 
const RESULTS_CHANNEL_ID = process.env.RESULTS_CHANNEL_ID || CHANNEL_ID; 
const MONITOR_ROLE_ID = process.env.MONITOR_ROLE_ID; 

console.log("TOKEN:", TOKEN ? "✅" : "❌ No encontrado");
console.log("CLIENT_ID:", CLIENT_ID || "❌ No encontrado");
console.log("GUILD_ID:", GUILD_ID || "❌ No encontrado");
console.log("CHANNEL_ID:", CHANNEL_ID || "❌ No encontrado");
console.log("LOGS_CHANNEL_ID:", LOGS_CHANNEL_ID || "❌ No encontrado");
console.log("REPORTS_CHANNEL_ID:", REPORTS_CHANNEL_ID || "❌ No encontrado");
console.log("RESULTS_CHANNEL_ID:", RESULTS_CHANNEL_ID || "❌ No encontrado");
console.log("MONITOR_ROLE_ID:", MONITOR_ROLE_ID || "(no definido)");

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Faltan variables en .env (DISCORD_TOKEN, CLIENT_ID, GUILD_ID). Corrige y vuelve a ejecutar.");
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
const encode = (s) => encodeURIComponent(s);
const decode = (s) => decodeURIComponent(s);

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
}

function getDateTime() {
  const now = new Date();
  return now.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
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

    // Botones
    if (interaction.isButton()) {
      const id = interaction.customId;
      const userId = interaction.user.id;
      const username = interaction.user.username;

      // --- Seleccionar room ---
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
        await interaction.reply({
          content: `Has sido asignada a **${room}**. (${getDateTime()})\nLee la lista y usa los botones:`,
          components: controlRows,
          ephemeral: true
        });
        try {
          const channel = await client.channels.fetch(CHANNEL_ID);
          const rowsPublic = createRoomButtons(roomsData);
          await channel.send({ content: `🔄 Estado actualizado de rooms — ${getDateTime()}`, components: rowsPublic });
        } catch {}
        return;
      }

      // --- Acciones ---
      if (id.startsWith('start::') || id.startsWith('review::') || id.startsWith('end::') || id.startsWith('report::') || id.startsWith('resultado::')) {
        const [prefix, encoded] = id.split('::');
        const room = decode(encoded);
        const timestamp = getDateTime();

        if (roomsData[room] && roomsData[room] !== userId && prefix !== 'report' && prefix !== 'resultado') {
          await interaction.reply({ content: `❌ No puedes ejecutar esta acción: ${room} está asignado a otra persona.`, ephemeral: true });
          return;
        }
        const logChannel = await client.channels.fetch(LOGS_CHANNEL_ID).catch(()=>null);

        if (prefix === 'start') {
          if (logChannel) await logChannel.send(`🟢 **Inicio de turno** — ${interaction.user.tag} en **${room}** (${timestamp})`);
          await interaction.reply({ content: `✅ Turno iniciado en ${room} — ${timestamp}`, ephemeral: true });
          return;
        }

        if (prefix === 'review') {
          let mention = MONITOR_ROLE_ID ? ` <@&${MONITOR_ROLE_ID}>` : '';
          if (logChannel) await logChannel.send(`🟡 **Revisión solicitada** — ${interaction.user.tag} en **${room}**${mention} (${timestamp})`);
          await interaction.reply({ content: `🔔 Se notificó a los monitores (${timestamp}).${MONITOR_ROLE_ID ? '' : ' (MONITOR_ROLE_ID no configurado)'}`, ephemeral: true });
          return;
        }

        if (prefix === 'end') {
          roomsData[room] = null;
          saveRooms();
          if (logChannel) await logChannel.send(`🔴 **Finalización de turno** — ${interaction.user.tag} en **${room}** (${timestamp})`);
          await interaction.reply({ content: `🛑 Turno finalizado en ${room}. Gracias. (${timestamp})`, ephemeral: true });
          try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            const rowsPublic = createRoomButtons(roomsData);
            await channel.send({ content: `🔄 Estado actualizado de rooms — ${timestamp}`, components: rowsPublic });
          } catch {}
          return;
        }

        if (prefix === 'report') {
          const modal = new ModalBuilder()
            .setCustomId(`report_modal::${encode(room)}`)
            .setTitle(`Reportar problema — ${room}`);
          const input = new TextInputBuilder()
            .setCustomId('report_text')
            .setLabel('Describe la eventualidad')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
          return;
        }

        if (prefix === 'resultado') {
          const modal = new ModalBuilder()
            .setCustomId(`resultado_modal::${encode(room)}`)
            .setTitle(`Resultados — ${room}`);
          const platforms = ['AdultWork', 'Stripchat', 'Stremate', 'BongaCams'];
          platforms.forEach(p => {
            const input = new TextInputBuilder()
              .setCustomId(`resultado_${p}`)
              .setLabel(`Cantidad ${p}`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
          });
          await interaction.showModal(modal);
          return;
        }
      }
    }

    // --- Modal submit ---
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('report_modal::')) {
        const room = decode(interaction.customId.split('::')[1]);
        const text = interaction.fields.getTextInputValue('report_text');
        try {
          const reportsChannel = await client.channels.fetch(REPORTS_CHANNEL_ID);
          const embed = new EmbedBuilder()
            .setTitle('⚠️ Reporte de problema')
            .addFields(
              { name: 'Room', value: room, inline: true },
              { name: 'Usuario', value: `${interaction.user.tag}`, inline: true },
              { name: 'Reporte', value: text }
            )
            .setFooter({ text: `Fecha y hora: ${getDateTime()}` });
          await reportsChannel.send({ embeds: [embed] });
          await interaction.reply({ content: '✅ Tu reporte ha sido enviado a los monitores. Gracias.', ephemeral: true });
        } catch {
          await interaction.reply({ content: '❌ No se pudo enviar el reporte. Avísale al monitor.', ephemeral: true });
        }
        return;
      }

      if (interaction.customId.startsWith('resultado_modal::')) {
        const room = decode(interaction.customId.split('::')[1]);
        const user = interaction.user.tag;
        const username = interaction.user.username;
        const platforms = ['AdultWork', 'Stripchat', 'Streamate', 'BongaCams'];
        const results = {};

        platforms.forEach(p => {
          const val = interaction.fields.getTextInputValue(`resultado_${p}`);
          results[p] = parseInt(val.replace(/\D/g,'')) || 0;
        });

        const totalDiario = Object.values(results).reduce((a,b)=>a+b,0);

        // Guardar en Excel
        const file = './resultados.xlsx';
        let wb = fs.existsSync(file) ? XLSX.readFile(file) : XLSX.utils.book_new();
        let ws;
        if (wb.Sheets[username]) ws = wb.Sheets[username];
        else {
          ws = XLSX.utils.json_to_sheet([]);
          XLSX.utils.book_append_sheet(wb, ws, username);
        }

        const jsonData = XLSX.utils.sheet_to_json(ws, { defval:0 });
        const today = new Date().toISOString().slice(0,10);
        const weekDay = new Date().getDay();
        if (weekDay === 0 && jsonData.length>0) jsonData.length = 0;

        const acumuladoAnterior = jsonData.reduce((acc,row)=>{
          platforms.forEach(p=>acc[p]=(acc[p]||0)+(row[p]||0));
          return acc;
        },{});

        const newRow = { Fecha: today, ...results };
        platforms.forEach(p=>newRow[`Acumulado_${p}`]=(acumuladoAnterior[p]||0)+results[p]);
        newRow['Total_Diario'] = totalDiario;
        newRow['Acumulado_Semana'] = (jsonData.reduce((acc,row)=>acc+(row['Total_Diario']||0),0)) + totalDiario;
        jsonData.push(newRow);

        const newSheet = XLSX.utils.json_to_sheet(jsonData);
        wb.Sheets[username] = newSheet;
        XLSX.writeFile(wb,file);

        try {
          const resultsChannel = await client.channels.fetch(RESULTS_CHANNEL_ID);
          const embed = new EmbedBuilder()
            .setTitle('✅ Resultados enviados')
            .setDescription(`Modelo: ${user}\nRoom: ${room}\nFecha y hora: ${getDateTime()}`)
            .addFields(...platforms.map(p=>({name: p, value: `${results[p]}`, inline:true})),
                       { name: 'Total Diario', value: `${totalDiario}`, inline:true },
                       { name: 'Acumulado Semana', value: `${newRow['Acumulado_Semana']}`, inline:true })
            .setTimestamp();
          await resultsChannel.send({ embeds: [embed] });
          await interaction.reply({ content: '✅ Resultados enviados correctamente.', ephemeral: true });
        } catch {
          await interaction.reply({ content: '❌ Error enviando resultados.', ephemeral: true });
        }
      }
    }

  } catch (err) {
    console.error('Error en interactionCreate:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Ocurrió un error interno. Intenta de nuevo.', ephemeral: true });
    }
  }
});

// ---------- login ----------
client.login(TOKEN).catch(err => {
  console.error('Error de login (token inválido?):', err);
});
