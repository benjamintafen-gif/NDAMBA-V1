const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuid } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*path}', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== GAME ROOMS =====
const rooms = {}; // roomId -> { players, state, sockets }

const PION_COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63"];

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],   // { id, name, color, pos, money, skip, biz, done, parrain, helped, investPending }
    state: {
      cur: 0,
      phase: 'waiting', // waiting | idle | rolling | moving | card | bizPick | gameover
      diceVal: 1,
      log: [],
      started: false,
    },
    sockets: {},   // playerId -> ws
  };
}

function broadcast(room, msg) {
  Object.values(room.sockets).forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  });
}

function sendTo(room, playerId, msg) {
  const ws = room.sockets[playerId];
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomSnapshot(room) {
  return {
    type: 'state',
    players: room.players,
    state: room.state,
  };
}

// ===== GAME LOGIC (server-side authoritative) =====
const CASES = [
  {t:"depart",i:"🌿",n:"Village Départ"},
  {t:"kado",i:"💰",n:"Champ familial"},
  {t:"action",i:"😂",n:"Puits du village"},
  {t:"culture",i:"🧠",n:"Case du Chef"},
  {t:"chance",i:"⭐",n:"Bénédiction anciens"},
  {t:"kado",i:"💰",n:"Marché hebdo"},
  {t:"dette",i:"🤝",n:"Dette voisin"},
  {t:"action",i:"😂",n:"Tam-tam du soir"},
  {t:"culture",i:"🧠",n:"École du village"},
  {t:"kado",i:"💰",n:"Récolte cacao"},
  {t:"action",i:"😂",n:"Carrefour principal"},
  {t:"mal",i:"💀",n:"Pont en bois"},
  {t:"culture",i:"🧠",n:"Gare de brousse"},
  {t:"kado",i:"💰",n:"Camion transport"},
  {t:"check",i:"🛂",n:"Checkpoint Gendarmerie"},
  {t:"action",i:"😂",n:"Panne piste"},
  {t:"mal",i:"💀",n:"Rivière sans pont"},
  {t:"culture",i:"🧠",n:"Village voisin"},
  {t:"pari",i:"🎰",n:"Pari de brousse"},
  {t:"kado",i:"💰",n:"Auberge de passage"},
  {t:"action",i:"😂",n:"Entrée Bafoussam"},
  {t:"culture",i:"🧠",n:"Marché central"},
  {t:"mal",i:"💀",n:"Poste de police"},
  {t:"kado",i:"💰",n:"Cyber café"},
  {t:"action",i:"😂",n:"Gare routière"},
  {t:"culture",i:"🧠",n:"Préfecture région"},
  {t:"chance",i:"⭐",n:"Rencontre influente"},
  {t:"defi",i:"🏆",n:"Défi de quartier"},
  {t:"solida",i:"🎁",n:"Solidarité carrefour"},
  {t:"action",i:"😂",n:"Station Total"},
  {t:"culture",i:"🧠",n:"Route Nationale 1"},
  {t:"mal",i:"💀",n:"Péage route"},
  {t:"kado",i:"💰",n:"Bivouac routier"},
  {t:"check",i:"🛂",n:"Checkpoint routier"},
  {t:"action",i:"😂",n:"Agence voyage"},
  {t:"culture",i:"🧠",n:"Panneau Yaoundé 80km"},
  {t:"chance",i:"⭐",n:"Covoiturage chance"},
  {t:"dette",i:"🤝",n:"Dette de route"},
  {t:"kado",i:"💰",n:"Vendeur bord route"},
  {t:"action",i:"😂",n:"Repos sous manguier"},
  {t:"culture",i:"🧠",n:"Terminus bus"},
  {t:"mal",i:"💀",n:"Contrôle bagages"},
  {t:"action",i:"😂",n:"Carrefour Obili"},
  {t:"kado",i:"💰",n:"Marché Mfoundi"},
  {t:"chance",i:"⭐",n:"Taxi rapide centre"},
  {t:"culture",i:"🧠",n:"Rond-point Nlongkak"},
  {t:"pari",i:"🎰",n:"Pari de taxi"},
  {t:"action",i:"😂",n:"Avenue Kennedy"},
  {t:"defi",i:"🏆",n:"Défi Bastos"},
  {t:"check",i:"🛂",n:"Checkpoint centre ville"},
  {t:"action",i:"😂",n:"Quartier Mvog-Ada"},
  {t:"culture",i:"🧠",n:"Palais Congrès"},
  {t:"mal",i:"💀",n:"Panne ENEO"},
  {t:"kado",i:"💰",n:"Supermarché Score"},
  {t:"chance",i:"⭐",n:"Bonne rencontre"},
  {t:"action",i:"😂",n:"Quartier Etoudi"},
  {t:"culture",i:"🧠",n:"Université Yaoundé"},
  {t:"mal",i:"💀",n:"Contrôle fiscal"},
  {t:"kado",i:"💰",n:"Centre commercial"},
  {t:"chance",i:"⭐",n:"Entrée Phase 2"},
  // Phase 2
  {t:"bus",i:"🔍",n:"Cherche local"},
  {t:"bus",i:"📋",n:"Inscription RCCM"},
  {t:"fail",i:"🔥",n:"Premier invest."},
  {t:"bus",i:"👥",n:"Recrutement employé"},
  {t:"bus",i:"🚪",n:"Ouverture business"},
  {t:"bus",i:"🛒",n:"Première vente"},
  {t:"chance",i:"⭐",n:"Bouche à oreille"},
  {t:"bus",i:"🤝",n:"Partenariat local"},
  {t:"bus",i:"📢",n:"Publicité quartier"},
  {t:"parrain",i:"👑",n:"Visite du Parrain"},
  {t:"solida",i:"🎁",n:"Solidarité business"},
  {t:"invest",i:"📦",n:"Opportunité Invest."},
  {t:"fail",i:"⚔️",n:"Concurrence aggressive"},
  {t:"bus",i:"🏛️",n:"Contrôle fiscal"},
  {t:"mal",i:"💀",n:"Grève générale"},
  {t:"fail",i:"🔧",n:"Panne matériel"},
  {t:"bus",i:"📉",n:"Mauvaise saison"},
  {t:"chance",i:"⭐",n:"Rebond inattendu"},
  {t:"pari",i:"🎰",n:"Pari d'affaires"},
  {t:"parrain",i:"👑",n:"Coup de pouce Parrain"},
  {t:"bus",i:"🏪",n:"Deuxième boutique"},
  {t:"bus",i:"📜",n:"Contrat mairie"},
  {t:"bus",i:"✈️",n:"Export hors Cam."},
  {t:"defi",i:"🏆",n:"Défi Entrepreneur"},
  {t:"chance",i:"⭐",n:"Prix Entrepreneur"},
  {t:"bus",i:"📺",n:"Passage à la TV"},
  {t:"bus",i:"🏦",n:"Crédit bancaire"},
  {t:"invest",i:"📦",n:"Investissement final"},
  {t:"bus",i:"🎯",n:"Dernière ligne droite"},
  {t:"arrive",i:"🏆",n:"SUCCÈS NDAMBA!"},
];

const KADO = [
  {t:"Tu as bien travaillé ce mois — reçois 500 FCFA.",m:500},
  {t:"Ta tante d'Abidjan t'envoie de l'argent — reçois 1 000 FCFA.",m:1000},
  {t:"Tu trouves un billet au marché du Mfoundi — 500 FCFA.",m:500},
  {t:"Tu as oublié de saluer la belle-mère — paye 500 FCFA.",m:-500},
  {t:"Ton téléphone sonne en église — paye 500 FCFA à chaque joueur.",m:-500,all:500},
  {t:"Tu gagnes un pari de foot — reçois 800 FCFA.",m:800},
  {t:"Le taxi-man t'a rendu trop de monnaie — reçois 1 000 FCFA.",m:1000},
  {t:"Retard à la réunion de famille — paye 500 FCFA.",m:-500},
  {t:"Tu es parrain d'un baptême — reçois 1 500 FCFA.",m:1500},
  {t:"L'administration réclame un document — paye 1 000 FCFA et passe un tour.",m:-1000,skip:true},
  {t:"Entretien réussi ! — reçois 1 000 FCFA.",m:1000},
  {t:"Panne d'eau — paye 500 FCFA.",m:-500},
  {t:"Un ami te rembourse — reçois 1 000 FCFA.",m:1000},
  {t:"Tu aides ton voisin — reçois 500 FCFA de karma.",m:500},
  {t:"Prime surprise — reçois 1 000 FCFA.",m:1000},
];

const ACTION = [
  "Imite un vendeur ambulant de Mvan. 30 sec. Refus = recule 3 cases.",
  "Danse le bikutsi 20 secondes sans musique. Refus = recule 3 cases.",
  "Imite un gendarme à un checkpoint. Refus = recule 3 cases.",
  "Commande un repas en ewondo, bassa ou fulfulde. Refus = recule 3 cases.",
  "Imite ta maman qui gronde un enfant. Refus = recule 3 cases.",
  "Discours d'un politicien qui inaugure une route. 30 sec. Refus = recule 3.",
  "Chante le 1er couplet de l'hymne national. Refus = recule 3 cases.",
  "Marchande avec le joueur à ta droite. Refus = recule 3 cases.",
  "Cite 5 plats camerounais en 10 secondes. Refus = recule 3 cases.",
  "Fais 10 pompes. Moins de 5 = recule 2. Refus = recule 3 cases.",
  "Raconte une blague camerounaise. Personne rit = recule 2. Refus = recule 3.",
  "Imite quelqu'un qui cherche un taxi sous le soleil. Refus = recule 3.",
  "Explique le ndolé à un étranger imaginaire. Refus = recule 3.",
  "Démontre le salut traditionnel de ton ethnie. Refus = recule 3 cases.",
  "Compte jusqu'à 10 en langue locale. Refus = recule 3 cases.",
  "Appel fictif avec un client difficile. 20 sec. Refus = recule 3.",
  "Imite le son d'un bus Tradex à l'heure de pointe. Refus = recule 3.",
  "Présente la météo de Yaoundé comme à la TV. Refus = recule 3.",
  "Cite 3 quartiers de Yaoundé + 3 de Douala. Refus = recule 3.",
  "Chante du makossa ou du bikutsi. Refus = recule 3 cases.",
];

const CULTURE = [
  {q:"Capitale politique du Cameroun ?",a:"Yaoundé"},
  {q:"Monnaie du Cameroun ?",a:"Franc CFA (FCFA)"},
  {q:"1ère CAN gagnée par le Cameroun ?",a:"1984"},
  {q:"Cite 3 langues parlées au Cameroun.",a:"Ewondo, Bassa, Fulfulde, Bamiléké… (toute réponse valide)"},
  {q:"Plus haut sommet du Cameroun ?",a:"Mont Cameroun — 4 095 m"},
  {q:"'L'Afrique en miniature' — quel pays ?",a:"Le Cameroun"},
  {q:"1er président du Cameroun ?",a:"Ahmadou Ahidjo"},
  {q:"Cours d'eau principal à Yaoundé ?",a:"Le Mfoundi"},
  {q:"Combien de régions au Cameroun ?",a:"10 régions"},
  {q:"Plat emblématique du Cameroun ?",a:"Le Ndolé"},
  {q:"Musicien camerounais 'Sa Majesté' ?",a:"Manu Dibango"},
  {q:"Principal port du Cameroun ?",a:"Douala"},
  {q:"Complète: 'Quand la musique change…'",a:"…le pas de danse change aussi"},
  {q:"Année d'indépendance du Cameroun ?",a:"1960"},
  {q:"'Merci' en ewondo ?",a:"Akiba"},
];

const MAL = [
  {t:"Coupure ENEO — tu perds un tour.",skip:true},
  {t:"Embouteillage à Bastos — recule 4 cases.",move:-4},
  {t:"Contrôle de police — paye 1 000 FCFA OU recule 3 cases.",choice:true},
  {t:"Dispute avec le proprio — paye 1 500 FCFA.",m:-1500},
  {t:"Téléphone tombé dans l'eau — recule 3 + passe un tour.",move:-3,skip:true},
  {t:"Vol de sac — perds 1 500 FCFA.",m:-1500},
  {t:"Fausse promotion — paye 1 000 FCFA.",m:-1000},
  {t:"Maladie — paye 500 FCFA et recule 2.",m:-500,move:-2},
  {t:"Retard de salaire — passe un tour.",skip:true},
  {t:"Amende — paye 500 FCFA.",m:-500},
];

const BUS = [
  {t:"🍖 RESTO: Cuisinier parti — perds 1 000 FCFA.",m:-1000},
  {t:"📱 TÉLÉPHONIE: Stock épuisé — passe un tour.",skip:true},
  {t:"🚕 TAXI: Accident — paye 1 500 FCFA.",m:-1500},
  {t:"👗 FRIPERIE: Arrivage premium — reçois 800 FCFA.",m:800},
  {t:"🏗️ BTP: Chantier arrêté — recule 3 cases.",move:-3},
  {t:"🌾 AGRO: Bonne saison — reçois 1 000 FCFA.",m:1000},
  {t:"TOUS: Marché public — reçois 1 500 FCFA.",m:1500,tous:true},
  {t:"TOUS: Business viral TikTok — reçois 1 000 FCFA + avance 2 cases.",m:1000,move:2,tous:true},
  {t:"TOUS: Grève — passe un tour.",skip:true,tous:true},
  {t:"TOUS: Associé escroc — perds 2 000 FCFA.",m:-2000,tous:true},
  {t:"🍖 RESTO: Menu viral — reçois 600 FCFA.",m:600},
  {t:"🚕 TAXI: Passager VIP — reçois 1 000 FCFA.",m:1000},
  {t:"🏗️ BTP: Contrat villa — avance 2 cases + reçois 2 000 FCFA.",m:2000,move:2},
  {t:"TOUS: Inspection fiscale — paye 1 000 FCFA.",m:-1000,tous:true},
  {t:"TOUS: Employé vole la caisse — perds 1 500 FCFA.",m:-1500,tous:true},
  {t:"🌾 AGRO: Sécheresse — perds 2 000 FCFA.",m:-2000},
  {t:"TOUS: Partenariat international — reçois 1 200 FCFA.",m:1200,tous:true},
  {t:"📱 TÉLÉPHONIE: Nouveau modèle — reçois 800 FCFA.",m:800},
  {t:"TOUS: Si < 500 FCFA → faillite, retour case 61.",faillite:true,tous:true},
  {t:"TOUS: Prime annuelle — reçois 500 FCFA.",m:500,tous:true},
];

function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function fmt(n){ return n.toLocaleString('fr-FR') + ' FCFA'; }

function applyCard(room, card, choice) {
  const players = room.players;
  const cur = room.state.cur;
  const p = players[cur];

  if (card.type === 'kado') {
    const k = card.data;
    if (k.m) p.money += k.m;
    if (k.skip) p.skip = true;
    if (k.all) players.forEach((pl,i) => { if(i!==cur) pl.money += k.all; });
    addLog(room, `💰 ${p.name}: ${k.m>0?'+':''}${fmt(k.m||0)}`, p.color);
  }
  else if (card.type === 'action') {
    if (!choice) { p.pos = Math.max(0, p.pos-3); addLog(room, `😬 ${p.name} refuse — recule 3 cases !`, '#ff6060'); }
    else addLog(room, `👏 ${p.name} réussit l'action !`, '#5dba82');
  }
  else if (card.type === 'culture' || card.type === 'check') {
    if (choice) { p.pos = Math.min(89, p.pos+1); addLog(room, `✅ ${p.name} répond juste ! +1 case`, '#5dba82'); }
    else {
      if (card.type === 'check') { p.skip = true; addLog(room, `❌ ${p.name} bloqué 1 tour !`, '#e8706a'); }
      else { p.money -= 500; addLog(room, `❌ ${p.name} rate — paye 500 FCFA`, '#e8706a'); }
    }
  }
  else if (card.type === 'mal') {
    const m = card.data;
    if (m.choice) {
      if (choice === 'money') { p.money -= 1000; addLog(room, `💀 ${p.name} paye 1 000 FCFA`, '#e8706a'); }
      else { p.pos = Math.max(0, p.pos-3); addLog(room, `💀 ${p.name} recule 3 cases`, '#e8706a'); }
    } else {
      if (m.m) p.money += m.m;
      if (m.move) p.pos = Math.max(0, p.pos+m.move);
      if (m.skip) p.skip = true;
      addLog(room, `💀 ${p.name} subit la malchance`, '#e8706a');
    }
  }
  else if (card.type === 'bus') {
    const b = card.data;
    function applyBusTo(i) {
      const pl = players[i];
      if (b.m) pl.money += b.m;
      if (b.move && pl.pos>=60) pl.pos = Math.min(89, Math.max(60, pl.pos+b.move));
      if (b.skip) pl.skip = true;
      if (b.faillite && pl.money < 500) {
        pl.money = 1500; pl.pos = 60; pl.biz = null;
        addLog(room, `🔥 ${pl.name} en FAILLITE ! Retour case 61.`, '#ff8830');
      }
    }
    if (b.tous) { players.forEach((_,i) => { if(players[i].pos>=60 && !players[i].done) applyBusTo(i); }); }
    else { applyBusTo(cur); if(b.m) addLog(room, `🏢 ${p.name}: ${b.m>0?'+':''}${fmt(b.m)}`, b.m>0?'#5dba82':'#e8706a'); }
  }
  else if (card.type === 'pari') {
    const roll = Math.ceil(Math.random()*6);
    const win = roll%2===0;
    const mise = card.mise;
    if (win) { p.money += mise; addLog(room, `🎰 ${p.name} gagne le pari (dé ${roll}) ! +${fmt(mise)}`, '#cc88ff'); }
    else { p.money -= mise; addLog(room, `🎰 ${p.name} perd le pari (dé ${roll}) ! -${fmt(mise)}`, '#ff6060'); }
    card.pariResult = { roll, win, mise };
  }
  else if (card.type === 'defi') {
    const win = choice === 'challenger';
    const mise = card.mise;
    const targetIdx = card.targetIdx;
    if (win) {
      p.money += mise;
      players[targetIdx].money -= mise;
      addLog(room, `🏆 ${p.name} gagne le défi ! +${fmt(mise)}`, '#88ffcc');
    } else {
      p.money -= mise;
      players[targetIdx].money += mise;
      addLog(room, `🏆 ${players[targetIdx].name} gagne le défi ! +${fmt(mise)}`, '#88ffcc');
    }
  }
  else if (card.type === 'invest') {
    p.money -= card.mise;
    p.investPending = card.mise;
    addLog(room, `📦 ${p.name} investit ${fmt(card.mise)} — résultat au prochain tour !`, '#88ffff');
  }
  else if (card.type === 'investResult') {
    const roll = card.roll;
    const mise = card.mise;
    let retour;
    if(roll===1) retour=0;
    else if(roll===2) retour=Math.floor(mise*0.5);
    else if(roll===3) retour=mise;
    else if(roll===4) retour=Math.floor(mise*1.5);
    else retour=mise*2;
    p.money += retour;
    p.investPending = null;
    addLog(room, `📦 Investissement de ${p.name}: dé ${roll} → +${fmt(retour)}`, retour>=mise?'#88ffff':'#ff8830');
  }
  else if (card.type === 'solida') {
    const richest = players.reduce((a,b)=>a.money>b.money?a:b);
    const poorest = players.reduce((a,b)=>a.money<b.money?a:b);
    if (richest.id !== poorest.id) {
      richest.money -= 300; poorest.money += 300;
      addLog(room, `🎁 ${richest.name} donne 300 FCFA à ${poorest.name}`, '#ffffaa');
    }
  }
  else if (card.type === 'dette') {
    let ahead = null, aheadIdx = -1, minDiff = 999;
    players.forEach((pl,i) => {
      if(i===cur||pl.done) return;
      const diff = pl.pos - p.pos;
      if(diff>0 && diff<minDiff){minDiff=diff;ahead=pl;aheadIdx=i;}
    });
    if (ahead) {
      p.money -= 300; players[aheadIdx].money += 300;
      addLog(room, `🤝 ${p.name} paye 300 FCFA à ${ahead.name}`, '#ffaaaa');
    } else {
      p.money -= 300;
      addLog(room, `🤝 ${p.name} paye 300 FCFA à la banque`, '#ffaaaa');
    }
  }
  else if (card.type === 'parrainGive') {
    const parrain = players.find(x=>x.parrain);
    const target = players[card.targetIdx];
    if (card.action === 'give') {
      parrain.money -= 500; target.money += 500;
      addLog(room, `👑 ${parrain.name} donne 500 FCFA à ${target.name}`, '#ffe050');
    } else {
      parrain.money += 500; target.money -= 500;
      addLog(room, `👑 ${parrain.name} retire 500 FCFA à ${target.name}`, '#ff8830');
    }
  }
}

function addLog(room, msg, col='#C8A96E') {
  room.state.log.unshift({ msg, col, t: Date.now() });
  if (room.state.log.length > 30) room.state.log.pop();
}

function checkWin(room) {
  const cur = room.state.cur;
  const p = room.players[cur];
  if (p.pos < 89) return false;

  const hasParrain = room.players.some(x=>x.parrain);
  if (p.money < 500) {
    p.pos = 60; p.money = Math.max(p.money, 500);
    addLog(room, `😬 ${p.name} arrive en case 90 mais trop pauvre — retour case 61 !`, '#ff8830');
    return false;
  }
  if (!hasParrain && p.money < 2000) {
    addLog(room, `⚠️ ${p.name} arrive mais il faut 2 000 FCFA pour être Parrain ! Continue...`, '#ff8830');
    return 'continue';
  }
  if (!hasParrain) {
    p.parrain = true; p.done = true; p.pos = 89;
    addLog(room, `👑 ${p.name} devient le PARRAIN avec ${fmt(p.money)} !`, '#ffe050');
  } else {
    p.done = true; p.pos = 89;
    addLog(room, `🏆 ${p.name} réussit avec ${fmt(p.money)} !`, '#5dba82');
  }
  if (room.players.every(x=>x.done)) { room.state.phase = 'gameover'; return 'gameover'; }
  return true;
}

function nextTurn(room) {
  const n = room.players.length;
  let next = (room.state.cur + 1) % n;
  let loops = 0;
  while (room.players[next].done && loops < n) { next=(next+1)%n; loops++; }
  if (loops >= n) { room.state.phase = 'gameover'; return; }
  room.state.cur = next;
  const p = room.players[next];
  if (p.skip) {
    p.skip = false;
    addLog(room, `⏭️ ${p.name} passe son tour.`, '#888');
    nextTurn(room); return;
  }
  room.state.phase = 'idle';
  addLog(room, `🎯 Tour de ${p.name}`, p.color);
}

// ===== WEBSOCKET HANDLER =====
wss.on('connection', ws => {
  let myRoomId = null;
  let myPlayerId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // CREATE ROOM
    if (msg.type === 'create') {
      const roomId = Math.random().toString(36).substr(2,6).toUpperCase();
      rooms[roomId] = createRoom(roomId);
      myRoomId = roomId;
      myPlayerId = uuid();
      const player = {
        id: myPlayerId, name: msg.name,
        color: PION_COLORS[0], pos: 0, money: 3000,
        skip: false, biz: null, done: false, parrain: false,
        helped: [], investPending: null, isHost: true
      };
      rooms[roomId].players.push(player);
      rooms[roomId].sockets[myPlayerId] = ws;
      ws.send(JSON.stringify({ type:'joined', roomId, playerId: myPlayerId, playerIdx: 0 }));
      broadcast(rooms[roomId], roomSnapshot(rooms[roomId]));
      return;
    }

    // JOIN ROOM
    if (msg.type === 'join') {
      const room = rooms[msg.roomId];
      if (!room) { ws.send(JSON.stringify({type:'error',msg:'Salle introuvable'})); return; }
      if (room.state.started) { ws.send(JSON.stringify({type:'error',msg:'Partie déjà commencée'})); return; }
      if (room.players.length >= 6) { ws.send(JSON.stringify({type:'error',msg:'Salle complète'})); return; }
      myRoomId = msg.roomId; myPlayerId = uuid();
      const idx = room.players.length;
      const player = {
        id: myPlayerId, name: msg.name,
        color: PION_COLORS[idx], pos: 0, money: 3000,
        skip: false, biz: null, done: false, parrain: false,
        helped: [], investPending: null, isHost: false
      };
      room.players.push(player);
      room.sockets[myPlayerId] = ws;
      ws.send(JSON.stringify({ type:'joined', roomId: myRoomId, playerId: myPlayerId, playerIdx: idx }));
      broadcast(room, roomSnapshot(room));
      return;
    }

    const room = myRoomId ? rooms[myRoomId] : null;
    if (!room) return;

    // START GAME
    if (msg.type === 'start') {
      if (room.players.length < 2) { ws.send(JSON.stringify({type:'error',msg:'Il faut au moins 2 joueurs'})); return; }
      room.state.started = true;
      room.state.phase = 'idle';
      addLog(room, `🎉 La partie commence ! Tour de ${room.players[0].name}`, '#D4A017');
      broadcast(room, roomSnapshot(room));
      broadcast(room, { type:'toast', name: room.players[0].name, color: room.players[0].color });
      return;
    }

    // ROLL DICE
    if (msg.type === 'roll') {
      const cur = room.state.cur;
      if (room.players[cur].id !== myPlayerId) return;
      if (room.state.phase !== 'idle') return;

      // Check pending investment
      const p = room.players[cur];
      if (p.investPending) {
        const roll = Math.ceil(Math.random()*5);
        const mise = p.investPending;
        const card = { type:'investResult', roll, mise };
        applyCard(room, card, null);
        room.state.phase = 'card';
        room.state.pendingCard = { type:'investResult', roll, mise, text: getInvestText(roll,mise) };
        broadcast(room, roomSnapshot(room));
        broadcast(room, { type:'showCard', card: room.state.pendingCard });
        return;
      }

      const val = Math.ceil(Math.random()*5);
      room.state.diceVal = val;
      room.state.phase = 'moving';
      broadcast(room, { type:'diceResult', val, playerId: myPlayerId });

      // Move
      const oldPos = p.pos;
      const newPos = Math.min(89, p.pos + val);
      p.pos = newPos;
      addLog(room, `🎲 ${p.name} fait ${val} → case ${newPos+1}: ${CASES[newPos].n}`, p.color);

      // Check phase 2
      if (newPos >= 60 && !p.biz && !p.parrain) {
        room.state.phase = 'bizPick';
        broadcast(room, roomSnapshot(room));
        broadcast(room, { type:'bizPick', playerId: myPlayerId });
        return;
      }

      // Trigger case
      triggerCase(room, newPos);
      return;
    }

    // PICK BUSINESS
    if (msg.type === 'pickBiz') {
      const cur = room.state.cur;
      if (room.players[cur].id !== myPlayerId) return;
      room.players[cur].biz = msg.biz;
      addLog(room, `🏢 ${room.players[cur].name} lance: ${msg.biz.ico} ${msg.biz.name}`, msg.biz.bc);
      triggerCase(room, room.players[cur].pos);
      return;
    }

    // CARD RESPONSE
    if (msg.type === 'cardResponse') {
      const cur = room.state.cur;
      // Allow current player or parrain for parrain actions
      const card = room.state.pendingCard;
      if (!card) return;

      applyCard(room, card, msg.choice);

      // Handle win check
      if (room.players[cur].pos >= 89) {
        const winResult = checkWin(room);
        if (winResult === 'gameover') { broadcast(room, roomSnapshot(room)); broadcast(room, {type:'gameover'}); return; }
        if (winResult === 'continue') {
          room.state.phase = 'card';
          room.state.pendingCard = { type:'bus', data: rand(BUS), text: '' };
          room.state.pendingCard.text = room.state.pendingCard.data.t;
          broadcast(room, roomSnapshot(room));
          broadcast(room, { type:'showCard', card: room.state.pendingCard });
          return;
        }
      }

      room.state.pendingCard = null;
      doNextTurn(room);
      return;
    }

    // PARI CHOOSE MISE
    if (msg.type === 'pariMise') {
      const cur = room.state.cur;
      if (room.players[cur].id !== myPlayerId) return;
      const card = { type:'pari', mise: msg.mise };
      applyCard(room, card, null);
      room.state.pendingCard = null;
      broadcast(room, { type:'pariResult', result: card.pariResult, name: room.players[cur].name });
      setTimeout(()=>{ doNextTurn(room); broadcast(room, roomSnapshot(room)); }, 2000);
      broadcast(room, roomSnapshot(room));
      return;
    }

    // PARI REFUSE
    if (msg.type === 'pariRefuse') {
      doNextTurn(room); broadcast(room, roomSnapshot(room)); return;
    }

    // DEFI TARGET
    if (msg.type === 'defiTarget') {
      room.state.pendingCard.targetIdx = msg.targetIdx;
      room.state.pendingCard.step = 'mise';
      broadcast(room, roomSnapshot(room));
      broadcast(room, { type:'defiStep', step:'mise', challengerName: room.players[room.state.cur].name, targetName: room.players[msg.targetIdx].name });
      return;
    }

    // DEFI MISE
    if (msg.type === 'defiMise') {
      room.state.pendingCard.mise = msg.mise;
      room.state.pendingCard.step = 'vote';
      broadcast(room, roomSnapshot(room));
      broadcast(room, { type:'defiStep', step:'vote', mise: msg.mise,
        challengerName: room.players[room.state.cur].name,
        targetName: room.players[room.state.pendingCard.targetIdx].name });
      return;
    }

    // DEFI REFUSE (penalty)
    if (msg.type === 'defiRefuse') {
      const cur = room.state.cur;
      room.players[cur].money -= 3000;
      addLog(room, `😤 ${room.players[cur].name} refuse le défi — paye 3 000 FCFA !`, '#ff6060');
      room.state.pendingCard = null;
      doNextTurn(room); broadcast(room, roomSnapshot(room)); return;
    }

    // INVEST MISE
    if (msg.type === 'investMise') {
      const cur = room.state.cur;
      if (room.players[cur].id !== myPlayerId) return;
      const card = { type:'invest', mise: msg.mise };
      applyCard(room, card, null);
      room.state.pendingCard = null;
      doNextTurn(room); broadcast(room, roomSnapshot(room)); return;
    }

    // PARRAIN ACTION
    if (msg.type === 'parrainAction') {
      const parrain = room.players.find(x=>x.parrain);
      if (!parrain || parrain.id !== myPlayerId) return;
      applyCard(room, { type:'parrainGive', targetIdx: msg.targetIdx, action: msg.action }, null);
      broadcast(room, roomSnapshot(room)); return;
    }

    // NEXT TURN (manual)
    if (msg.type === 'nextTurn') {
      const cur = room.state.cur;
      if (room.players[cur].id !== myPlayerId && !room.players.find(x=>x.parrain&&x.id===myPlayerId)) return;
      doNextTurn(room); broadcast(room, roomSnapshot(room)); return;
    }
  });

  ws.on('close', () => {
    if (myRoomId && rooms[myRoomId]) {
      delete rooms[myRoomId].sockets[myPlayerId];
      const room = rooms[myRoomId];
      const p = room.players.find(x=>x.id===myPlayerId);
      if (p) addLog(room, `⚠️ ${p.name} s'est déconnecté`, '#888');
      broadcast(room, roomSnapshot(room));
      broadcast(room, { type:'playerLeft', name: p?.name });
    }
  });
});

function getInvestText(roll, mise) {
  if(roll===1) return `Dé ${roll} — Échec total. Tu perds tout.`;
  if(roll===2) return `Dé ${roll} — Échec partiel. Tu récupères la moitié.`;
  if(roll===3) return `Dé ${roll} — Neutre. Tu récupères ta mise.`;
  if(roll===4) return `Dé ${roll} — Bon retour ! ×1,5.`;
  return `Dé ${roll} — JACKPOT ! Tu doubles !`;
}

function triggerCase(room, pos) {
  const cas = CASES[pos];
  const cur = room.state.cur;
  const p = room.players[cur];
  let card = null;

  if (cas.t === 'chance') {
    const bonusTo = Math.min(89, pos+2);
    p.pos = bonusTo;
    addLog(room, `⭐ ${p.name} avance de 2 cases bonus → case ${bonusTo+1}: ${CASES[bonusTo].n}`, '#a0a0ff');
    if (bonusTo >= 89) { checkWin(room); }
    else { triggerCase(room, bonusTo); }
    broadcast(room, roomSnapshot(room));
    return;
  }

  if (cas.t === 'kado') { const k = rand(KADO); card = { type:'kado', data:k, text:k.t }; }
  else if (cas.t === 'action') { const a = rand(ACTION); card = { type:'action', text:a }; }
  else if (cas.t === 'culture') { const cu = rand(CULTURE); card = { type:'culture', q:cu.q, a:cu.a, text:cu.q }; }
  else if (cas.t === 'check') { const ch = rand(CULTURE); card = { type:'check', q:ch.q, a:ch.a, text:ch.q }; }
  else if (cas.t === 'mal') { const m = rand(MAL); card = { type:'mal', data:m, text:m.t, choice:m.choice }; }
  else if (cas.t === 'bus'||cas.t==='fail'||cas.t==='parrain') { const b = rand(BUS); card = { type:'bus', data:b, text:b.t }; }
  else if (cas.t === 'pari') { card = { type:'pari', text:'Lance le dé ! Pair → tu doubles. Impair → tu perds.', step:'mise' }; }
  else if (cas.t === 'defi') { card = { type:'defi', text:'Défie un joueur ! Choisissez la mise. Le groupe juge.', step:'target' }; }
  else if (cas.t === 'invest') { card = { type:'invest', text:'Investis maintenant. Au prochain tour tu lances le dé pour ton retour.', step:'mise' }; }
  else if (cas.t === 'solida') { applyCard(room, {type:'solida'}, null); doNextTurn(room); broadcast(room, roomSnapshot(room)); return; }
  else if (cas.t === 'dette') { applyCard(room, {type:'dette'}, null); doNextTurn(room); broadcast(room, roomSnapshot(room)); return; }

  if (card) {
    room.state.phase = 'card';
    room.state.pendingCard = card;
    broadcast(room, roomSnapshot(room));
    broadcast(room, { type:'showCard', card });
  } else {
    doNextTurn(room);
    broadcast(room, roomSnapshot(room));
  }
}

function doNextTurn(room) {
  room.state.pendingCard = null;
  nextTurn(room);
  broadcast(room, roomSnapshot(room));
  const cur = room.state.cur;
  const p = room.players[cur];
  broadcast(room, { type:'toast', name: p.name, color: p.color });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NDAMBA server running on port ${PORT}`));
