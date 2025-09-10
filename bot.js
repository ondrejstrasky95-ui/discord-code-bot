const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Database setup
const dbPath = path.join(__dirname, 'codes.db');
const db = new sqlite3.Database(dbPath);

// Initialize database tables
db.serialize(() => {
    // Table for available codes
    db.run(`CREATE TABLE IF NOT EXISTS codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        is_claimed BOOLEAN DEFAULT FALSE,
        claimed_by TEXT DEFAULT NULL,
        claimed_at DATETIME DEFAULT NULL
    )`, (err) => {
        if (err) {
            console.error('Error creating codes table:', err);
        } else {
            console.log('✅ Codes table ready');
        }
    });
    
    // Table for user claims (allow multiple claims per user)
    db.run(`CREATE TABLE IF NOT EXISTS user_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        code TEXT NOT NULL,
        claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating user_claims table:', err);
        } else {
            console.log('✅ User claims table ready');
        }
    });
});
// Auto-import codes from codes.txt on startup
async function autoImportCodes() {
    try {
        console.log('🔍 Checking if codes need to be imported...');
        
        // Check if we already have codes
        const existingCodes = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM codes', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });
        
        if (existingCodes > 0) {
            console.log(`✅ Database already has ${existingCodes} codes, skipping import`);
            return;
        }
        
        console.log('📖 Reading codes from codes.txt...');
        const fs = require('fs');
        
        if (!fs.existsSync('codes.txt')) {
            console.log('⚠️  codes.txt not found, skipping auto-import');
            return;
        }
        
        const fileContent = fs.readFileSync('codes.txt', 'utf8');
        const codes = fileContent
            .split('\n')
            .map(code => code.trim())
            .filter(code => code.length > 0 && !code.includes('!') && !code.includes('addcode'));
        
        if (codes.length === 0) {
            console.log('⚠️  No valid codes found in codes.txt');
            return;
        }
        
        console.log(`🚀 Importing ${codes.length} codes...`);
        
        // Bulk insert
        const placeholders = codes.map(() => '(?)').join(',');
        const sql = `INSERT INTO codes (code) VALUES ${placeholders}`;
        
        await new Promise((resolve, reject) => {
            db.run(sql, codes, function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
        
        console.log(`✅ Successfully imported ${codes.length} codes!`);
        
    } catch (error) {
        console.error('❌ Error importing codes:', error.message);
    }
}
// Configuration
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    CHANNEL_ID: process.env.CHANNEL_ID,
    MAX_CLAIMS_PER_USER: 1
};

// DEBUG: Let's see what we're getting
console.log('=== ENVIRONMENT DEBUG ===');
console.log('DISCORD_TOKEN exists:', !!process.env.DISCORD_TOKEN);
console.log('DISCORD_TOKEN length:', process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.length : 'undefined');
console.log('CHANNEL_ID:', process.env.CHANNEL_ID);
console.log('CONFIG.TOKEN:', CONFIG.TOKEN ? 'SET' : 'UNDEFINED');
console.log('========================');
client.once('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    
    // Auto-import codes if needed
    await autoImportCodes();
    
    // Set up the claim message when bot starts
    await setupClaimMessage();
});

async function setupClaimMessage() {
    try {
        const channel = await client.channels.fetch(CONFIG.CHANNEL_ID);
        
        if (!channel) {
            console.error('Channel not found!');
            return;
        }

        // Create embed
        const embed = new EmbedBuilder()
            .setTitle('🎁 Claim Your Code!')
            .setDescription('Click the button below to claim a unique code from our database.')
            .setColor(0x00AE86)
            .setFooter({ text: 'Each user can claim 1 code' });

        // Create button
        const button = new ButtonBuilder()
            .setCustomId('claim_code')
            .setLabel('Claim Code')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🎁');

        const row = new ActionRowBuilder().addComponents(button);

        // Send or update the message
        const messages = await channel.messages.fetch({ limit: 10 });
        const existingMessage = messages.find(msg => 
            msg.author.id === client.user.id && 
            msg.embeds[0]?.title === '🎁 Claim Your Code!'
        );

        if (existingMessage) {
            await existingMessage.edit({ embeds: [embed], components: [row] });
            console.log('Updated existing claim message');
        } else {
            await channel.send({ embeds: [embed], components: [row] });
            console.log('Posted new claim message');
        }

    } catch (error) {
        console.error('Error setting up claim message:', error);
    }
}

// Handle button interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'claim_code') {
        await handleCodeClaim(interaction);
    }
});

async function handleCodeClaim(interaction) {
    await interaction.deferReply({ flags: 64 }); // This replaces ephemeral: true

    try {
        const userId = interaction.user.id;

        // Check if user has already claimed maximum codes
        if (CONFIG.MAX_CLAIMS_PER_USER > 0) {
            const userClaims = await getUserClaimCount(userId);
            if (userClaims >= CONFIG.MAX_CLAIMS_PER_USER) {
                await interaction.editReply({
                    content: '❌ You have already claimed the maximum number of codes allowed.',
                    flags: 64 // This replaces ephemeral: true
                });
                return;
            }
        }

        // Get an available code
        const code = await claimCode(userId);

        if (!code) {
            await interaction.editReply({
                content: '❌ Sorry, no codes are currently available.',
                flags: 64 // This replaces ephemeral: true
            });
            return;
        }

        // Send success message with the code
        const successEmbed = new EmbedBuilder()
            .setTitle('✅ Code Claimed Successfully!')
            .setDescription(`Your code: \`${code}\``)
            .setColor(0x57F287)
            .addFields(
                { name: 'Instructions', value: 'Save this code somewhere safe. This message will only be shown once!' }
            )
            .setTimestamp();

        await interaction.editReply({
            embeds: [successEmbed],
            flags: 64 // This replaces ephemeral: true
        });

        // Update the main claim message
        await updateClaimMessage();

        console.log(`Code ${code} claimed by ${interaction.user.tag} (${userId})`);

    } catch (error) {
        console.error('Error handling code claim:', error);
        await interaction.editReply({
            content: '❌ An error occurred while claiming your code. Please try again later.',
            flags: 64 // This replaces ephemeral: true
        });
    }
}

// Database functions
function getUserClaimCount(userId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT COUNT(*) as count FROM user_claims WHERE user_id = ?',
            [userId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            }
        );
    });
}

function claimCode(userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            // Get first available code (exclude any that look like commands)
            db.get(
                'SELECT id, code FROM codes WHERE is_claimed = FALSE AND code NOT LIKE "!%" AND code NOT LIKE "%addcode%" LIMIT 1',
                (err, row) => {
                    if (err) {
                        db.run('ROLLBACK');
                        reject(err);
                        return;
                    }
                    
                    if (!row) {
                        db.run('ROLLBACK');
                        resolve(null);
                        return;
                    }
                    
                    const codeId = row.id;
                    const code = row.code;
                    
                    // Extra validation: make sure code looks valid
                    if (code.includes('!') || code.includes('addcode') || code.length < 3) {
                        console.log(`Skipping invalid code: ${code}`);
                        db.run('ROLLBACK');
                        resolve(null);
                        return;
                    }
                    
                    // Mark code as claimed
                    db.run(
                        'UPDATE codes SET is_claimed = TRUE, claimed_by = ?, claimed_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [userId, codeId],
                        (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                reject(err);
                                return;
                            }
                            
                            // Add to user_claims table
                            db.run(
                                'INSERT INTO user_claims (user_id, code) VALUES (?, ?)',
                                [userId, code],
                                (err) => {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        reject(err);
                                        return;
                                    }
                                    
                                    db.run('COMMIT');
                                    resolve(code);
                                }
                            );
                        }
                    );
                }
            );
        });
    });
}

function getCodeStats() {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT is_claimed, COUNT(*) as count FROM codes WHERE code NOT LIKE "!%" AND code NOT LIKE "%addcode%" GROUP BY is_claimed',
            (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                let available = 0;
                let claimed = 0;
                
                rows.forEach(row => {
                    if (row.is_claimed) {
                        claimed = row.count;
                    } else {
                        available = row.count;
                    }
                });
                
                resolve({ available, claimed });
            }
        );
    });
}

async function updateClaimMessage() {
    // This function now only needs to update if there are structural changes
    // Since we removed the live counter, no automatic updates needed
    console.log('Claim message update requested (no stats to update)');
}

// Admin commands (you can add these as slash commands later)
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    
    // Simple admin commands (replace with proper permission checks)
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        
        if (message.content === '!codestats') {
            const stats = await getCodeStats();
            await message.reply(`📊 **Code Statistics**\nAvailable: ${stats.available}\nClaimed: ${stats.claimed}`);
        }
        
        if (message.content === '!detailed') {
            const stats = await getCodeStats();
            const totalUsers = await getTotalUsers();
            const percentage = stats.claimed > 0 ? ((stats.claimed / (stats.available + stats.claimed)) * 100).toFixed(1) : 0;
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Detailed Code Statistics')
                .setColor(0x00AE86)
                .addFields(
                    { name: '📦 Total Codes', value: (stats.available + stats.claimed).toString(), inline: true },
                    { name: '✅ Available', value: stats.available.toString(), inline: true },
                    { name: '🎯 Claimed', value: stats.claimed.toString(), inline: true },
                    { name: '📈 Claimed %', value: `${percentage}%`, inline: true },
                    { name: '👥 Users with Codes', value: totalUsers.toString(), inline: true },
                    { name: '📅 Last Updated', value: new Date().toLocaleString(), inline: true }
                )
                .setTimestamp();
                
            await message.reply({ embeds: [embed] });
        }
        
        if (message.content === '!updateclaim') {
            await setupClaimMessage();
            await message.reply('✅ Updated claim message');
        }
    }
});

function getTotalUsers() {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT COUNT(DISTINCT user_id) as count FROM user_claims',
            (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            }
        );
    });
}

// Start the bot

client.login(CONFIG.TOKEN);



