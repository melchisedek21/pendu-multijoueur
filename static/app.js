let token = null;
let identifiant = null;
let websocket = null;
let modeActuel = "classique";
let hoteActuel = null;
let dureeManche = 0;

const COULEURS_AVATAR = ["c0", "c1", "c2", "c3", "c4", "c5"];
const PARTIES_PENDU = [
  "partie-tete", "partie-corps", "partie-bras-gauche",
  "partie-bras-droit", "partie-jambe-gauche", "partie-jambe-droite",
];
const ERREURS_MAX = 6;
const REGEX_IDENTIFIANT = /^[A-Za-z0-9_]{3,20}$/;

function afficherEcran(id) {
  document.querySelectorAll(".ecran-simple, .app").forEach(e => e.classList.add("cache"));
  document.getElementById(id).classList.remove("cache");
}

/* ---------- Authentification ---------- */

function validerFormulaireAuth() {
  const id = document.getElementById("champ-identifiant").value.trim();
  const mdp = document.getElementById("champ-mot-de-passe").value;
  if (!REGEX_IDENTIFIANT.test(id)) {
    document.getElementById("message-auth").innerText =
      "L'identifiant doit contenir entre 3 et 20 caracteres : lettres, chiffres ou underscore uniquement.";
    return null;
  }
  if (mdp.length < 6) {
    document.getElementById("message-auth").innerText = "Le mot de passe doit contenir au moins 6 caracteres.";
    return null;
  }
  return { id, mdp };
}

function basculerMotDePasse() {
  const champ = document.getElementById("champ-mot-de-passe");
  const bouton = document.getElementById("bouton-voir-mdp");
  const visible = champ.type === "password";
  champ.type = visible ? "text" : "password";
  bouton.innerText = visible ? "🙈" : "👁️";
  const libelle = visible ? "Masquer le mot de passe" : "Afficher le mot de passe";
  bouton.title = libelle;
  bouton.setAttribute("aria-label", libelle);
}

async function inscription() {
  const valeurs = validerFormulaireAuth();
  if (!valeurs) return;
  const reponse = await fetch("/api/inscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant: valeurs.id, mot_de_passe: valeurs.mdp }),
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
  if (!id || !mdp) return;
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
  sessionStorage.setItem("pendu_token", jeton);
  sessionStorage.setItem("pendu_identifiant", id);
  document.getElementById("nom-joueur").innerText = identifiant;
  afficherEcran("ecran-salle");
}

/* ---------- Salles ---------- */

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

let fermetureAttendue = false;

function rejoindreSocketSalle(code) {
  fermetureAttendue = false;
  const protocole = window.location.protocol === "https:" ? "wss" : "ws";
  websocket = new WebSocket(`${protocole}://${window.location.host}/ws/${code}?token=${encodeURIComponent(token)}`);

  websocket.onopen = () => {
    sessionStorage.setItem("pendu_salle", code);
    afficherEcran("ecran-jeu");
    document.getElementById("code-salle-affiche").innerText = code;
    document.getElementById("messages-chat").innerHTML = "";
    document.getElementById("resultat").innerText = "";
    fermerOverlayFinManche();
    fermerOverlayFinMatch();
    reinitialiserDessinPendu();
    construireVies(0);
  };

  websocket.onmessage = (evenement) => gererMessage(JSON.parse(evenement.data));

  websocket.onclose = () => {
    if (fermetureAttendue) return;
    document.getElementById("message-salle").innerText =
      "Connexion fermee (salle pleine, code invalide, ou session expiree).";
  };
}

function quitterPartie() {
  fermetureAttendue = true;
  sessionStorage.removeItem("pendu_salle");
  if (websocket) {
    // Previent le serveur que c'est un depart volontaire (pas une simple coupure) :
    // il nous retire tout de suite au lieu d'attendre le delai de reconnexion.
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "quitter" }));
    }
    websocket.close();
    websocket = null;
  }
  document.getElementById("carte-role").classList.add("cache");
  fermerOverlayFinManche();
  fermerOverlayFinMatch();
  dernierePhase = null;
  hoteDeconnecteSignale = false;
  afficherEcran("ecran-salle");
}

/* ---------- Reconnexion automatique (rafraichissement de page) ---------- */

(function tenterReconnexionAutomatique() {
  const jetonSauvegarde = sessionStorage.getItem("pendu_token");
  const identifiantSauvegarde = sessionStorage.getItem("pendu_identifiant");
  const salleSauvegardee = sessionStorage.getItem("pendu_salle");
  if (!jetonSauvegarde || !identifiantSauvegarde) return;

  token = jetonSauvegarde;
  identifiant = identifiantSauvegarde;
  document.getElementById("nom-joueur").innerText = identifiant;

  afficherEcran("ecran-salle");
  if (salleSauvegardee) {
    document.getElementById("message-salle").innerText = "Reconnexion a la salle en cours...";
    rejoindreSocketSalle(salleSauvegardee);
  }
})();

/* ---------- Historique des scores ---------- */

async function ouvrirHistorique() {
  afficherEcran("panneau-historique");
  const conteneur = document.getElementById("liste-historique");
  conteneur.innerHTML = "<p class='message'>Chargement...</p>";
  try {
    const reponse = await fetch(`/api/scores?token=${encodeURIComponent(token)}`);
    const scores = await reponse.json();
    if (!reponse.ok || !scores.length) {
      conteneur.innerHTML = "<p class='message'>Aucun score enregistre pour l'instant. Termine un match pour en gagner !</p>";
      return;
    }
    conteneur.innerHTML = scores.map(s => {
      const date = s.date_partie ? new Date(s.date_partie).toLocaleDateString("fr-FR") : "";
      return `
        <div class="ligne-historique">
          <div>
            <span>${s.mot ? `Mot : "${s.mot}"` : "Partie"}</span>
            <small>${s.difficulte} — ${date}</small>
          </div>
          <strong>+${s.points} pts</strong>
        </div>`;
    }).join("");
  } catch {
    conteneur.innerHTML = "<p class='message'>Impossible de charger l'historique pour le moment.</p>";
  }
}

function fermerHistorique() {
  afficherEcran("ecran-salle");
}

/* ---------- Messages WebSocket ---------- */

function gererMessage(message) {
  switch (message.type) {
    case "etat_jeu":
      mettreAJourEtat(message);
      break;
    case "erreur":
      afficherToast(message.message);
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
    case "fin_manche":
      afficherFinManche(message);
      break;
    case "fin_match":
      afficherFinMatch(message);
      break;
    case "tick":
      mettreAJourMinuteur(message.temps_restant);
      break;
    case "tick_tour":
      mettreAJourMinuteurTour(message.temps_restant_tour);
      break;
    case "tour_saute":
      afficherToast(`⏭️ Temps ecoule pour ${message.joueur}, tour passe.`);
      break;
    case "chat_recu":
      afficherMessageChat(message.auteur, message.texte);
      break;
    case "salle_fermee":
      afficherToast(message.message);
      fermetureAttendue = true;
      sessionStorage.removeItem("pendu_salle");
      if (websocket) {
        websocket.close();
        websocket = null;
      }
      document.getElementById("carte-role").classList.add("cache");
      fermerOverlayFinManche();
      fermerOverlayFinMatch();
      dernierePhase = null;
      hoteDeconnecteSignale = false;
      afficherEcran("ecran-salle");
      document.getElementById("message-salle").innerText = message.message;
      break;
  }
}

/* ---------- Joueurs / avatars ---------- */

function initiale(nom) {
  return nom ? nom.charAt(0).toUpperCase() : "?";
}

function construireListeJoueurs(joueurs, joueursDeconnectes) {
  const conteneur = document.getElementById("liste-joueurs-visuelle");
  conteneur.innerHTML = "";
  const deconnectes = new Set(joueursDeconnectes || []);
  joueurs.forEach((nom, index) => {
    const ligne = document.createElement("div");
    ligne.className = "player" + (deconnectes.has(nom) ? " deconnecte" : "");
    const couleur = COULEURS_AVATAR[index % COULEURS_AVATAR.length];

    ligne.innerHTML = `
      <div class="avatar ${couleur}">${initiale(nom)}</div>
      <div class="player-name">
        <strong>${nom}</strong>
        ${deconnectes.has(nom) ? '<span class="statut-deconnecte">Deconnecte...</span>' : ""}
      </div>
    `;
    conteneur.appendChild(ligne);
  });
}

/* ---------- Vies (coeurs) ---------- */

function construireVies(erreurs) {
  const conteneur = document.getElementById("lives");
  conteneur.innerHTML = "";
  for (let i = 0; i < ERREURS_MAX; i++) {
    const coeur = document.createElement("span");
    coeur.innerText = "♥";
    if (i < erreurs) coeur.classList.add("lost");
    conteneur.appendChild(coeur);
  }
}

/* ---------- Pendu ---------- */

function reinitialiserDessinPendu() {
  PARTIES_PENDU.forEach(id => {
    document.getElementById(id).style.opacity = "0";
  });
}

function mettreAJourDessinPendu(erreurs) {
  PARTIES_PENDU.forEach((id, index) => {
    document.getElementById(id).style.opacity = index < erreurs ? "1" : "0";
  });
}

/* ---------- Clavier ---------- */

function construireClavier() {
  const clavier = document.getElementById("clavier");
  clavier.innerHTML = "";
  "abcdefghijklmnopqrstuvwxyz".split("").forEach(lettre => {
    const bouton = document.createElement("button");
    bouton.className = "key";
    bouton.innerText = lettre.toUpperCase();
    bouton.id = `lettre-${lettre}`;
    bouton.onclick = () => proposerLettre(lettre);
    clavier.appendChild(bouton);
  });
}

/* ---------- Actions de jeu ---------- */

function demarrerPartie() {
  modeActuel = document.getElementById("select-mode").value;
  const categorie = document.getElementById("select-categorie").value;
  const difficulte = document.getElementById("select-difficulte").value;
  let manches = parseInt(document.getElementById("champ-manches").value, 10);
  if (!Number.isFinite(manches) || manches < 1) manches = 1;
  if (manches > 10) manches = 10;

  document.getElementById("resultat").innerText = "";
  document.getElementById("zone-vote").classList.add("cache");
  fermerOverlayFinManche();
  fermerOverlayFinMatch();
  reinitialiserDessinPendu();
  construireClavier();
  websocket.send(JSON.stringify({ type: "demarrer", mode: modeActuel, categorie, difficulte, manches }));
}

function proposerLettre(lettre) {
  websocket.send(JSON.stringify({ type: "proposer_lettre", lettre }));
}

// Permet de jouer avec le clavier physique (hors saisie dans le chat ou un champ)
document.addEventListener("keydown", (evenement) => {
  if (document.getElementById("ecran-jeu").classList.contains("cache")) return;
  if (evenement.ctrlKey || evenement.metaKey || evenement.altKey) return;
  const cible = evenement.target.tagName;
  if (cible === "INPUT" || cible === "SELECT" || cible === "TEXTAREA") return;
  if (evenement.key === "Escape") {
    fermerRegles();
    return;
  }
  const lettre = evenement.key.toLowerCase();
  if (!/^[a-z]$/.test(lettre)) return;
  const bouton = document.getElementById(`lettre-${lettre}`);
  if (bouton && !bouton.disabled && dernierePhase === "jeu" && websocket) {
    proposerLettre(lettre);
  }
});

/* ---------- Chat ---------- */

document.getElementById("formulaire-chat").addEventListener("submit", (evenement) => {
  evenement.preventDefault();
  const champ = document.getElementById("champ-chat");
  const texte = champ.value.trim();
  if (!texte || !websocket) return;
  websocket.send(JSON.stringify({ type: "chat", texte }));
  champ.value = "";
});

function afficherMessageChat(auteur, texte) {
  const conteneur = document.getElementById("messages-chat");
  const ligne = document.createElement("div");
  ligne.className = auteur === identifiant ? "message chat-moi" : "message";
  ligne.innerHTML = `
    <div class="message-meta"><strong>${auteur}</strong></div>
    <p class="bulle">${escapeHtml(texte)}</p>
  `;
  conteneur.appendChild(ligne);
  conteneur.scrollTop = conteneur.scrollHeight;
}

function escapeHtml(valeur) {
  const div = document.createElement("div");
  div.textContent = valeur;
  return div.innerHTML;
}

/* ---------- Minuteurs ---------- */

function formatTemps(secondes) {
  secondes = Math.max(0, secondes);
  const m = Math.floor(secondes / 60);
  const s = secondes % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function mettreAJourMinuteur(tempsRestant) {
  document.getElementById("temps-restant-affiche").innerText = formatTemps(tempsRestant);
  const barre = document.getElementById("barre-temps");
  const pourcentage = dureeManche > 0 ? Math.max(0, Math.min(100, (tempsRestant / dureeManche) * 100)) : 100;
  barre.style.width = `${pourcentage}%`;
  barre.classList.toggle("urgent", tempsRestant <= 20);
}

function mettreAJourMinuteurTour(tempsRestantTour) {
  const el = document.getElementById("temps-restant-tour-affiche");
  el.classList.remove("cache");
  el.innerText = `⏳ ${tempsRestantTour}s pour jouer`;
}

/* ---------- Etat du jeu ---------- */

let dernierePhase = null;

function mettreAJourEtat(etat) {
  modeActuel = etat.mode;
  hoteActuel = etat.hote;
  dureeManche = etat.duree_manche || dureeManche;

  document.getElementById("nombre-joueurs").innerText = etat.joueurs.length;
  document.getElementById("pill-mode").innerText =
    etat.mode === "imposteur" ? "🕵️ Imposteur" : "🎮 Classique";
  document.getElementById("pill-manche").innerText =
    etat.manches_total ? `Manche ${etat.manche_actuelle}/${etat.manches_total}` : "Manche 0/0";

  construireListeJoueurs(etat.joueurs, etat.joueurs_deconnectes);

  mettreAJourMinuteur(etat.temps_restant || 0);
  const elTour = document.getElementById("temps-restant-tour-affiche");
  if (etat.phase === "jeu") {
    mettreAJourMinuteurTour(etat.temps_restant_tour || 0);
  } else {
    elTour.classList.add("cache");
  }

  // Detecte le debut d'une NOUVELLE manche (peu importe qui l'a demarree)
  // et reconstruit le clavier chez CE client, pour eviter les boutons restes desactives
  // d'une manche precedente.
  const nouvelleManche = etat.phase === "jeu" && etat.lettres_essayees.length === 0
    && dernierePhase !== "jeu";
  if (nouvelleManche) {
    reinitialiserDessinPendu();
    construireClavier();
    fermerOverlayFinManche();
    fermerOverlayFinMatch();
    document.getElementById("zone-vote").classList.add("cache");
  }
  dernierePhase = etat.phase;

  signalerHoteDeconnecte(etat);

  const casesAffichees = (etat.mot_affiche || "_ ".repeat(etat.longueur_mot || 0))
    .split(" ").filter(c => c !== "");
  if (etat.mot_revele) {
    // Manche terminee : on devoile le mot complet, les lettres non trouvees en rouge
    document.getElementById("mot-affiche").innerHTML = etat.mot_revele.split("").map((lettre, i) =>
      casesAffichees[i] === lettre ? `<span>${lettre}</span>` : `<span class="lettre-manquante">${lettre}</span>`
    ).join("");
  } else {
    document.getElementById("mot-affiche").innerHTML =
      casesAffichees.map(c => `<span>${c}</span>`).join("");
  }

  document.getElementById("compteur-erreurs").innerText = etat.erreurs;
  construireVies(etat.erreurs);
  mettreAJourDessinPendu(etat.erreurs);

  document.getElementById("tour-actuel").innerText = etat.phase === "jeu"
    ? (etat.joueur_actuel === identifiant ? "C'est ton tour !" : `Tour de ${etat.joueur_actuel}`)
    : (etat.phase === "attente" ? "En attente du demarrage..." : "");

  document.getElementById("texte-indice").innerText =
    etat.indice
      ? etat.indice
      : (etat.phase !== "attente"
          ? `Categorie : ${etat.categorie} | Difficulte : ${etat.difficulte}`
          : "L'indice du mot s'affichera ici une fois la partie lancee.");

  if (!document.getElementById("clavier").children.length) construireClavier();
  etat.lettres_essayees.forEach(lettre => {
    const bouton = document.getElementById(`lettre-${lettre}`);
    if (bouton) {
      bouton.disabled = true;
      bouton.classList.add(etat.mot_affiche.includes(lettre) ? "correct" : "wrong");
    }
  });

  // Seul l'hote voit les controles pour lancer une partie
  const estHote = etat.hote === identifiant;
  const enAttenteOuFinMatch = etat.phase === "attente" || etat.phase === "fin_match";
  document.getElementById("config-partie").classList.toggle("cache", !estHote || !enAttenteOuFinMatch);
  document.getElementById("message-attente-hote").classList.toggle(
    "cache", estHote || !enAttenteOuFinMatch
  );
  if (!estHote) {
    document.getElementById("message-attente-hote").innerText =
      `En attente que ${etat.hote} demarre la partie...`;
  }

  const carteRole = document.getElementById("carte-role");
  if (etat.mode === "imposteur" && etat.role) {
    carteRole.classList.remove("cache");
    const badge = document.getElementById("badge-role");
    const motRole = document.getElementById("mot-role");
    const avertissement = document.getElementById("avertissement-role");
    if (etat.role === "imposteur") {
      badge.innerText = "IMPOSTEUR";
      motRole.innerText = "???";
      avertissement.innerText = "Tu ne connais pas le mot : bluffe en proposant des lettres plausibles !";
    } else {
      badge.innerText = "INNOCENT";
      motRole.innerText = etat.mot_complet;
      avertissement.innerText = "Ne revele jamais ce mot dans le chat !";
    }
  } else {
    carteRole.classList.add("cache");
  }
}

let hoteDeconnecteSignale = false;

function signalerHoteDeconnecte(etat) {
  const hoteDeconnecte = (etat.joueurs_deconnectes || []).includes(etat.hote) && etat.hote !== identifiant;
  if (hoteDeconnecte && !hoteDeconnecteSignale) {
    afficherToast(`⚠️ ${etat.hote} (hote) est deconnecte. La salle fermera dans ${etat.delai_reconnexion || 20}s s'il ne revient pas.`);
  }
  hoteDeconnecteSignale = hoteDeconnecte;
}

/* ---------- Vote ---------- */

function afficherZoneVote() {
  const zoneVote = document.getElementById("zone-vote");
  zoneVote.classList.remove("cache");
  const conteneur = document.getElementById("boutons-vote");
  conteneur.innerHTML = "";

  document.querySelectorAll("#liste-joueurs-visuelle .player-name strong").forEach(el => {
    const nomJoueur = el.innerText;
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
  const camp = message.victoire_innocents ? "Les INNOCENTS gagnent cette manche !" : "L'IMPOSTEUR gagne cette manche !";
  afficherToast(camp);
  document.getElementById("resultat").innerText =
    `Vote : ${designe} designe. Imposteur(s) reel(s) : ${message.imposteurs_reels.join(", ")}. ` +
    `Mot : "${message.mot}". ${camp}`;

  document.getElementById("titre-fin-manche").innerText =
    `Manche ${message.manche_actuelle}/${message.manches_total}`;
  document.getElementById("mot-fin-manche").innerText = `${camp} Le mot etait "${message.mot}".`;
  document.getElementById("classement-manche").innerHTML = `
    <div class="ligne-classement premier">
      <div class="infos">
        <strong>Designe : ${designe}</strong>
        <small>Imposteur(s) reel(s) : ${message.imposteurs_reels.join(", ")}</small>
      </div>
    </div>`;

  if (!message.manche_finale) {
    ouvrirOverlayFinManche();
  }
}

/* ---------- Classement / fin de manche / fin de match ---------- */

function construireClassementHTML(lignes, cleScore, cleDetail) {
  if (!lignes || !lignes.length) return "";
  return lignes.map((ligne, index) => `
    <div class="ligne-classement ${index === 0 ? "premier" : ""}">
      <div class="rang">${index === 0 ? "🏆" : index + 1}</div>
      <div class="infos">
        <strong>${ligne.identifiant}</strong>
        ${cleDetail ? `<small>${ligne[cleDetail]} bonne(s) lettre(s) trouvee(s)</small>` : ""}
      </div>
      <div class="points">+${ligne[cleScore]} pts</div>
    </div>
  `).join("");
}

function afficherFinManche(message) {
  document.getElementById("titre-fin-manche").innerText =
    `Manche ${message.manche_actuelle}/${message.manches_total}`;
  document.getElementById("mot-fin-manche").innerText = message.gagne
    ? `✅ Mot trouve : "${message.mot}"`
    : `💀 Manche perdue. Le mot etait "${message.mot}".`;
  document.getElementById("classement-manche").innerHTML =
    construireClassementHTML(message.classement, "points_manche", "lettres_correctes");

  if (!message.manche_finale) {
    ouvrirOverlayFinManche();
  }
}

function ouvrirOverlayFinManche() {
  const estHote = hoteActuel === identifiant;
  document.getElementById("bouton-manche-suivante").classList.toggle("cache", !estHote);
  document.getElementById("attente-hote-manche").classList.toggle("cache", estHote);
  document.getElementById("overlay-fin-manche").classList.remove("cache");
}

function fermerOverlayFinManche() {
  document.getElementById("overlay-fin-manche").classList.add("cache");
}

function lancerMancheSuivante() {
  fermerOverlayFinManche();
  websocket.send(JSON.stringify({ type: "manche_suivante" }));
}

function afficherFinMatch(message) {
  fermerOverlayFinManche();
  const conteneur = document.getElementById("classement-final");

  const motFinMatch = document.getElementById("mot-fin-match");
  if (message.mot) {
    motFinMatch.innerHTML = message.gagne === false
      ? `💀 Derniere manche perdue. Le mot etait <strong>${escapeHtml(message.mot)}</strong>`
      : `Le mot etait <strong>${escapeHtml(message.mot)}</strong>`;
  } else {
    motFinMatch.innerHTML = "";
  }

  if (message.classement_final) {
    // Mode Classique : classement par contribution (bonnes lettres proposees)
    conteneur.innerHTML = construireClassementHTML(message.classement_final, "points_total", null);
  } else {
    // Mode Imposteur : victoire par camp
    const camp = message.victoire_innocents ? "🎉 Les INNOCENTS remportent le match !" : "🕵️ L'IMPOSTEUR remporte le match !";
    conteneur.innerHTML = `
      <div class="ligne-classement premier">
        <div class="infos">
          <strong>${camp}</strong>
          <small>Imposteur(s) : ${message.imposteurs_reels.join(", ")}</small>
        </div>
      </div>`;
  }

  const estHote = hoteActuel === identifiant;
  document.getElementById("boutons-fin-match").classList.toggle("cache", !estHote);
  document.getElementById("attente-hote-match").classList.toggle("cache", estHote);
  document.getElementById("overlay-fin-match").classList.remove("cache");
}

function fermerOverlayFinMatch() {
  document.getElementById("overlay-fin-match").classList.add("cache");
}

function rejouer() {
  fermerOverlayFinMatch();
  demarrerPartie();
}

function changerParametres() {
  fermerOverlayFinMatch();
  document.getElementById("carte-config").scrollIntoView({ behavior: "smooth", block: "center" });
  afficherToast("Ajuste les parametres a gauche puis clique sur Demarrer.");
}

/* ---------- Regles du jeu / code de salle (en-tete) ---------- */

function ouvrirRegles() {
  document.getElementById("overlay-regles").classList.remove("cache");
}

function fermerRegles() {
  document.getElementById("overlay-regles").classList.add("cache");
}

async function copierCodeSalle() {
  const code = document.getElementById("code-salle-affiche").innerText;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    afficherToast(`📋 Code ${code} copie ! Envoie-le a tes amis pour qu'ils te rejoignent.`);
  } catch {
    // navigator.clipboard n'est dispo qu'en HTTPS ou sur localhost
    afficherToast(`Code de la salle : ${code}`);
  }
}

/* ---------- Toast ---------- */

let delaiToast;
function afficherToast(texte) {
  const toast = document.getElementById("toast");
  toast.textContent = texte;
  toast.classList.add("show");
  clearTimeout(delaiToast);
  delaiToast = setTimeout(() => toast.classList.remove("show"), 2500);
}