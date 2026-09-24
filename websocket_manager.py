"""Gestion des salles de jeu en memoire (modes classique et imposteur, jusqu'a 6 joueurs)."""

import asyncio
import random
import string as string_module
from dataclasses import dataclass, field

from fastapi import WebSocket

from game_logic import ERREURS_MAX, calculer_points_contribution

MAX_JOUEURS = 6
MIN_JOUEURS_CLASSIQUE = 2
MIN_JOUEURS_IMPOSTEUR = 3

MANCHES_MIN = 1
MANCHES_MAX = 10

DUREE_MANCHE_DEFAUT = 180  # secondes (3 minutes) par manche
DELAI_RECONNEXION = 20  # secondes de grace avant de retirer definitivement un joueur deconnecte


@dataclass
class Joueur:
    """Un joueur connecte a une salle, avec son identifiant et sa connexion WebSocket."""

    identifiant: str
    websocket: WebSocket
    deconnecte: bool = False


@dataclass
class Salle:
    """L'etat complet d'une partie en cours dans une salle donnee."""

    code: str
    joueurs: list[Joueur] = field(default_factory=list)
    hote: str = ""
    mode: str = "classique"  # "classique" ou "imposteur"
    categorie: str = "informatique"
    difficulte: str = "facile"
    mot: str = ""
    indice: str = ""
    lettres_trouvees: set = field(default_factory=set)
    lettres_essayees: set = field(default_factory=set)
    erreurs: int = 0
    tour_index: int = 0
    phase: str = "attente"  # "attente" | "jeu" | "vote" | "fin_manche" | "fin_match"
    imposteurs: set = field(default_factory=set)
    votes: dict = field(default_factory=dict)  # votant -> cible

    # --- Systeme de manches (nombre choisi par l'hote) ---
    manches_total: int = 1
    manche_actuelle: int = 0

    # --- Classement par contribution (mode Classique uniquement) ---
    lettres_correctes_joueur: dict = field(default_factory=dict)  # identifiant -> nb lettres correctes cette manche
    points_match: dict = field(default_factory=dict)  # identifiant -> total de points cumules sur le match

    # --- Minuteur de manche, decompte en temps reel ---
    duree_manche: int = DUREE_MANCHE_DEFAUT
    temps_restant: int = 0
    tache_minuteur: object = field(default=None, repr=False, compare=False)

    # --- Reconnexion : delai de grace avant de retirer un joueur deconnecte ---
    taches_deconnexion: dict = field(default_factory=dict, repr=False, compare=False)  # identifiant -> Task

    # --- Minuteur par tour (bonus) : evite qu'un joueur bloque la partie trop longtemps ---
    duree_tour: int = 20
    temps_restant_tour: int = 0
    tache_minuteur_tour: object = field(default=None, repr=False, compare=False)


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
        salle = self.salles.pop(code, None)
        if salle:
            self.annuler_minuteur(salle)
            self.annuler_minuteur_tour(salle)
            for tache in salle.taches_deconnexion.values():
                tache.cancel()

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
            "hote": salle.hote,
            "joueurs": [j.identifiant for j in salle.joueurs],
            "joueurs_deconnectes": [j.identifiant for j in salle.joueurs if j.deconnecte],
            "categorie": salle.categorie,
            "difficulte": salle.difficulte,
            "mot_affiche": affichage_mot,
            "longueur_mot": len(salle.mot),
            "erreurs": salle.erreurs,
            "erreurs_max": ERREURS_MAX,
            "lettres_essayees": sorted(salle.lettres_essayees),
            "joueur_actuel": joueur_actuel,
            "manche_actuelle": salle.manche_actuelle,
            "manches_total": salle.manches_total,
            "temps_restant": salle.temps_restant,
            "duree_manche": salle.duree_manche,
            "temps_restant_tour": salle.temps_restant_tour,
            # Une fois la manche terminee, tout le monde a le droit de connaitre le mot (meme en cas de defaite)
            "mot_revele": salle.mot if salle.phase in ("fin_manche", "fin_match") else None,
            "delai_reconnexion": DELAI_RECONNEXION,
        }

        if salle.mode == "imposteur" and salle.phase in ("jeu", "vote"):
            est_imposteur = identifiant in salle.imposteurs
            etat["role"] = "imposteur" if est_imposteur else "innocent"
            etat["mot_complet"] = None if est_imposteur else salle.mot
            # L'imposteur recoit le meme indice que les autres : il ignore le mot, pas le theme
            etat["indice"] = salle.indice
        elif salle.mode == "imposteur":
            etat["role"] = None
            etat["mot_complet"] = None
            etat["indice"] = salle.indice if salle.phase != "attente" else None
        else:
            etat["indice"] = salle.indice

        return etat

    def attribuer_roles_imposteur(self, salle: Salle) -> None:
        """Choisit au hasard 1 ou 2 imposteurs parmi les joueurs de la salle."""
        identifiants = [j.identifiant for j in salle.joueurs]
        nombre_imposteurs = 2 if len(identifiants) >= 5 else 1
        salle.imposteurs = set(random.sample(identifiants, nombre_imposteurs))

    # ---------- Minuteur de manche ----------

    def annuler_minuteur(self, salle: Salle) -> None:
        """Arrete le minuteur en cours pour cette salle, s'il y en a un."""
        if salle.tache_minuteur:
            salle.tache_minuteur.cancel()
            salle.tache_minuteur = None

    def demarrer_minuteur(self, salle: Salle, on_temps_ecoule) -> None:
        """Lance un minuteur qui decompte le temps restant et le diffuse chaque seconde.

        `on_temps_ecoule` est une coroutine appelee avec `salle` quand le temps arrive a zero
        (evite un import circulaire avec main.py, qui gere la fin de manche).
        """
        self.annuler_minuteur(salle)

        async def _boucle() -> None:
            try:
                while salle.temps_restant > 0 and salle.phase == "jeu":
                    await asyncio.sleep(1)
                    if salle.phase != "jeu":
                        return
                    salle.temps_restant -= 1
                    await self.diffuser(salle, {"type": "tick", "temps_restant": salle.temps_restant})
                if salle.temps_restant <= 0 and salle.phase == "jeu":
                    await on_temps_ecoule(salle)
            except asyncio.CancelledError:
                pass

        salle.tache_minuteur = asyncio.create_task(_boucle())

    # ---------- Minuteur par tour (bonus) ----------

    def annuler_minuteur_tour(self, salle: Salle) -> None:
        """Arrete le minuteur de tour en cours, s'il y en a un."""
        if salle.tache_minuteur_tour:
            salle.tache_minuteur_tour.cancel()
            salle.tache_minuteur_tour = None

    def demarrer_minuteur_tour(self, salle: Salle, on_temps_ecoule_tour) -> None:
        """Lance un minuteur qui decompte le temps du joueur dont c'est le tour.

        S'il n'agit pas a temps, `on_temps_ecoule_tour(salle)` fait passer son tour.
        """
        self.annuler_minuteur_tour(salle)

        async def _boucle() -> None:
            try:
                while salle.temps_restant_tour > 0 and salle.phase == "jeu":
                    await asyncio.sleep(1)
                    if salle.phase != "jeu":
                        return
                    salle.temps_restant_tour -= 1
                    await self.diffuser(salle, {"type": "tick_tour", "temps_restant_tour": salle.temps_restant_tour})
                if salle.temps_restant_tour <= 0 and salle.phase == "jeu":
                    await on_temps_ecoule_tour(salle)
            except asyncio.CancelledError:
                pass

        salle.tache_minuteur_tour = asyncio.create_task(_boucle())

    # ---------- Reconnexion ----------

    def trouver_joueur(self, salle: Salle, identifiant: str) -> Joueur | None:
        """Retourne le Joueur correspondant a l'identifiant s'il est deja dans la salle."""
        for joueur in salle.joueurs:
            if joueur.identifiant == identifiant:
                return joueur
        return None

    def annuler_deconnexion(self, salle: Salle, identifiant: str) -> None:
        """Annule le retrait programme d'un joueur qui vient de se reconnecter."""
        tache = salle.taches_deconnexion.pop(identifiant, None)
        if tache:
            tache.cancel()

    def programmer_deconnexion(self, salle: Salle, code_salle: str, identifiant: str, on_expire) -> None:
        """Laisse un delai de grace avant de retirer definitivement un joueur deconnecte
        (permet de survivre a un rafraichissement de page ou une coupure reseau breve).
        """

        async def _attente() -> None:
            try:
                await asyncio.sleep(DELAI_RECONNEXION)
                salle.taches_deconnexion.pop(identifiant, None)
                await on_expire(salle, code_salle, identifiant)
            except asyncio.CancelledError:
                pass

        salle.taches_deconnexion[identifiant] = asyncio.create_task(_attente())

    # ---------- Classement par contribution (mode Classique) ----------

    def calculer_classement_manche(self, salle: Salle) -> list[dict]:
        """Classe les joueurs de la manche classique par nombre de bonnes lettres proposees.

        Le joueur ayant le plus contribue a trouver le mot est designe "gagnant" de la
        manche ; les points sont aussi cumules sur l'ensemble du match.
        """
        lignes = []
        for joueur in salle.joueurs:
            ident = joueur.identifiant
            lettres = salle.lettres_correctes_joueur.get(ident, 0)
            points_manche = calculer_points_contribution(lettres, salle.difficulte)
            salle.points_match[ident] = salle.points_match.get(ident, 0) + points_manche
            lignes.append({
                "identifiant": ident,
                "lettres_correctes": lettres,
                "points_manche": points_manche,
                "points_total": salle.points_match[ident],
            })
        lignes.sort(key=lambda ligne: ligne["points_manche"], reverse=True)
        return lignes


gestionnaire = GestionnaireSalles()