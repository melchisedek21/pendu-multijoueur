"""Gestion des salles de jeu en memoire (modes classique et imposteur, jusqu'a 6 joueurs)."""

import random
import string as string_module
from dataclasses import dataclass, field

from fastapi import WebSocket

from game_logic import ERREURS_MAX

MAX_JOUEURS = 6
MIN_JOUEURS_CLASSIQUE = 2
MIN_JOUEURS_IMPOSTEUR = 3


@dataclass
class Joueur:
    """Un joueur connecte a une salle, avec son identifiant et sa connexion WebSocket."""

    identifiant: str
    websocket: WebSocket


@dataclass
class Salle:
    """L'etat complet d'une partie en cours dans une salle donnee."""

    code: str
    joueurs: list[Joueur] = field(default_factory=list)
    mode: str = "classique"  # "classique" ou "imposteur"
    categorie: str = "informatique"
    difficulte: str = "facile"
    mot: str = ""
    lettres_trouvees: set = field(default_factory=set)
    lettres_essayees: set = field(default_factory=set)
    erreurs: int = 0
    tour_index: int = 0
    phase: str = "attente"  # "attente" | "jeu" | "vote" | "termine"
    imposteurs: set = field(default_factory=set)
    votes: dict = field(default_factory=dict)  # votant -> cible


class GestionnaireSalles:
    """Gere la creation, la jonction et l'etat de toutes les salles actives (en memoire)."""

    def __init__(self) -> None:
        self.salles: dict[str, Salle] = {}

    def generer_code_salle(self) -> str:
        """Genere un code de salle unique a 5 caracteres (lettres majuscules + chiffres)."""
        while True:
            code = "".join(random.choices(string_module.ascii_uppercase + string_module.digits, k=5))
            if code not in self.salles:
                return code

    def creer_salle(self) -> Salle:
        """Cree une nouvelle salle vide et l'enregistre."""
        code = self.generer_code_salle()
        salle = Salle(code=code)
        self.salles[code] = salle
        return salle

    def obtenir_salle(self, code: str) -> Salle | None:
        """Retourne la salle correspondant au code, ou None si elle n'existe pas."""
        return self.salles.get(code)

    def supprimer_salle(self, code: str) -> None:
        """Supprime une salle (appele quand tous les joueurs sont partis)."""
        self.salles.pop(code, None)

    async def diffuser(self, salle: Salle, message: dict) -> None:
        """Envoie un message JSON identique a tous les joueurs connectes de la salle."""
        for joueur in salle.joueurs:
            try:
                await joueur.websocket.send_json(message)
            except Exception:
                pass

    async def diffuser_etat(self, salle: Salle) -> None:
        """Envoie l'etat de la salle a chaque joueur, personnalise selon son role.

        En mode imposteur, chaque joueur recoit un message different :
        les innocents voient le mot complet, l'imposteur ne le voit jamais.
        """
        for joueur in salle.joueurs:
            etat = self._construire_etat_pour(salle, joueur.identifiant)
            try:
                await joueur.websocket.send_json(etat)
            except Exception:
                pass

    def _construire_etat_pour(self, salle: Salle, identifiant: str) -> dict:
        """Construit le message d'etat destine a UN joueur precis."""
        affichage_mot = " ".join(
            lettre if lettre in salle.lettres_trouvees else "_" for lettre in salle.mot
        )
        joueur_actuel = (
            salle.joueurs[salle.tour_index].identifiant
            if salle.joueurs and salle.phase == "jeu"
            else None
        )

        etat = {
            "type": "etat_jeu",
            "mode": salle.mode,
            "phase": salle.phase,
            "joueurs": [j.identifiant for j in salle.joueurs],
            "categorie": salle.categorie,
            "difficulte": salle.difficulte,
            "mot_affiche": affichage_mot,
            "longueur_mot": len(salle.mot),
            "erreurs": salle.erreurs,
            "erreurs_max": ERREURS_MAX,
            "lettres_essayees": sorted(salle.lettres_essayees),
            "joueur_actuel": joueur_actuel,
        }

        if salle.mode == "imposteur" and salle.phase in ("jeu", "vote"):
            est_imposteur = identifiant in salle.imposteurs
            etat["role"] = "imposteur" if est_imposteur else "innocent"
            etat["mot_complet"] = None if est_imposteur else salle.mot
        elif salle.mode == "imposteur":
            etat["role"] = None
            etat["mot_complet"] = None

        return etat

    def attribuer_roles_imposteur(self, salle: Salle) -> None:
        """Choisit au hasard 1 ou 2 imposteurs parmi les joueurs de la salle."""
        identifiants = [j.identifiant for j in salle.joueurs]
        nombre_imposteurs = 2 if len(identifiants) >= 5 else 1
        salle.imposteurs = set(random.sample(identifiants, nombre_imposteurs))


gestionnaire = GestionnaireSalles()