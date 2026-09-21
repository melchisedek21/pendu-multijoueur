"""Gestion de l'authentification : hashage des mots de passe et jetons JWT."""

import os
from datetime import datetime, timedelta

from jose import jwt, JWTError
from passlib.context import CryptContext

SECRET_KEY = os.getenv("SECRET_KEY", "change-moi-en-production")
ALGORITHME = "HS256"
DUREE_TOKEN_MINUTES = 60 * 24  # 24 heures

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hacher_mot_de_passe(mot_de_passe: str) -> str:
    """Transforme un mot de passe en clair en une empreinte securisee a stocker."""
    return pwd_context.hash(mot_de_passe)


def verifier_mot_de_passe(mot_de_passe: str, mot_de_passe_hache: str) -> bool:
    """Verifie qu'un mot de passe en clair correspond a l'empreinte stockee."""
    return pwd_context.verify(mot_de_passe, mot_de_passe_hache)


def creer_token(identifiant: str) -> str:
    """Cree un jeton JWT valide 24h pour un identifiant donne."""
    expiration = datetime.utcnow() + timedelta(minutes=DUREE_TOKEN_MINUTES)
    donnees = {"sub": identifiant, "exp": expiration}
    return jwt.encode(donnees, SECRET_KEY, algorithm=ALGORITHME)


def lire_identifiant_depuis_token(token: str) -> str | None:
    """Extrait l'identifiant d'un jeton JWT valide, ou None s'il est invalide/expire."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHME])
        return payload.get("sub")
    except JWTError:
        return None