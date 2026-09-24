let token = null;
let identifiant = null;
let websocket = null;
let modeActuel = "classique";
let hoteActuel = null;
let dureeManche = 0;
let dernierEtat = null;

const VERSION = "1.1";
const COULEURS_AVATAR = ["c0", "c1", "c2", "c3", "c4", "c5"];
const EMOJIS_AVATAR = ["🕵️", "🦊", "🐱", "🐼", "🦉", "🐸", "🤖", "👻", "🐯", "🦄", "🐙", "🎩"];
const PARTIES_PENDU = [
  "partie-tete", "partie-corps", "partie-bras-gauche",
  "partie-bras-droit", "partie-jambe-gauche", "partie-jambe-droite",
];
const ERREURS_MAX = 6;
const REGEX_IDENTIFIANT = /^[A-Za-z0-9_]{3,20}$/;
const LOCALES_DATE = { fr: "fr-FR", en: "en-GB", es: "es-ES" };

/* ---------- Preferences (liees au compte, avec une copie sur l'appareil) ---------- */

const PREFERENCES_DEFAUT = { couleur: null, emoji: null, animations: true, vibrations: true };
const CHAMPS_PREFERENCES = ["couleur", "emoji", "langue", "animations", "vibrations"];
let preferences = { ...PREFERENCES_DEFAUT, ...JSON.parse(localStorage.getItem("pendu_prefs") || "{}") };

function enregistrerPreferences() {
  localStorage.setItem("pendu_prefs", JSON.stringify(preferences));
}

/** Enregistre les champs modifies sur le compte, pour les retrouver sur un autre appareil. */
async function sauvegarderPreferencesServeur(champs) {
  enregistrerPreferences();
  if (!token) return;
  const corps = { token };
  champs.forEach(cle => { corps[cle] = cle === "langue" ? langueActuelle : preferences[cle]; });
  try {
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
  } catch {
    // Hors ligne : la copie locale suffit, elle sera renvoyee a la prochaine connexion
  }
}

/** A la connexion : applique les preferences du compte (elles priment sur celles de l'appareil). */
async function synchroniserPreferences() {
  try {
    const reponse = await fetch(`/api/preferences?token=${encodeURIComponent(token)}`);
    if (!reponse.ok) return;
    const serveur = await reponse.json();
    if (!serveur.enregistrees) {
      // Premier passage de ce compte : on garde ce qu'il avait deja regle sur cet appareil
      if (!preferences.proprietaire || preferences.proprietaire === identifiant) {
        preferences.proprietaire = identifiant;
        await sauvegarderPreferencesServeur(CHAMPS_PREFERENCES);
      }
      return;
    }
    ["couleur", "emoji", "animations", "vibrations"].forEach(cle => { preferences[cle] = serveur[cle]; });
    preferences.proprietaire = identifiant;
    enregistrerPreferences();
    appliquerPreferences();
    if (serveur.langue && serveur.langue !== langueActuelle) {
      synchroEnCours = true;
      changerLangue(serveur.langue);
      synchroEnCours = false;
    }
  } catch {
    // Serveur injoignable : on garde les preferences de l'appareil
  }
}

let synchroEnCours = false;

function appliquerPreferences() {
  appliquerPreferenceAnimations();
  document.getElementById("reglage-animations").checked = preferences.animations;
  document.getElementById("reglage-vibrations").checked = preferences.vibrations;
  rafraichirMoi();
  if (!document.getElementById("overlay-profil").classList.contains("cache")) construireChoixAvatar();
  envoyerAvatar();
}

const ANIMATIONS_REDUITES = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function animationsActives() {
  return preferences.animations && !ANIMATIONS_REDUITES;
}

function appliquerPreferenceAnimations() {
  document.body.classList.toggle("sans-animations", !animationsActives());
}

function afficherEcran(id) {
  document.querySelectorAll(".ecran-simple, .app").forEach(e => e.classList.add("cache"));
  document.getElementById(id).classList.remove("cache");
  // Le fond anime decore les ecrans d'accueil, mais ne doit pas distraire pendant une partie
  document.getElementById("fond-anime").classList.toggle("cache", id === "ecran-jeu");
}

/* ---------- Fond anime et mini-pendu de demonstration (ecran d'accueil) ---------- */

(function construireFondAnime() {
  const fond = document.getElementById("fond-anime");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let i = 0; i < 26; i++) {
    const tuile = document.createElement("span");
    // Quelques tuiles vertes (bonnes lettres), rouges (erreurs) et des "?" pour l'imposteur
    tuile.className = "tuile-fond" + (i % 7 === 0 ? " ok" : i % 11 === 5 ? " ko" : "");
    tuile.textContent = i % 9 === 4 ? "?" : alphabet[Math.floor(Math.random() * alphabet.length)];
    const taille = 28 + Math.random() * 34;
    tuile.style.cssText = [
      `left:${(Math.random() * 96).toFixed(1)}%`,
      `width:${taille.toFixed(0)}px`,
      `height:${taille.toFixed(0)}px`,
      `font-size:${(taille * 0.45).toFixed(0)}px`,
      `animation-duration:${(16 + Math.random() * 18).toFixed(1)}s`,
      `animation-delay:${(-Math.random() * 34).toFixed(1)}s`,
      `--rotation:${(Math.random() * 60 - 30).toFixed(0)}deg`,
      `--opacite:${(0.12 + Math.random() * 0.22).toFixed(2)}`,
      `--haut:${(Math.random() * 92).toFixed(1)}%`,
    ].join(";");
    fond.appendChild(tuile);
  }
})();

(function lancerDemoMot() {
  const zone = document.getElementById("demo-mot");
  const essais = document.getElementById("demo-essais");
  const ecranAuth = document.getElementById("ecran-auth");
  let indexMot = 0;

  const motsDemo = () => t("vitrine.mots");
  const dessinerCases = (mot) => {
    zone.innerHTML = mot.split("").map(() => `<span class="demo-case"></span>`).join("");
    essais.innerHTML = "";
  };
  const afficherMotComplet = () => {
    const mot = motsDemo()[0];
    dessinerCases(mot);
    [...zone.children].forEach((c, i) => { c.textContent = mot[i]; c.classList.add("revelee"); });
  };

  const jouerMot = () => {
    // Animations coupees : on affiche un mot fixe et on reverifie de temps en temps
    if (!animationsActives()) { afficherMotComplet(); setTimeout(jouerMot, 1500); return; }
    const mots = motsDemo();
    const mot = mots[indexMot++ % mots.length];
    dessinerCases(mot);
    const cases = [...zone.children];
    const sequence = [...new Set(mot)].sort(() => Math.random() - 0.5);
    // Glisse 2 mauvaises lettres au milieu, comme dans une vraie partie
    "zxkwqjb".split("").filter(l => !mot.includes(l)).sort(() => Math.random() - 0.5).slice(0, 2)
      .forEach(faute => sequence.splice(1 + Math.floor(Math.random() * (sequence.length - 1)), 0, faute));

    let etape = 0;
    const suivant = () => {
      if (ecranAuth.classList.contains("cache")) { setTimeout(suivant, 1000); return; }  // en pause hors accueil
      if (!animationsActives()) { jouerMot(); return; }
      if (etape >= sequence.length) { setTimeout(jouerMot, 2200); return; }
      const lettre = sequence[etape++];
      if (mot.includes(lettre)) {
        cases.forEach((c, i) => { if (mot[i] === lettre) { c.textContent = lettre; c.classList.add("revelee"); } });
      } else {
        const faute = document.createElement("span");
        faute.className = "demo-faute";
        faute.textContent = lettre;
        essais.appendChild(faute);
        zone.classList.remove("secoue");
        void zone.offsetWidth; // relance l'animation
        zone.classList.add("secoue");
      }
      setTimeout(suivant, 650);
    };
    setTimeout(suivant, 700);
  };
  jouerMot();
})();

/* ---------- Choix de la langue sur l'ecran de connexion ---------- */

function construireSelecteurLangueAuth() {
  const conteneur = document.getElementById("selecteur-langue-auth");
  conteneur.innerHTML = Object.entries(LANGUES).map(([code, langue]) => `
    <button type="button" class="${code === langueActuelle ? "actif" : ""}" onclick="changerLangue('${code}')"
            title="${langue.nom}" aria-label="${langue.nom}">${langue.drapeau} ${code.toUpperCase()}</button>
  `).join("");
}

/* ---------- Authentification ---------- */

function validerFormulaireAuth() {
  const id = document.getElementById("champ-identifiant").value.trim();
  const mdp = document.getElementById("champ-mot-de-passe").value;
  if (!REGEX_IDENTIFIANT.test(id)) {
    document.getElementById("message-auth").innerText = t("auth.err_id");
    return null;
  }
  if (mdp.length < 6) {
    document.getElementById("message-auth").innerText = t("auth.err_mdp");
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
  bouton.dataset.i18nTitle = visible ? "auth.cacher_mdp" : "auth.voir_mdp";
  bouton.title = t(bouton.dataset.i18nTitle);
  bouton.setAttribute("aria-label", bouton.title);
}

async function envoyerAuth(url, corps) {
  const messageAuth = document.getElementById("message-auth");
  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    const donnees = await reponse.json();
    if (!reponse.ok) {
      messageAuth.innerText = traduireErreurApi(donnees.detail);
      return;
    }
    messageAuth.innerText = "";
    connecterSession(donnees.token, donnees.identifiant);
  } catch {
    messageAuth.innerText = t("erreurs.reseau");
  }
}

function inscription() {
  const valeurs = validerFormulaireAuth();
  if (!valeurs) return;
  envoyerAuth("/api/inscription", { identifiant: valeurs.id, mot_de_passe: valeurs.mdp });
}

function connexion() {
  const id = document.getElementById("champ-identifiant").value.trim();
  const mdp = document.getElementById("champ-mot-de-passe").value;
  if (!id || !mdp) return;
  envoyerAuth("/api/connexion", { identifiant: id, mot_de_passe: mdp });
}

// Entree dans un champ du formulaire = se connecter
["champ-identifiant", "champ-mot-de-passe"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") connexion(); });
});
document.getElementById("champ-code-salle").addEventListener("keydown", (e) => { if (e.key === "Enter") rejoindreSalle(); });

function connecterSession(jeton, id) {
  token = jeton;
  identifiant = id;
  sessionStorage.setItem("pendu_token", jeton);
  sessionStorage.setItem("pendu_identifiant", id);
  document.getElementById("nom-joueur").innerText = identifiant;
  rafraichirMoi();
  afficherEcran("ecran-salle");
  synchroniserPreferences();
}

function deconnexion() {
  if (!confirm(t("param.deconnexion_confirmer"))) return;
  if (websocket) quitterPartie();
  token = null;
  identifiant = null;
  sessionStorage.clear();
  // L'avatar appartient au compte : on ne le laisse pas au prochain joueur de cet appareil
  preferences = { ...preferences, couleur: null, emoji: null, proprietaire: null };
  enregistrerPreferences();
  fermerProfil();
  document.getElementById("champ-mot-de-passe").value = "";
  document.getElementById("message-salle").innerText = "";
  afficherEcran("ecran-auth");
}

/* ---------- Salles ---------- */

async function creerSalle() {
  try {
    const reponse = await fetch(`/api/salle/creer?token=${encodeURIComponent(token)}`, { method: "POST" });
    const donnees = await reponse.json();
    if (!reponse.ok) {
      document.getElementById("message-salle").innerText = traduireErreurApi(donnees.detail);
      return;
    }
    rejoindreSocketSalle(donnees.code_salle);
  } catch {
    document.getElementById("message-salle").innerText = t("erreurs.reseau");
  }
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
    document.getElementById("message-salle").innerText = "";
    fermerOverlayFinManche();
    fermerOverlayFinMatch();
    reinitialiserDessinPendu();
    construireVies(0);
    envoyerAvatar();
  };

  websocket.onmessage = (evenement) => gererMessage(JSON.parse(evenement.data));

  websocket.onclose = () => {
    if (fermetureAttendue) return;
    document.getElementById("message-salle").innerText = t("salle.fermee");
  };
}

function reinitialiserEtatSalle() {
  document.getElementById("carte-role").classList.add("cache");
  fermerOverlayFinManche();
  fermerOverlayFinMatch();
  dernierePhase = null;
  dernierEtat = null;
  dernierJoueurActuel = null;
  hoteDeconnecteSignale = false;
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
  reinitialiserEtatSalle();
  afficherEcran("ecran-salle");
}

/* ---------- Messages WebSocket ---------- */

function traduireMessageServeur(message) {
  return message.code ? t(`erreurs.${message.code}`, message.params || {}) : message.message;
}

function gererMessage(message) {
  switch (message.type) {
    case "etat_jeu":
      mettreAJourEtat(message);
      break;
    case "erreur": {
      const texte = traduireMessageServeur(message);
      afficherToast(texte);
      document.getElementById("resultat").innerText = texte;
      break;
    }
    case "debut_vote":
      afficherZoneVote();
      break;
    case "vote_recu":
      document.getElementById("statut-vote").innerText =
        t("vote.recus", { n: message.nombre_votes, t: message.total_joueurs });
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
      afficherToast(t("jeu.tour_saute", { j: message.joueur }));
      break;
    case "chat_recu":
      afficherMessageChat(message.auteur, message.texte);
      break;
    case "systeme":
      afficherMessageSysteme(t(`jeu.${message.code}`, message.params || {}));
      break;
    case "salle_fermee": {
      const texte = traduireMessageServeur(message);
      afficherToast(texte);
      fermetureAttendue = true;
      sessionStorage.removeItem("pendu_salle");
      if (websocket) {
        websocket.close();
        websocket = null;
      }
      reinitialiserEtatSalle();
      afficherEcran("ecran-salle");
      document.getElementById("message-salle").innerText = texte;
      break;
    }
  }
}

/* ---------- Joueurs / avatars ---------- */

function initiale(nom) {
  return nom ? nom.charAt(0).toUpperCase() : "?";
}

/** Remplit un element .avatar avec l'emoji (ou l'initiale) et la couleur du joueur. */
function rendreAvatar(element, nom, avatar, index = 0) {
  const couleur = (avatar && avatar.couleur) || COULEURS_AVATAR[index % COULEURS_AVATAR.length];
  COULEURS_AVATAR.forEach(c => element.classList.remove(c));
  element.classList.add(couleur);
  element.textContent = (avatar && avatar.emoji) || initiale(nom);
  element.classList.toggle("avec-emoji", Boolean(avatar && avatar.emoji));
}

/** Met a jour tous les endroits qui montrent MON avatar et MON nom. */
function rafraichirMoi() {
  const monAvatar = { couleur: preferences.couleur, emoji: preferences.emoji };
  document.querySelectorAll("[data-avatar-moi]").forEach(el => rendreAvatar(el, identifiant, monAvatar));
  document.querySelectorAll("[data-nom-moi]").forEach(el => { el.textContent = identifiant || ""; });
}

function envoyerAvatar() {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: "profil", couleur: preferences.couleur, emoji: preferences.emoji }));
  }
}

function construireListeJoueurs(joueurs, joueursDeconnectes, avatars) {
  const conteneur = document.getElementById("liste-joueurs-visuelle");
  conteneur.innerHTML = "";
  const deconnectes = new Set(joueursDeconnectes || []);
  joueurs.forEach((nom, index) => {
    const ligne = document.createElement("div");
    ligne.className = "player" + (deconnectes.has(nom) ? " deconnecte" : "");
    ligne.innerHTML = `
      <div class="avatar"></div>
      <div class="player-name">
        <strong>${nom}</strong>
        ${deconnectes.has(nom) ? `<span class="statut-deconnecte">${t("jeu.deconnecte")}</span>` : ""}
      </div>
    `;
    rendreAvatar(ligne.querySelector(".avatar"), nom, (avatars || {})[nom], index);
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

function overlayOuvert() {
  return ["overlay-profil", "overlay-regles"].some(id => !document.getElementById(id).classList.contains("cache"));
}

document.addEventListener("keydown", (evenement) => {
  if (evenement.key === "Escape") {
    // Ferme d'abord la fenetre du dessus (les regles peuvent s'ouvrir par-dessus le profil)
    if (!document.getElementById("overlay-regles").classList.contains("cache")) fermerRegles();
    else fermerProfil();
    return;
  }
  // Permet de jouer avec le clavier physique (hors saisie dans le chat ou un champ)
  if (document.getElementById("ecran-jeu").classList.contains("cache") || overlayOuvert()) return;
  if (evenement.ctrlKey || evenement.metaKey || evenement.altKey) return;
  const cible = evenement.target.tagName;
  if (cible === "INPUT" || cible === "SELECT" || cible === "TEXTAREA") return;
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

function afficherMessageSysteme(texte) {
  const conteneur = document.getElementById("messages-chat");
  const ligne = document.createElement("div");
  ligne.className = "message-systeme";
  ligne.textContent = texte;
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
  el.innerText = t("jeu.secondes_tour", { s: tempsRestantTour });
}

/* ---------- Etat du jeu ---------- */

let dernierePhase = null;
let dernierJoueurActuel = null;

function libelleCategorie(cle) {
  return t(`categories.${cle}`);
}

function libelleDifficulte(cle) {
  return cle ? t(`difficultes.${cle}`) : "—";
}

function mettreAJourEtat(etat) {
  dernierEtat = etat;
  modeActuel = etat.mode;
  hoteActuel = etat.hote;
  dureeManche = etat.duree_manche || dureeManche;

  document.getElementById("nombre-joueurs").innerText = etat.joueurs.length;
  document.getElementById("pill-mode").innerText =
    etat.mode === "imposteur" ? t("entete.mode_imposteur") : t("entete.mode_classique");
  document.getElementById("pill-manche").innerText =
    t("entete.manche", { a: etat.manches_total ? etat.manche_actuelle : 0, b: etat.manches_total || 0 });

  construireListeJoueurs(etat.joueurs, etat.joueurs_deconnectes, etat.avatars);

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

  // Petite vibration sur telephone quand mon tour commence
  const monTour = etat.phase === "jeu" && etat.joueur_actuel === identifiant;
  if (monTour && dernierJoueurActuel !== identifiant && preferences.vibrations && navigator.vibrate) {
    navigator.vibrate(150);
  }
  dernierJoueurActuel = etat.phase === "jeu" ? etat.joueur_actuel : null;

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

  const tourActuel = document.getElementById("tour-actuel");
  tourActuel.innerText = etat.phase === "jeu"
    ? (monTour ? t("jeu.ton_tour") : t("jeu.tour_de", { j: etat.joueur_actuel }))
    : (etat.phase === "attente" ? t("jeu.attente_demarrage") : "");
  tourActuel.classList.toggle("mon-tour", monTour);

  document.getElementById("texte-indice").innerText =
    etat.indice
      ? etat.indice
      : (etat.phase !== "attente"
          ? t("jeu.categorie_difficulte", { c: libelleCategorie(etat.categorie), d: libelleDifficulte(etat.difficulte) })
          : t("jeu.indice_attente"));

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
    document.getElementById("message-attente-hote").innerText = t("config.attente_hote", { h: etat.hote });
  }
  // Pendant une manche, le panneau n'a rien a afficher : on le masque au lieu de laisser une carte vide
  document.getElementById("carte-config").classList.toggle("cache", !enAttenteOuFinMatch);

  const carteRole = document.getElementById("carte-role");
  if (etat.mode === "imposteur" && etat.role) {
    carteRole.classList.remove("cache");
    const badge = document.getElementById("badge-role");
    const motRole = document.getElementById("mot-role");
    const avertissement = document.getElementById("avertissement-role");
    if (etat.role === "imposteur") {
      badge.innerText = t("jeu.imposteur");
      motRole.innerText = "???";
      avertissement.innerText = t("jeu.avert_imposteur");
    } else {
      badge.innerText = t("jeu.innocent");
      motRole.innerText = etat.mot_complet;
      avertissement.innerText = t("jeu.avert_innocent");
    }
  } else {
    carteRole.classList.add("cache");
  }
}

let hoteDeconnecteSignale = false;

function signalerHoteDeconnecte(etat) {
  const hoteDeconnecte = (etat.joueurs_deconnectes || []).includes(etat.hote) && etat.hote !== identifiant;
  if (hoteDeconnecte && !hoteDeconnecteSignale) {
    afficherToast(t("jeu.hote_deconnecte", { h: etat.hote, s: etat.delai_reconnexion || 20 }));
  }
  hoteDeconnecteSignale = hoteDeconnecte;
}

/* ---------- Vote ---------- */

function afficherZoneVote() {
  const zoneVote = document.getElementById("zone-vote");
  zoneVote.classList.remove("cache");
  const conteneur = document.getElementById("boutons-vote");
  conteneur.innerHTML = "";
  document.getElementById("statut-vote").innerText = "";

  document.querySelectorAll("#liste-joueurs-visuelle .player-name strong").forEach(el => {
    const nomJoueur = el.innerText;
    const bouton = document.createElement("button");
    bouton.innerText = nomJoueur;
    bouton.onclick = () => {
      websocket.send(JSON.stringify({ type: "voter", cible: nomJoueur }));
      document.getElementById("statut-vote").innerText = t("vote.tu_as_vote", { j: nomJoueur });
      Array.from(conteneur.children).forEach(b => b.disabled = true);
    };
    conteneur.appendChild(bouton);
  });
}

function afficherResultatVote(message) {
  document.getElementById("zone-vote").classList.add("cache");
  const designe = message.joueur_designe || t("vote.personne");
  const camp = message.victoire_innocents ? t("vote.innocents_manche") : t("vote.imposteur_manche");
  const imposteurs = message.imposteurs_reels.join(", ");
  afficherToast(camp);
  document.getElementById("resultat").innerText =
    t("vote.resume", { d: designe, i: imposteurs, m: message.mot, c: camp });

  document.getElementById("titre-fin-manche").innerText =
    t("fin.manche", { a: message.manche_actuelle, b: message.manches_total });
  document.getElementById("mot-fin-manche").innerText = t("vote.mot_etait", { c: camp, m: message.mot });
  document.getElementById("classement-manche").innerHTML = `
    <div class="ligne-classement premier">
      <div class="infos">
        <strong>${t("vote.designe", { d: designe })}</strong>
        <small>${t("vote.imposteurs_reels", { i: imposteurs })}</small>
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
        ${cleDetail ? `<small>${t("fin.lettres", { n: ligne[cleDetail] })}</small>` : ""}
      </div>
      <div class="points">+${ligne[cleScore]} ${t("fin.pts")}</div>
    </div>
  `).join("");
}

function afficherFinManche(message) {
  document.getElementById("titre-fin-manche").innerText =
    t("fin.manche", { a: message.manche_actuelle, b: message.manches_total });
  document.getElementById("mot-fin-manche").innerText = message.gagne
    ? t("fin.mot_trouve", { m: message.mot })
    : t("fin.manche_perdue", { m: message.mot });
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
    const mot = escapeHtml(message.mot);
    motFinMatch.innerHTML = message.gagne === false
      ? t("fin.derniere_perdue", { m: mot })
      : t("fin.mot_etait", { m: mot });
  } else {
    motFinMatch.innerHTML = "";
  }

  if (message.classement_final) {
    // Mode Classique : classement par contribution (bonnes lettres proposees)
    conteneur.innerHTML = construireClassementHTML(message.classement_final, "points_total", null);
  } else {
    // Mode Imposteur : victoire par camp
    const camp = message.victoire_innocents ? t("fin.innocents_match") : t("fin.imposteur_match");
    conteneur.innerHTML = `
      <div class="ligne-classement premier">
        <div class="infos">
          <strong>${camp}</strong>
          <small>${t("fin.imposteurs", { i: message.imposteurs_reels.join(", ") })}</small>
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
  afficherToast(t("config.ajuster"));
}

/* ---------- Regles du jeu / code de salle (en-tete) ---------- */

function construireRegles() {
  document.getElementById("contenu-regles").innerHTML = t("regles.sections").map(section => `
    <h3>${section.titre}</h3>
    <ul>${section.points.map(point => `<li>${point}</li>`).join("")}</ul>
  `).join("");
}

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
    afficherToast(t("copie.ok", { c: code }));
  } catch {
    // navigator.clipboard n'est dispo qu'en HTTPS ou sur localhost
    afficherToast(t("copie.secours", { c: code }));
  }
}

/* ---------- Profil et parametres ---------- */

let dernierProfil = null;

function ouvrirProfil(onglet = "profil") {
  if (!token) return;
  rafraichirMoi();
  construireChoixAvatar();
  afficherOnglet(onglet);
  document.getElementById("overlay-profil").classList.remove("cache");
  document.body.classList.add("scroll-bloque");
  chargerProfil();
}

function fermerProfil() {
  document.getElementById("overlay-profil").classList.add("cache");
  document.body.classList.remove("scroll-bloque");
}

function afficherOnglet(onglet) {
  document.querySelectorAll(".onglet").forEach(b => {
    const actif = b.dataset.onglet === onglet;
    b.classList.toggle("actif", actif);
    b.setAttribute("aria-selected", actif);
  });
  document.getElementById("vue-profil").classList.toggle("cache", onglet !== "profil");
  ouvrirSousVue(null, onglet === "parametres");
}

/** Affiche une sous-page des parametres (compte, langue...), ou le menu si `nom` est null. */
function ouvrirSousVue(nom, afficherMenu = true) {
  ["compte", "langue", "jeu", "apropos"].forEach(v => {
    document.getElementById(`sous-vue-${v}`).classList.toggle("cache", v !== nom);
  });
  document.getElementById("vue-parametres").classList.toggle("cache", Boolean(nom) || !afficherMenu);
  document.querySelector(".panneau-corps").scrollTop = 0;
  if (nom === "compte") document.getElementById("message-mdp").innerText = "";
}

async function chargerProfil() {
  const stats = document.getElementById("profil-stats");
  if (!dernierProfil) stats.innerHTML = `<p class="aide-petite">${t("profil.chargement")}</p>`;
  try {
    const reponse = await fetch(`/api/profil?token=${encodeURIComponent(token)}`);
    if (!reponse.ok) throw new Error();
    dernierProfil = await reponse.json();
    afficherProfil();
  } catch {
    stats.innerHTML = `<p class="aide-petite">${t("profil.erreur_chargement")}</p>`;
  }
}

function formaterDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(LOCALES_DATE[langueActuelle] || "fr-FR") : "";
}

function afficherProfil() {
  const p = dernierProfil;
  if (!p) return;
  const s = p.stats;

  document.getElementById("profil-rang").textContent = t(`profil.rangs.${p.rang.cle}`);
  document.getElementById("profil-depuis").textContent =
    p.date_inscription ? t("profil.membre_depuis", { d: formaterDate(p.date_inscription) }) : "";

  const barre = document.getElementById("profil-progression");
  const prochain = document.getElementById("profil-prochain");
  if (p.rang.suivant_seuil) {
    const pourcentage = ((s.points_total - p.rang.seuil) / (p.rang.suivant_seuil - p.rang.seuil)) * 100;
    barre.style.width = `${Math.max(3, Math.min(100, pourcentage))}%`;
    prochain.textContent = t("profil.prochain_rang", {
      p: p.rang.suivant_seuil - s.points_total, r: t(`profil.rangs.${p.rang.suivant_cle}`),
    });
  } else {
    barre.style.width = "100%";
    prochain.textContent = t("profil.rang_max");
  }

  document.getElementById("profil-stats").innerHTML = [
    ["⭐", s.points_total, t("profil.points")],
    ["🏆", s.victoires, t("profil.victoires")],
    ["🎯", s.meilleur_score, t("profil.meilleur")],
    ["📊", libelleDifficulte(s.difficulte_favorite), t("profil.difficulte_fav")],
  ].map(([icone, valeur, libelle]) => `
    <div class="stat"><span class="stat-icone">${icone}</span><strong>${valeur}</strong><small>${libelle}</small></div>
  `).join("");

  const debloques = {
    premiere: s.victoires >= 1, cinq: s.victoires >= 5, vingt_cinq: s.victoires >= 25,
    cinq_cents: s.points_total >= 500, deux_mille: s.points_total >= 2000, difficile: s.victoires_difficile >= 1,
  };
  document.getElementById("profil-succes").innerHTML = Object.entries(debloques).map(([cle, ok]) => {
    const [icone, nom, description] = t(`profil.succes_liste.${cle}`);
    return `
      <div class="succes-item ${ok ? "debloque" : ""}" title="${description}">
        <span class="succes-icone">${ok ? icone : "🔒"}</span>
        <strong>${nom}</strong>
        <small>${description}</small>
      </div>`;
  }).join("");

  const historique = document.getElementById("liste-historique");
  historique.innerHTML = p.historique.length
    ? p.historique.map(h => `
        <div class="ligne-historique">
          <div>
            <span>${h.mot ? t("profil.mot", { m: escapeHtml(h.mot) }) : t("profil.partie")}</span>
            <small>${libelleDifficulte(h.difficulte)} — ${formaterDate(h.date_partie)}</small>
          </div>
          <strong>+${h.points} ${t("fin.pts")}</strong>
        </div>`).join("")
    : `<p class="aide-petite">${t("profil.historique_vide")}</p>`;
}

function construireChoixAvatar() {
  const couleurs = document.getElementById("choix-couleurs");
  couleurs.innerHTML = COULEURS_AVATAR.map(c => `
    <button type="button" class="pastille-couleur ${c} ${preferences.couleur === c ? "choisi" : ""}"
            onclick="choisirAvatar('couleur', '${c}')" aria-label="${c}"></button>
  `).join("");
  const emojis = document.getElementById("choix-emojis");
  emojis.innerHTML = [null, ...EMOJIS_AVATAR].map(e => `
    <button type="button" class="choix-emoji ${preferences.emoji === e ? "choisi" : ""}"
            onclick="choisirAvatar('emoji', ${e ? `'${e}'` : "null"})">${e || initiale(identifiant)}</button>
  `).join("");
}

function choisirAvatar(type, valeur) {
  preferences[type] = valeur;
  sauvegarderPreferencesServeur([type]);
  construireChoixAvatar();
  rafraichirMoi();
  envoyerAvatar();
}

function construireListeLangues() {
  document.getElementById("liste-langues").innerHTML = Object.entries(LANGUES).map(([code, langue]) => `
    <button class="ligne-reglage ${code === langueActuelle ? "choisi" : ""}" onclick="changerLangue('${code}')">
      <span class="ico">${langue.drapeau}</span><span>${langue.nom}</span>
      <span class="coche">${code === langueActuelle ? "✓" : ""}</span>
    </button>
  `).join("");
  document.getElementById("valeur-langue").textContent = LANGUES[langueActuelle].nom;
}

document.getElementById("reglage-animations").addEventListener("change", (e) => {
  preferences.animations = e.target.checked;
  sauvegarderPreferencesServeur(["animations"]);
  appliquerPreferenceAnimations();
});

document.getElementById("reglage-vibrations").addEventListener("change", (e) => {
  preferences.vibrations = e.target.checked;
  sauvegarderPreferencesServeur(["vibrations"]);
  if (preferences.vibrations && navigator.vibrate) navigator.vibrate(60);
});

document.getElementById("formulaire-mdp").addEventListener("submit", async (evenement) => {
  evenement.preventDefault();
  const message = document.getElementById("message-mdp");
  const ancien = document.getElementById("champ-ancien-mdp");
  const nouveau = document.getElementById("champ-nouveau-mdp");
  if (nouveau.value.length < 6) { message.innerText = t("erreurs.mdp_court"); return; }
  try {
    const reponse = await fetch("/api/mot-de-passe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ancien_mot_de_passe: ancien.value, nouveau_mot_de_passe: nouveau.value }),
    });
    const donnees = await reponse.json();
    if (!reponse.ok) { message.innerText = traduireErreurApi(donnees.detail); return; }
    ancien.value = "";
    nouveau.value = "";
    message.innerText = t("param.mdp_change");
  } catch {
    message.innerText = t("erreurs.reseau");
  }
});

/* ---------- Langue : re-dessine tout ce qui est genere en JS ---------- */

function rafraichirTextesDynamiques() {
  construireSelecteurLangueAuth();
  construireRegles();
  construireListeLangues();
  document.getElementById("apropos-version").textContent = t("param.version", { v: VERSION });
  const boutonOeil = document.getElementById("bouton-voir-mdp");
  boutonOeil.title = t(boutonOeil.dataset.i18nTitle);
  if (dernierEtat) mettreAJourEtat(dernierEtat);
  if (dernierProfil) afficherProfil();
}

document.addEventListener("langue-changee", () => {
  rafraichirTextesDynamiques();
  if (!synchroEnCours) sauvegarderPreferencesServeur(["langue"]);
});

/* ---------- Toast ---------- */

let delaiToast;
function afficherToast(texte) {
  const toast = document.getElementById("toast");
  toast.textContent = texte;
  toast.classList.add("show");
  clearTimeout(delaiToast);
  delaiToast = setTimeout(() => toast.classList.remove("show"), 2500);
}

/* ---------- Demarrage ---------- */

appliquerTraductions();
rafraichirTextesDynamiques();
appliquerPreferenceAnimations();
document.getElementById("reglage-animations").checked = preferences.animations;
document.getElementById("reglage-vibrations").checked = preferences.vibrations;

// Reconnexion automatique (rafraichissement de page)
(function tenterReconnexionAutomatique() {
  const jetonSauvegarde = sessionStorage.getItem("pendu_token");
  const identifiantSauvegarde = sessionStorage.getItem("pendu_identifiant");
  const salleSauvegardee = sessionStorage.getItem("pendu_salle");
  if (!jetonSauvegarde || !identifiantSauvegarde) return;

  token = jetonSauvegarde;
  identifiant = identifiantSauvegarde;
  document.getElementById("nom-joueur").innerText = identifiant;
  rafraichirMoi();
  synchroniserPreferences();

  afficherEcran("ecran-salle");
  if (salleSauvegardee) {
    document.getElementById("message-salle").innerText = t("salle.reconnexion");
    rejoindreSocketSalle(salleSauvegardee);
  }
})();
