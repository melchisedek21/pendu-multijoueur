"""Logique du jeu du Pendu : mots, difficulte, calcul du score (adapte du projet original)."""

import random

CATEGORIES: dict[str, list[str]] = {
    "informatique": ["python", "ordinateur", "clavier", "reseau", "logiciel", "serveur", "programme"],
    "cybersecurite": ["hacker", "virus", "pentest", "firewall", "malware", "phishing", "chiffrement"],
    "animaux": ["elephant", "girafe", "kangourou", "tortue", "dauphin", "hibou", "rhinoceros"],
}

DIFFICULTES: dict[str, tuple[int, int]] = {
    "facile": (4, 6),
    "moyen": (7, 9),
    "difficile": (10, 99),
}

MULTIPLICATEUR_SCORE: dict[str, float] = {"facile": 1, "moyen": 1.5, "difficile": 2}

ERREURS_MAX = 6


def choisir_mot(categorie: str, difficulte: str) -> str:
    """Choisit un mot au hasard dans une categorie, filtre par la plage de longueur de la difficulte."""
    min_len, max_len = DIFFICULTES.get(difficulte, (0, 99))
    mots_disponibles = CATEGORIES.get(categorie, CATEGORIES["informatique"])
    mots_possibles = [m for m in mots_disponibles if min_len <= len(m) <= max_len]
    if not mots_possibles:
        mots_possibles = mots_disponibles
    return random.choice(mots_possibles)


def calculer_score(mot: str, erreurs: int, difficulte: str) -> int:
    """Calcule le score final selon la longueur du mot, les erreurs et la difficulte."""
    base = len(mot) * 10
    penalite = erreurs * 5
    score = (base - penalite) * MULTIPLICATEUR_SCORE.get(difficulte, 1)
    return max(0, round(score))