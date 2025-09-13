import { Client, IntentsBitField, Partials, EmbedBuilder, PermissionsBitField } from 'discord.js';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

/* ================== CONFIG ================== */
const PREFIX = '!';
const ADMINS = ['644073207351214119','1218858608494702']; // add your admin IDs

const LOG_CHANNEL_ID = '1411401732377809039';

const CHAT_REWARD = 2;
const CHAT_COOLDOWN_MS = 60*1000;
const WORK_COOLDOWN_MS = 60*60*1000;
const GAMBLE_COOLDOWN_MS = 45*1000;
const MYSTERY_COST = 300;

/* ================== CLIENT ================== */
const client = new Client({
  intents:[
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMembers
  ],
  partials:[Partials.Channel]
});

/* ================== DATABASE ================== */
const db = new Database('data.db');

db.prepare(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  coins REAL DEFAULT 0,
  bank REAL DEFAULT 0,
  boostMultiplier REAL DEFAULT 1
)`).run();

/* ================== UTILS ================== */
const chatCooldowns = new Map();
const workCooldowns = new Map();
const gambleCooldowns = new Map();
const activeBoosts = new Map();

function getBalance(userId){
  const row = db.prepare('SELECT coins FROM users WHERE userId=?').get(userId);
  return row ? row.coins : 0;
}

function setBalance(userId,amount){
  if(amount<0) amount=0;
  db.prepare(`INSERT INTO users(userId,coins) VALUES(?,?) 
    ON CONFLICT(userId) DO UPDATE SET coins=excluded.coins`).run(userId,amount);
  return amount;
}

function addCoins(userId,amount){
  const row = db.prepare('SELECT coins, boostMultiplier FROM users WHERE userId=?').get(userId) || {coins:0, boostMultiplier:1};
  let multiplier = row.boostMultiplier || 1;
  const boost = activeBoosts.get(userId);
  if(boost && boost.expires > Date.now()) multiplier *= boost.multiplier;
  let delta = amount*multiplier;
  return setBalance(userId,row.coins+delta);
}

function getBank(userId){ 
  const row=db.prepare('SELECT bank FROM users WHERE userId=?').get(userId); 
  return row?row.bank:0;
}
function addBank(userId,amount){ 
  const row=db.prepare('SELECT bank FROM users WHERE userId=?').get(userId)||{bank:0}; 
  const newAmount=Math.max(row.bank+amount,0); 
  db.prepare('INSERT INTO users(userId,bank) VALUES(?,?) ON CONFLICT(userId) DO UPDATE SET bank=excluded.bank').run(userId,newAmount); 
  return newAmount;
}

async function logEvent(guild,text){
  try{
    const ch=guild?.channels?.cache?.get(LOG_CHANNEL_ID);
    if(ch) await ch.send(text);
  }catch{}
}

/* ================== SHOP ================== */
const shopItems = {
  omino:{id:'omino',name:'Omino Diffusion',price:800, stock:10},
  ripple:{id:'ripple',name:'Ripple',price:500, stock:15},
  cc3:{id:'cc3',name:'3 CC Pack',price:300, stock:10},
  cc5:{id:'cc5',name:'5 CC Pack',price:450, stock:5},
  cc10:{id:'cc10',name:'10 CC Pack',price:700, stock:3},
  helper:{id:'helper',name:'Helper Role',price:1000, stock:3},
  zoom:{id:'zoom',name:'Zoom Pack',price:400, stock:5},
  twixtor:{id:'twixtor',name:'Twixtor Pack',price:500, stock:5}
};

function getAllFilesRecursively(startDir){
  const out=[];
  (function walk(dir){
    for(const name of fs.readdirSync(dir)){
      const full=path.join(dir,name);
      if(fs.lstatSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  })(startDir);
  return out;
}

function resolveItemFolder(itemId){
  const base='./shop_items';
  const p=path.join(base,itemId);
  if(fs.existsSync(p)) return p;
  return null;
}

async function deliverItem(user,item,channel){
  if(item.stock<=0){ channel.send(`❌ ${item.name} is out of stock.`); return; }
  const folder=resolveItemFolder(item.id);
  if(!folder){ channel.send('❌ Item folder not found.'); return; }
  const files=getAllFilesRecursively(folder).filter(f=>f.endsWith('.ffx'));
  if(files.length===0){ channel.send('❌ No FFX files to deliver.'); return; }
  for(const f of files){
    try{ await user.send({files:[f]}); }catch{}
  }
  channel.send(`✅ Delivered **${item.name}** to ${user.tag}`);
  logEvent(channel.guild,`${user.tag} purchased ${item.name} for ${item.price} coins.`);
  item.stock--; // reduce stock
}

/* ================== CLIENT READY ================== */
client.once('ready',async()=>{
  console.log(`Logged in as ${client.user.tag}`);
});

/* ================== MESSAGE HANDLER ================== */
client.on('messageCreate',async message=>{
  if(message.author.bot) return;
  const now=Date.now();
  const userId=message.author.id;
  const admin=ADMINS.includes(userId);

  // Chat coins
  const last=chatCooldowns.get(userId)||0;
  if(now-last>=CHAT_COOLDOWN_MS){
    const bal=addCoins(userId,CHAT_REWARD);
    chatCooldowns.set(userId,now);
    logEvent(message.guild,`💬 ${message.author.tag} earned ${CHAT_REWARD} coins (Balance: ${bal.toFixed(2)})`);
  }

  if(!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  const target = message.mentions.users.first();
  const amount = parseInt(args[1]);

  /* ================== ECONOMY COMMANDS ================== */
  if(cmd==='balance'||cmd==='bal'){
    const t=target||message.author;
    const bal=getBalance(t.id).toFixed(2);
    const bank=getBank(t.id).toFixed(2);
    return message.reply(`💰 ${t.tag} has ${bal} coins, Bank: ${bank}`);
  }

  if(cmd==='balall'){
    const rows=db.prepare('SELECT userId, coins, bank FROM users').all();
    let output='📊 **All balances:**\n';
    for(const r of rows){
      output+=`<@${r.userId}>: ${r.coins.toFixed(2)} coins, Bank: ${r.bank.toFixed(2)}\n`;
      if(output.length>1800){ await message.channel.send(output); output=''; }
    }
    if(output.length>0) await message.channel.send(output);
    return;
  }

  if(cmd==='pay'){
    if(!target||isNaN(amount)) return message.reply('❌ Usage: !pay @user <amount>');
    if(getBalance(userId)<amount) return message.reply('❌ Not enough coins.');
    addCoins(userId,-amount); addCoins(target.id,amount);
    logEvent(message.guild,`💰 ${message.author.tag} paid ${amount} coins to ${target.tag}`);
    return message.reply(`✅ Paid ${amount} coins to ${target.tag}`);
  }

  if(cmd==='deposit'){
    const amt=parseInt(args[0]); 
    if(isNaN(amt)||amt<1) return message.reply('❌ Usage: !deposit <amount>');
    if(getBalance(userId)<amt) return message.reply('❌ Not enough coins.');
    addCoins(userId,-amt); addBank(userId,amt);
    logEvent(message.guild,`💰 ${message.author.tag} deposited ${amt} coins to bank`);
    return message.reply(`✅ Deposited ${amt} coins to your bank`);
  }

  if(cmd==='withdraw'){
    const amt=parseInt(args[0]); 
    if(isNaN(amt)||amt<1) return message.reply('❌ Usage: !withdraw <amount>');
    if(getBank(userId)<amt) return message.reply('❌ Not enough in bank.');
    addBank(userId,-amt); addCoins(userId,amt);
    logEvent(message.guild,`💰 ${message.author.tag} withdrew ${amt} coins from bank`);
    return message.reply(`✅ Withdrew ${amt} coins from your bank`);
  }

  if(cmd==='gamble'){
    const last=gambleCooldowns.get(userId)||0;
    if(now-last<GAMBLE_COOLDOWN_MS) return message.reply(`❌ Wait ${Math.ceil((GAMBLE_COOLDOWN_MS-(now-last))/1000)}s before gambling.`);
    const bet=parseInt(args[0]); 
    if(isNaN(bet)||bet<50||bet>500) return message.reply('❌ Bet must be 50-500 coins.');
    if(getBalance(userId)<bet) return message.reply('❌ Not enough coins.');
    const roll=Math.random()*100; let text='';
    if(roll<20){ 
      const win=bet*2; 
      addCoins(userId,win); 
      text=`🎉 You won ${win} coins!`; 
    }
    else{ 
      addCoins(userId,-bet); 
      text=`💀 You lost ${bet} coins.`; 
    }
    gambleCooldowns.set(userId,now);
    return message.reply(text);
  }

  if(cmd==='mystery'){
    if(getBalance(userId)<MYSTERY_COST) return message.reply('❌ Not enough coins.');
    addCoins(userId,-MYSTERY_COST);
    const roll=Math.random()*100; let reward='';
    if(roll<5){ 
      const keys=Object.keys(shopItems); 
      const chosen=shopItems[keys[Math.floor(Math.random()*keys.length)]]; 
      await deliverItem(message.author,chosen,message.channel); 
      reward=`🎁 Mystery gave ${chosen.name}`; 
    }
    else{ 
      const coins=Math.floor(Math.random()*201)+100; 
      addCoins(userId,coins); 
      reward=`💰 Mystery gave ${coins} coins.`; 
    }
    return message.reply(reward);
  }

  if(cmd==='buy'){
    if(!args[0]) return message.reply('❌ Provide an item ID.');
    const item=shopItems[args[0].toLowerCase()]; 
    if(!item) return message.reply('❌ Item not found.');
    if(getBalance(userId)<item.price) return message.reply('❌ Not enough coins.');
    addCoins(userId,-item.price);
    await deliverItem(message.author,item,message.channel);
    return;
  }

  if(cmd==='work'){
    const last=workCooldowns.get(userId)||0;
    if(now-last<WORK_COOLDOWN_MS) return message.reply('❌ Work cooldown 1 hour.');
    const earned=Math.floor(Math.random()*50)+50;
    addCoins(userId,earned);
    workCooldowns.set(userId,now);
    return message.reply(`💼 You worked and earned ${earned} coins.`);
  }

  if(cmd==='help'){
    const embed=new EmbedBuilder()
      .setTitle('📖 Commands')
      .setDescription(
        `💰 Economy:
!balance [@user]
!deposit <amount>
!withdraw <amount>
!pay @user <amount>
!gamble <amount>
!mystery
!buy <item>
!balall
!work

⚙️ Admin:
!give @user <amount>
!giveall <amount>
!remove @user <amount>
!removeall <amount>
!send #channel <message>
!kick @user <reason>
!ban @user <reason>
!timeout @user <minutes> <reason>
!clear <1-100>`
      ).setColor(0x00ff00);
    return message.channel.send({embeds:[embed]});
  }

  /* ================== ADMIN COMMANDS ================== */
  if(admin){
    if(cmd==='give'){ 
      if(!target||isNaN(amount)) return message.reply('❌ Usage: !give @user <amount>'); 
      addCoins(target.id,amount); 
      return message.reply(`✅ Gave ${amount} coins to ${target.tag}`);
    }
    if(cmd==='giveall'){ 
      if(isNaN(args[0])) return message.reply('❌ Usage: !giveall <amount>'); 
      const amt=parseInt(args[0]); 
      const rows=db.prepare('SELECT userId FROM users').all(); 
      for(const r of rows) addCoins(r.userId,amt); 
      return message.reply(`✅ Gave ${amt} coins to everyone`);
    }
    if(cmd==='remove'){ 
      if(!target||isNaN(amount)) return message.reply('❌ Usage: !remove @user <amount>'); 
      addCoins(target.id,-amount); 
      return message.reply(`✅ Removed ${amount} coins from ${target.tag}`);
    }
    if(cmd==='removeall'){ 
      if(isNaN(args[0])) return message.reply('❌ Usage: !removeall <amount>'); 
      const amt=parseInt(args[0]); 
      const rows=db.prepare('SELECT userId FROM users').all(); 
      for(const r of rows) addCoins(r.userId,-amt); 
      return message.reply(`✅ Removed ${amt} coins from everyone`);
    }
    if(cmd==='send'){ 
      if(!args[0]) return message.reply('❌ Usage: !send #channel <message>'); 
      const ch=message.mentions.channels.first(); 
      if(!ch) return message.reply('❌ Invalid channel.'); 
      const msg=args.slice(1).join(' '); 
      await ch.send(msg); 
      return message.reply('✅ Message sent.');
    }
    if(cmd==='kick'){ 
      if(!target) return message.reply('❌ Usage: !kick @user <reason>'); 
      const reason=args.join(' ')||'No reason'; 
      const member = message.guild.members.cache.get(target.id); 
      if(!member) return message.reply('❌ User not in guild'); 
      if(!message.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ I cannot kick.'); 
      await member.kick(reason); 
      return message.reply(`✅ Kicked ${target.tag}`);
    }
    if(cmd==='ban'){ 
      if(!target) return message.reply('❌ Usage: !ban @user <reason>'); 
      const reason=args.join(' ')||'No reason'; 
      const member = message.guild.members.cache.get(target.id); 
      if(!member) return message.reply('❌ User not in guild'); 
      if(!message.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ I cannot ban.'); 
      await member.ban({reason}); 
      return message.reply(`✅ Banned ${target.tag}`);
    }
    if(cmd==='timeout'){ 
      if(!target||isNaN(args[1])) return message.reply('❌ Usage: !timeout @user <minutes> <reason>'); 
      const minutes=parseInt(args[1]); 
      const reason=args.slice(2).join(' ')||'No reason'; 
      const member = message.guild.members.cache.get(target.id); 
      if(!member) return message.reply('❌ User not in guild'); 
      await member.timeout(minutes*60000,reason); 
      return message.reply(`✅ Timed out ${target.tag} for ${minutes} minutes`);
    }
    if(cmd==='clear'){ 
      if(isNaN(args[0])) return message.reply('❌ Usage: !clear <1-100>'); 
      const num=Math.min(100,parseInt(args[0])); 
      await message.channel.bulkDelete(num); 
      return message.reply(`✅ Cleared ${num} messages`);
    }
  }
});

/* ================== LOGIN ================== */
client.login(process.env.TOKEN);



