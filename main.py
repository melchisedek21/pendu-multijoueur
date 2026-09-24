"""Point d'entree de l'API du Pendu multijoueur (authentification + WebSocket, modes classique et imposteur)."""

import re

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import Base, engine, get_db, SessionLocal
from models import Utilisateur, Score
from auth import hacher_mot_de_passe, verifier_mot_de_passe, creer_token, lire_identifiant_depuis_token
from game_logic import choisir_mot_et_indice, ERREURS_MAX
from websocket_manager import (
    gestionnaire,
    Joueur,
    MAX_JOUEURS,
    MIN_JOUEURS_CLASSIQUE,
    MIN_JOUEURS_IMPOSTEUR,
    MANCHES_MIN,
    MANCHES_MAX,
)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Pendu Multijoueur")

IDENTIFIANT_REGEX = re.compile(r"^[A-Za-z0-9_]{3,20}$")


def valider_identifiant(identifiant: str) -> str:
    """Verifie que l'identifiant respecte le format attendu, leve une erreur sinon."""
    identifiant = identifiant.strip()
    if not IDENTIFIANT_REGEX.match(identifiant):
        raise HTTPException(
            status_code=400,
            detail="L'identifiant doit contenir entre 3 et 20 caracteres : lettres, chiffres ou underscore uniquement.",
        )
    return identifiant


class InscriptionRequete(BaseModel):
    identifiant: str
    mot_de_passe: str


class ConnexionRequete(BaseModel):
    identifiant: str
    mot_de_passe: str


@app.post("/api/inscription")
def inscription(donnees: InscriptionRequete, db: Session = Depends(get_db)):
    """Cree un nouveau compte utilisateur et retourne un jeton de connexion."""
    identifiant = valider_identifiant(donnees.identifiant)

    if len(donnees.mot_de_passe) < 6:
        raise HTTPException(status_code=400, detail="Le mot de passe doit contenir au moins 6 caracteres.")
    if len(donnees.mot_de_passe) > 72:
        raise HTTPException(status_code=400, detail="Le mot de passe ne doit pas depasser 72 caracteres.")

    existant = db.query(Utilisateur).filter(Utilisateur.identifiant == identifiant).first()
    if existant:
        raise HTTPException(status_code=400, detail="Cet identifiant est deja pris.")

    utilisateur = Utilisateur(
        identifiant=identifiant,
        mot_de_passe_hache=hacher_mot_de_passe(donnees.mot_de_passe),
    )
    db.add(utilisateur)
    db.commit()

    token = creer_token(identifiant)
    return {"token": token, "identifiant": identifiant}


@app.post("/api/connexion")
def connexion(donnees: ConnexionRequete, db: Session = Depends(get_db)):
    """Connecte un utilisateur existant et retourne un jeton."""
    identifiant = donnees.identifiant.strip()
    utilisateur = db.query(Utilisateur).filter(Utilisateur.identifiant == identifiant).first()
    if not utilisateur or not verifier_mot_de_passe(donnees.mot_de_passe, utilisateur.mot_de_passe_hache):
        raise HTTPException(status_code=401, detail="Identifiant ou mot de passe incorrect.")

    token = creer_token(identifiant)
    return {"token": token, "identifiant": identifiant}


@app.get("/api/scores")
def obtenir_scores(token: str, db: Session = Depends(get_db)):
    """Retourne les 20 derniers scores enregistres pour l'utilisateur du jeton (historique)."""
    identifiant = lire_identifiant_depuis_token(token)
    if not identifiant:
        raise HTTPException(status_code=401, detail="Jeton invalide ou expire.")

    utilisateur = db.query(Utilisateur).filter(Utilisateur.identifiant == identifiant).first()
    if not utilisateur:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")

    scores = (
        db.query(Score)
        .filter(Score.utilisateur_id == utilisateur.id)
        .order_by(Score.date_partie.desc())
        .limit(20)
        .all()
    )
    return [
        {
            "points": s.points,
            "difficulte": s.difficulte,
            "mot": s.mot,
            "date_partie": s.date_partie.isoformat() if s.date_partie else None,
        }
        for s in scores
    ]


@app.post("/api/salle/creer")
def creer_salle(token: str):
    """Cree une nouvelle salle de jeu et retourne son code a 5 caracteres."""
    identifiant = lire_identifiant_depuis_token(token)
    if not identifiant:
        raise HTTPException(status_code=401, detail="Jeton invalide ou expire.")
    salle = gestionnaire.creer_salle()
    return {"code_salle": salle.code}


@app.websocket("/ws/{code_salle}")
async def websocket_jeu(websocket: WebSocket, code_salle: str, token: str):
    """Gere la connexion WebSocket d'un joueur dans une salle donnee (avec reconnexion)."""
    identifiant = lire_identifiant_depuis_token(token)
    if not identifiant:
        await websocket.close(code=4001)
        return

    salle = gestionnaire.obtenir_salle(code_salle)
    if salle is None:
        await websocket.close(code=4004)
        return

    joueur_existant = gestionnaire.trouver_joueur(salle, identifiant)

    if joueur_existant is None and len(salle.joueurs) >= MAX_JOUEURS:
        await websocket.close(code=4003)
        return

    await websocket.accept()

    if joueur_existant is not None:
        # Reconnexion (rafraichissement de page, coupure reseau...) : on reprend la place existante.
        gestionnaire.annuler_deconnexion(salle, identifiant)
        joueur_existant.websocket = websocket
        joueur_existant.deconnecte = False
    else:
        if not salle.joueurs:
            salle.hote = identifiant
        salle.joueurs.append(Joueur(identifiant=identifiant, websocket=websocket))

    await gestionnaire.diffuser_etat(salle)

    try:
        while True:
            message = await websocket.receive_json()
            await traiter_message(salle, identifiant, message)
    except WebSocketDisconnect:
        joueur_actuel = gestionnaire.trouver_joueur(salle, identifiant)
        if joueur_actuel is None or joueur_actuel.websocket is not websocket:
            return  # deja remplace par une reconnexion plus recente, rien a faire ici

        if gestionnaire.obtenir_salle(code_salle) is not salle:
            return  # la salle a deja ete fermee (ex. : l'hote est parti), rien a faire

        joueur_actuel.deconnecte = True
        await gestionnaire.diffuser_etat(salle)
        gestionnaire.programmer_deconnexion(salle, code_salle, identifiant, finaliser_deconnexion)


async def finaliser_deconnexion(salle, code_salle: str, identifiant: str) -> None:
    """Retire definitivement un joueur qui ne s'est pas reconnecte dans le delai de grace."""
    joueur = gestionnaire.trouver_joueur(salle, identifiant)
    if joueur is None or not joueur.deconnecte:
        return  # il s'est reconnecte entre-temps, rien a faire
    await retirer_joueur(salle, code_salle, identifiant)


async def retirer_joueur(salle, code_salle: str, identifiant: str) -> None:
    """Retire un joueur de la salle (depart volontaire ou delai de reconnexion expire).

    Si c'est l'hote, la salle est fermee et tous les autres joueurs sont renvoyes a l'accueil.
    """
    if gestionnaire.obtenir_salle(code_salle) is not salle:
        return

    gestionnaire.annuler_deconnexion(salle, identifiant)
    index_parti = next((i for i, j in enumerate(salle.joueurs) if j.identifiant == identifiant), None)
    if index_parti is None:
        return
    salle.joueurs.pop(index_parti)

    if not salle.joueurs:
        gestionnaire.supprimer_salle(code_salle)
        return

    if salle.hote == identifiant:
        # L'hote a quitte pour de bon : on ferme la salle et on renvoie tout le monde a l'accueil,
        # au lieu de transferer silencieusement l'hote a un autre joueur.
        restants = list(salle.joueurs)
        salle.joueurs = []
        gestionnaire.supprimer_salle(code_salle)
        for joueur_restant in restants:
            try:
                await joueur_restant.websocket.send_json({
                    "type": "salle_fermee",
                    "message": f"L'hote ({identifiant}) a quitte la salle. La partie est terminee.",
                })
                await joueur_restant.websocket.close(code=4005)
            except Exception:
                pass
        return

    # Garde un tour coherent : si le joueur parti etait avant (ou a) l'index du tour, on recale.
    if index_parti < salle.tour_index:
        salle.tour_index -= 1
    salle.tour_index %= len(salle.joueurs)
    salle.votes = {votant: cible for votant, cible in salle.votes.items()
                   if votant != identifiant and cible != identifiant}

    await gestionnaire.diffuser(salle, {
        "type": "chat_recu", "auteur": "Systeme", "texte": f"{identifiant} a quitte la salle.",
    })

    if salle.phase in ("jeu", "vote") and len(salle.joueurs) < MIN_JOUEURS_CLASSIQUE:
        # Plus assez de joueurs pour continuer : retour en salle d'attente.
        gestionnaire.annuler_minuteur(salle)
        gestionnaire.annuler_minuteur_tour(salle)
        salle.phase = "attente"
        await gestionnaire.diffuser(salle, {
            "type": "erreur", "message": "Plus assez de joueurs : la partie est interrompue.",
        })
    elif salle.phase == "jeu":
        salle.temps_restant_tour = salle.duree_tour
        gestionnaire.demarrer_minuteur_tour(salle, on_temps_ecoule_tour)
    elif salle.phase == "vote" and len(salle.votes) >= len(salle.joueurs):
        await resoudre_vote(salle)
        return

    await gestionnaire.diffuser_etat(salle)


async def traiter_message(salle, identifiant: str, message: dict) -> None:
    """Aiguille chaque message recu vers le bon traitement selon son type."""
    type_message = message.get("type")

    if type_message == "quitter":
        await retirer_joueur(salle, salle.code, identifiant)
    elif type_message == "demarrer":
        await demarrer_partie(salle, identifiant, message)
    elif type_message == "manche_suivante":
        await manche_suivante(salle, identifiant)
    elif type_message == "proposer_lettre":
        await traiter_lettre(salle, identifiant, message)
    elif type_message == "voter":
        await traiter_vote(salle, identifiant, message)
    elif type_message == "chat":
        await traiter_chat(salle, identifiant, message)


async def traiter_chat(salle, identifiant: str, message: dict) -> None:
    """Diffuse un message de chat a tous les joueurs de la salle."""
    texte = str(message.get("texte", "")).strip()
    if not texte:
        return
    texte = texte[:300]  # limite raisonnable pour eviter les abus
    await gestionnaire.diffuser(salle, {
        "type": "chat_recu",
        "auteur": identifiant,
        "texte": texte,
    })


def clamp(valeur: int, mini: int, maxi: int) -> int:
    return max(mini, min(maxi, valeur))


async def demarrer_partie(salle, identifiant: str, message: dict) -> None:
    """Demarre un nouveau match (1re manche), en mode classique ou imposteur, avec un nombre
    de manches choisi par l'hote. Peut etre relance depuis l'ecran de fin de match ("rejouer" /
    "changer les parametres").
    """
    if salle.phase not in ("attente", "fin_match"):
        return

    if identifiant != salle.hote:
        await gestionnaire.diffuser(salle, {
            "type": "erreur",
            "message": f"Seul l'hote ({salle.hote}) peut demarrer la partie.",
        })
        return

    mode = message.get("mode", "classique")
    nombre_joueurs = len(salle.joueurs)

    if mode == "imposteur" and nombre_joueurs < MIN_JOUEURS_IMPOSTEUR:
        await gestionnaire.diffuser(salle, {
            "type": "erreur",
            "message": f"Il faut au moins {MIN_JOUEURS_IMPOSTEUR} joueurs pour le mode Imposteur.",
        })
        return
    if mode == "classique" and nombre_joueurs < MIN_JOUEURS_CLASSIQUE:
        await gestionnaire.diffuser(salle, {
            "type": "erreur",
            "message": f"Il faut au moins {MIN_JOUEURS_CLASSIQUE} joueurs pour demarrer.",
        })
        return

    try:
        manches = int(message.get("manches", 1))
    except (TypeError, ValueError):
        manches = 1

    salle.mode = mode
    salle.categorie = message.get("categorie", "informatique")
    salle.difficulte = message.get("difficulte", "facile")
    salle.manches_total = clamp(manches, MANCHES_MIN, MANCHES_MAX)
    salle.manche_actuelle = 0
    salle.points_match = {}

    await preparer_nouvelle_manche(salle)


async def manche_suivante(salle, identifiant: str) -> None:
    """L'hote enchaine sur la manche suivante apres l'ecran de fin de manche."""
    if salle.phase != "fin_manche" or identifiant != salle.hote:
        return
    await preparer_nouvelle_manche(salle)


async def preparer_nouvelle_manche(salle) -> None:
    """Choisit un nouveau mot, reinitialise l'etat de jeu et lance les minuteurs de la manche."""
    salle.manche_actuelle += 1
    salle.mot, salle.indice = choisir_mot_et_indice(salle.categorie, salle.difficulte)
    salle.lettres_trouvees = set()
    salle.lettres_essayees = set()
    salle.erreurs = 0
    salle.tour_index = 0
    salle.votes = {}
    salle.lettres_correctes_joueur = {}
    salle.temps_restant = salle.duree_manche
    salle.temps_restant_tour = salle.duree_tour
    salle.phase = "jeu"

    if salle.mode == "imposteur":
        gestionnaire.attribuer_roles_imposteur(salle)
    else:
        salle.imposteurs = set()

    gestionnaire.demarrer_minuteur(salle, on_temps_ecoule_manche)
    gestionnaire.demarrer_minuteur_tour(salle, on_temps_ecoule_tour)
    await gestionnaire.diffuser_etat(salle)


async def on_temps_ecoule_manche(salle) -> None:
    """Appele par le minuteur quand le temps de la manche est completement ecoule."""
    if salle.phase != "jeu":
        return
    if salle.mode == "imposteur":
        # Comme pour les erreurs max : le temps ecoule declenche la phase de vote.
        gestionnaire.annuler_minuteur_tour(salle)
        salle.phase = "vote"
        await gestionnaire.diffuser(salle, {"type": "debut_vote", "mot": salle.mot})
        await gestionnaire.diffuser_etat(salle)
    else:
        await terminer_manche_classique(salle, gagne=False)


async def on_temps_ecoule_tour(salle) -> None:
    """Le joueur dont c'etait le tour n'a pas agi a temps : son tour est saute."""
    if salle.phase != "jeu" or not salle.joueurs:
        return
    joueur_saute = salle.joueurs[salle.tour_index].identifiant
    salle.tour_index = (salle.tour_index + 1) % len(salle.joueurs)
    salle.temps_restant_tour = salle.duree_tour
    gestionnaire.demarrer_minuteur_tour(salle, on_temps_ecoule_tour)
    await gestionnaire.diffuser(salle, {"type": "tour_saute", "joueur": joueur_saute})
    await gestionnaire.diffuser_etat(salle)


async def terminer_manche_classique(salle, gagne: bool) -> None:
    """Termine une manche en mode Classique : classement par contribution (bonnes lettres
    proposees), au lieu d'une simple victoire/defaite d'equipe. Si c'est la derniere manche
    du match, calcule aussi le classement final et l'enregistre en base.
    """
    gestionnaire.annuler_minuteur(salle)
    gestionnaire.annuler_minuteur_tour(salle)

    classement = gestionnaire.calculer_classement_manche(salle)
    manche_finale = salle.manche_actuelle >= salle.manches_total
    salle.phase = "fin_match" if manche_finale else "fin_manche"

    await gestionnaire.diffuser(salle, {
        "type": "fin_manche",
        "gagne": gagne,
        "mot": salle.mot,
        "classement": classement,
        "manche_actuelle": salle.manche_actuelle,
        "manches_total": salle.manches_total,
        "manche_finale": manche_finale,
    })

    if manche_finale:
        enregistrer_scores_classique(salle, classement)
        classement_final = sorted(classement, key=lambda ligne: ligne["points_total"], reverse=True)
        await gestionnaire.diffuser(salle, {
            "type": "fin_match",
            "mot": salle.mot,
            "gagne": gagne,
            "classement_final": classement_final,
        })

    await gestionnaire.diffuser_etat(salle)


async def traiter_lettre(salle, identifiant: str, message: dict) -> None:
    """Traite la proposition d'une lettre par le joueur dont c'est le tour."""
    if salle.phase != "jeu":
        return

    joueur_actuel = salle.joueurs[salle.tour_index].identifiant
    if identifiant != joueur_actuel:
        return  # Ce n'est pas le tour de ce joueur : on ignore le message

    lettre = str(message.get("lettre", "")).lower().strip()
    if len(lettre) != 1 or not lettre.isalpha() or not lettre.isascii():
        return
    if lettre in salle.lettres_essayees:
        return

    salle.lettres_essayees.add(lettre)
    if lettre in salle.mot:
        salle.lettres_trouvees.add(lettre)
        salle.lettres_correctes_joueur[identifiant] = salle.lettres_correctes_joueur.get(identifiant, 0) + 1
    else:
        salle.erreurs += 1

    salle.tour_index = (salle.tour_index + 1) % len(salle.joueurs)
    salle.temps_restant_tour = salle.duree_tour
    gestionnaire.demarrer_minuteur_tour(salle, on_temps_ecoule_tour)

    mot_complet_trouve = all(l in salle.lettres_trouvees for l in salle.mot)
    erreurs_max_atteintes = salle.erreurs >= ERREURS_MAX

    if salle.mode == "imposteur" and (mot_complet_trouve or erreurs_max_atteintes):
        gestionnaire.annuler_minuteur_tour(salle)
        salle.phase = "vote"
        await gestionnaire.diffuser(salle, {"type": "debut_vote", "mot": salle.mot})
    elif salle.mode == "classique" and mot_complet_trouve:
        await terminer_manche_classique(salle, gagne=True)
        return
    elif salle.mode == "classique" and erreurs_max_atteintes:
        await terminer_manche_classique(salle, gagne=False)
        return

    await gestionnaire.diffuser_etat(salle)


async def traiter_vote(salle, identifiant: str, message: dict) -> None:
    """Enregistre le vote d'un joueur et resout la manche une fois tous les votes recus."""
    if salle.phase != "vote":
        return

    cible = message.get("cible")
    identifiants_valides = [j.identifiant for j in salle.joueurs]
    if cible not in identifiants_valides:
        return

    salle.votes[identifiant] = cible

    if len(salle.votes) < len(salle.joueurs):
        await gestionnaire.diffuser(salle, {
            "type": "vote_recu", "nombre_votes": len(salle.votes), "total_joueurs": len(salle.joueurs),
        })
        return

    await resoudre_vote(salle)


async def resoudre_vote(salle) -> None:
    """Tous les joueurs ont vote : on depouille et on termine la manche imposteur."""
    compte_votes: dict[str, int] = {}
    for cible_votee in salle.votes.values():
        compte_votes[cible_votee] = compte_votes.get(cible_votee, 0) + 1

    max_votes = max(compte_votes.values())
    plus_votes = [ident for ident, nb in compte_votes.items() if nb == max_votes]

    # Egalite entre plusieurs joueurs = personne n'est clairement designe -> les imposteurs gagnent
    victoire_innocents = len(plus_votes) == 1 and plus_votes[0] in salle.imposteurs

    manche_finale = salle.manche_actuelle >= salle.manches_total
    salle.phase = "fin_match" if manche_finale else "fin_manche"

    await gestionnaire.diffuser(salle, {
        "type": "resultat_vote",
        "votes": compte_votes,
        "joueur_designe": plus_votes[0] if len(plus_votes) == 1 else None,
        "imposteurs_reels": sorted(salle.imposteurs),
        "mot": salle.mot,
        "victoire_innocents": victoire_innocents,
        "manche_actuelle": salle.manche_actuelle,
        "manches_total": salle.manches_total,
        "manche_finale": manche_finale,
    })

    if manche_finale:
        enregistrer_scores_imposteur(salle, victoire_innocents)
        await gestionnaire.diffuser(salle, {
            "type": "fin_match",
            "mot": salle.mot,
            "victoire_innocents": victoire_innocents,
            "imposteurs_reels": sorted(salle.imposteurs),
        })

    await gestionnaire.diffuser_etat(salle)


def enregistrer_scores_classique(salle, classement: list[dict]) -> None:
    """Enregistre en base les points cumules par chaque joueur a la fin du match (mode Classique)."""
    try:
        db = SessionLocal()
        try:
            for ligne in classement:
                if ligne["points_total"] <= 0:
                    continue
                utilisateur = db.query(Utilisateur).filter(Utilisateur.identifiant == ligne["identifiant"]).first()
                if not utilisateur:
                    continue
                db.add(Score(
                    utilisateur_id=utilisateur.id,
                    points=ligne["points_total"],
                    difficulte=salle.difficulte,
                    mot=salle.mot,
                ))
            db.commit()
        finally:
            db.close()
    except Exception:
        pass  # L'historique ne doit jamais faire planter la partie en cours


def enregistrer_scores_imposteur(salle, victoire_innocents: bool) -> None:
    """Enregistre en base un score simplifie pour le mode Imposteur (100 pts au camp gagnant)."""
    try:
        db = SessionLocal()
        try:
            for joueur in salle.joueurs:
                est_imposteur = joueur.identifiant in salle.imposteurs
                a_gagne = (victoire_innocents and not est_imposteur) or (not victoire_innocents and est_imposteur)
                if not a_gagne:
                    continue
                utilisateur = db.query(Utilisateur).filter(Utilisateur.identifiant == joueur.identifiant).first()
                if not utilisateur:
                    continue
                db.add(Score(utilisateur_id=utilisateur.id, points=100, difficulte=salle.difficulte, mot=salle.mot))
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


# Sert les fichiers du frontend (index.html, app.js, style.css) depuis le dossier static/
app.mount("/", StaticFiles(directory="static", html=True), name="static")