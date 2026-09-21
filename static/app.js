let token = null;
let identifiant = null;
let websocket = null;
let modeActuel = "classique";

function afficherEcran(id) {
  document.querySelectorAll(".ecran").forEach(e => e.classList.add("cache"));
  document.getElementById(id).classList.remove("cache");
}

async function inscription() {
  const id = document.getElementById("champ-identifiant").value.trim();
  const mdp = document.getElementById("champ-mot-de-passe").value;
  const reponse = await fetch("/api/inscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant: id, mot_de_passe: mdp }),
  });
  const donnees = await reponse.json();
  if (!reponse.ok) {
    document.getElementById("message-auth").innerText = donnees.detail;
    return;
  }
  connecterSession(donnees.token, donnees.identifiant);
}

async function connexion() {
  const id = document.getElementById("champ-identifiant").value.trim();
  const mdp = document.getElementById("champ-mot-de-passe").value;
  const reponse = await fetch("/api/connexion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant: id, mot_de_passe: mdp }),
  });
  const donnees = await reponse.json();
  if (!reponse.ok) {
    document.getElementById("message-auth").innerText = donnees.detail;
    return;
  }
  connecterSession(donnees.token, donnees.identifiant);
}

function connecterSession(jeton, id) {
  token = jeton;
  identifiant = id;
  document.getElementById("nom-joueur").innerText = identifiant;
  afficherEcran("ecran-salle");
}

async function creerSalle() {
  const reponse = await fetch(`/api/salle/creer?token=${encodeURIComponent(token)}`, { method: "POST" });
  const donnees = await reponse.json();
  rejoindreSocketSalle(donnees.code_salle);
}

function rejoindreSalle() {
  const code = document.getElementById("champ-code-salle").value.trim().toUpperCase();
  if (!code) return;
  rejoindreSocketSalle(code);
}

function rejoindreSocketSalle(code) {
  const protocole = window.location.protocol === "https:" ? "wss" : "ws";
  websocket = new WebSocket(`${protocole}://${window.location.host}/ws/${code}?token=${encodeURIComponent(token)}`);

  websocket.onopen = () => {
    afficherEcran("ecran-jeu");
    document.getElementById("code-salle-affiche").innerText = code;
    construireClavier();
  };

  websocket.onmessage = (evenement) => {
    const message = JSON.parse(evenement.data);
    gererMessage(message);
  };

  websocket.onclose = () => {
    document.getElementById("message-salle").innerText =
      "Connexion fermee (salle pleine, code invalide, ou session expiree).";
  };
}

function gererMessage(message) {
  switch (message.type) {
    case "etat_jeu":
      mettreAJourEtat(message);
      break;
    case "erreur":
      document.getElementById("resultat").innerText = message.message;
      break;
    case "debut_vote":
      afficherZoneVote();
      break;
    case "vote_recu":
      document.getElementById("statut-vote").innerText =
        `${message.nombre_votes}/${message.total_joueurs} votes recus...`;
      break;
    case "resultat_vote":
      afficherResultatVote(message);
      break;
    case "fin_partie":
      document.getElementById("resultat").innerText = message.gagne
        ? `Gagne ! Le mot etait "${message.mot}". Score : ${message.score} points.`
        : `Perdu ! Le mot etait "${message.mot}".`;
      break;
  }
}

function construireClavier() {
  const clavier = document.getElementById("clavier");
  clavier.innerHTML = "";
  "abcdefghijklmnopqrstuvwxyz".split("").forEach(lettre => {
    const bouton = document.createElement("button");
    bouton.innerText = lettre.toUpperCase();
    bouton.id = `lettre-${lettre}`;
    bouton.onclick = () => proposerLettre(lettre);
    clavier.appendChild(bouton);
  });
}

function demarrerPartie() {
  modeActuel = document.getElementById("select-mode").value;
  const categorie = document.getElementById("select-categorie").value;
  const difficulte = document.getElementById("select-difficulte").value;
  document.getElementById("resultat").innerText = "";
  document.getElementById("zone-vote").classList.add("cache");
  websocket.send(JSON.stringify({ type: "demarrer", mode: modeActuel, categorie, difficulte }));
}

function proposerLettre(lettre) {
  websocket.send(JSON.stringify({ type: "proposer_lettre", lettre }));
}

function mettreAJourEtat(etat) {
  modeActuel = etat.mode;
  document.getElementById("nombre-joueurs").innerText = etat.joueurs.length;
  document.getElementById("liste-joueurs").innerText = etat.joueurs.join(", ");
  document.getElementById("mot-affiche").innerText =
    etat.mot_affiche || "_ ".repeat(etat.longueur_mot || 0);
  document.getElementById("compteur-erreurs").innerText = etat.erreurs;
  document.getElementById("lettres-essayees").innerText = etat.lettres_essayees.join(", ");
  document.getElementById("tour-actuel").innerText = etat.phase === "jeu"
    ? (etat.joueur_actuel === identifiant ? "C'est ton tour !" : `Tour de ${etat.joueur_actuel}`)
    : (etat.phase === "attente" ? "En attente du demarrage..." : "");

  etat.lettres_essayees.forEach(lettre => {
    const bouton = document.getElementById(`lettre-${lettre}`);
    if (bouton) bouton.disabled = true;
  });

  const labelRole = document.getElementById("role-affiche");
  if (etat.mode === "imposteur" && etat.role) {
    labelRole.classList.remove("cache");
    if (etat.role === "imposteur") {
      labelRole.innerText = "Tu es l'IMPOSTEUR. Tu ne connais pas le mot : bluffe !";
      labelRole.style.color = "#ff5555";
    } else {
      labelRole.innerText = `Tu es INNOCENT. Le mot est : "${etat.mot_complet}"`;
      labelRole.style.color = "#55ff88";
    }
  } else {
    labelRole.classList.add("cache");
  }
}

function afficherZoneVote() {
  const zoneVote = document.getElementById("zone-vote");
  zoneVote.classList.remove("cache");
  const conteneur = document.getElementById("boutons-vote");
  conteneur.innerHTML = "";

  document.getElementById("liste-joueurs").innerText.split(", ").forEach(nomJoueur => {
    if (!nomJoueur) return;
    const bouton = document.createElement("button");
    bouton.innerText = nomJoueur;
    bouton.onclick = () => {
      websocket.send(JSON.stringify({ type: "voter", cible: nomJoueur }));
      document.getElementById("statut-vote").innerText = `Tu as vote pour ${nomJoueur}. En attente des autres...`;
      Array.from(conteneur.children).forEach(b => b.disabled = true);
    };
    conteneur.appendChild(bouton);
  });
}

function afficherResultatVote(message) {
  document.getElementById("zone-vote").classList.add("cache");
  const designe = message.joueur_designe || "Personne (egalite de votes)";
  const camp = message.victoire_innocents ? "Les INNOCENTS gagnent !" : "L'IMPOSTEUR gagne !";
  document.getElementById("resultat").innerText =
    `Vote : ${designe} designe. Imposteur(s) reel(s) : ${message.imposteurs_reels.join(", ")}. ` +
    `Mot : "${message.mot}". ${camp}`;
}