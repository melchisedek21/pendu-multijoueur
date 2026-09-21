"""Point d'entree de l'API du Pendu multijoueur (authentification + WebSocket, modes classique et imposteur)."""

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import Base, engine, get_db
from models import Utilisateur
from auth import hacher_mot_de_passe, verifier_mot_de_passe, creer_token, lire_identifiant_depuis_token
from game_logic import choisir_mot, calculer_score, ERREURS_MAX
from websocket_manager import (
    gestionnaire,
    Joueur,
    MAX_JOUEURS,
    MIN_JOUEURS_CLASSIQUE,
    MIN_JOUEURS_IMPOSTEUR,
)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Pendu Multijoueur")


class InscriptionRequete(BaseModel):
    identifiant: str
    mot_de_passe: str


class ConnexionRequete(BaseModel):
    identifiant: str
    mot_de_passe: str


@app.post("/api/inscription")
def inscription(donnees: InscriptionRequete, db: Session = Depends(get_db)):
    """Cree un nouveau compte utilisateur et retourne un jeton de connexion."""
    existant = db.query(Utilisateur).filter(Utilisateur.identifiant == donnees.identifiant).first()
    if existant:
        raise HTTPException(status_code=400, detail="Cet identifiant est deja pris.")

    if len(donnees.mot_de_passe) < 6:
        raise HTTPException(status_code=400, detail="Le mot de passe doit contenir au moins 6 caracteres.")

    utilisateur = Utilisateur(
        identifiant=donnees.identifiant,
        mot_de_passe_hache=hacher_mot_de_passe(donnees.mot_de_passe),
    )
    db.add(utilisateur)
    db.commit()

    token = creer_token(donnees.identifiant)
    return {"token": token, "identifiant": donnees.identifiant}


@app.post("/api/connexion")
def connexion(donnees: ConnexionRequete, db: Session = Depends(get_db)):
    """Connecte un utilisateur existant et retourne un jeton."""
    utilisateur = db.query(Utilisateur).filter(Utilisateur.identifiant == donnees.identifiant).first()
    if not utilisateur or not verifier_mot_de_passe(donnees.mot_de_passe, utilisateur.mot_de_passe_hache):
        raise HTTPException(status_code=401, detail="Identifiant ou mot de passe incorrect.")

    token = creer_token(donnees.identifiant)
    return {"token": token, "identifiant": donnees.identifiant}


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
    """Gere la connexion WebSocket d'un joueur dans une salle donnee."""
    identifiant = lire_identifiant_depuis_token(token)
    if not identifiant:
        await websocket.close(code=4001)
        return

    salle = gestionnaire.obtenir_salle(code_salle)
    if salle is None:
        await websocket.close(code=4004)
        return

    if len(salle.joueurs) >= MAX_JOUEURS:
        await websocket.close(code=4003)
        return

    await websocket.accept()

    joueur = Joueur(identifiant=identifiant, websocket=websocket)
    salle.joueurs.append(joueur)

    await gestionnaire.diffuser_etat(salle)

    try:
        while True:
            message = await websocket.receive_json()
            await traiter_message(salle, identifiant, message)
    except WebSocketDisconnect:
        salle.joueurs = [j for j in salle.joueurs if j.websocket != websocket]
        if not salle.joueurs:
            gestionnaire.supprimer_salle(code_salle)
        else:
            await gestionnaire.diffuser_etat(salle)


async def traiter_message(salle, identifiant: str, message: dict) -> None:
    """Aiguille chaque message recu vers le bon traitement selon son type."""
    type_message = message.get("type")

    if type_message == "demarrer":
        await demarrer_partie(salle, message)
    elif type_message == "proposer_lettre":
        await traiter_lettre(salle, identifiant, message)
    elif type_message == "voter":
        await traiter_vote(salle, identifiant, message)


async def demarrer_partie(salle, message: dict) -> None:
    """Demarre une partie, en mode classique ou imposteur selon la demande de l'hote."""
    if salle.phase not in ("attente", "termine"):
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

    salle.mode = mode
    salle.categorie = message.get("categorie", "informatique")
    salle.difficulte = message.get("difficulte", "facile")
    salle.mot = choisir_mot(salle.categorie, salle.difficulte)
    salle.lettres_trouvees = set()
    salle.lettres_essayees = set()
    salle.erreurs = 0
    salle.tour_index = 0
    salle.votes = {}
    salle.phase = "jeu"

    if mode == "imposteur":
        gestionnaire.attribuer_roles_imposteur(salle)
    else:
        salle.imposteurs = set()

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
    else:
        salle.erreurs += 1

    salle.tour_index = (salle.tour_index + 1) % len(salle.joueurs)

    mot_complet_trouve = all(l in salle.lettres_trouvees for l in salle.mot)
    erreurs_max_atteintes = salle.erreurs >= ERREURS_MAX

    if salle.mode == "imposteur" and (mot_complet_trouve or erreurs_max_atteintes):
        salle.phase = "vote"
        await gestionnaire.diffuser(salle, {"type": "debut_vote", "mot": salle.mot})
    elif salle.mode == "classique" and mot_complet_trouve:
        salle.phase = "termine"
        score = calculer_score(salle.mot, salle.erreurs, salle.difficulte)
        await gestionnaire.diffuser(salle, {
            "type": "fin_partie", "gagne": True, "mot": salle.mot, "score": score,
        })
    elif salle.mode == "classique" and erreurs_max_atteintes:
        salle.phase = "termine"
        await gestionnaire.diffuser(salle, {
            "type": "fin_partie", "gagne": False, "mot": salle.mot, "score": 0,
        })

    await gestionnaire.diffuser_etat(salle)


async def traiter_vote(salle, identifiant: str, message: dict) -> None:
    """Enregistre le vote d'un joueur et resout la partie une fois tous les votes recus."""
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

    # Tous les joueurs ont vote : on depouille
    compte_votes: dict[str, int] = {}
    for cible_votee in salle.votes.values():
        compte_votes[cible_votee] = compte_votes.get(cible_votee, 0) + 1

    max_votes = max(compte_votes.values())
    plus_votes = [ident for ident, nb in compte_votes.items() if nb == max_votes]

    # Egalite entre plusieurs joueurs = personne n'est clairement designe -> les imposteurs gagnent
    victoire_innocents = len(plus_votes) == 1 and plus_votes[0] in salle.imposteurs

    salle.phase = "termine"
    await gestionnaire.diffuser(salle, {
        "type": "resultat_vote",
        "votes": compte_votes,
        "joueur_designe": plus_votes[0] if len(plus_votes) == 1 else None,
        "imposteurs_reels": sorted(salle.imposteurs),
        "mot": salle.mot,
        "victoire_innocents": victoire_innocents,
    })


# Sert les fichiers du frontend (index.html, app.js, style.css) depuis le dossier static/
app.mount("/", StaticFiles(directory="static", html=True), name="static")