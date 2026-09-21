"""Modeles de base de donnees : utilisateurs et scores."""

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from database import Base


class Utilisateur(Base):
    """Un compte joueur, identifie par un identifiant unique choisi a l'inscription."""

    __tablename__ = "utilisateurs"

    id = Column(Integer, primary_key=True, index=True)
    identifiant = Column(String, unique=True, index=True, nullable=False)
    mot_de_passe_hache = Column(String, nullable=False)
    date_creation = Column(DateTime(timezone=True), server_default=func.now())

    scores = relationship("Score", back_populates="utilisateur")


class Score(Base):
    """Un score obtenu par un utilisateur lors d'une partie terminee."""

    __tablename__ = "scores"

    id = Column(Integer, primary_key=True, index=True)
    utilisateur_id = Column(Integer, ForeignKey("utilisateurs.id"))
    points = Column(Integer, nullable=False)
    difficulte = Column(String, nullable=False)
    mot = Column(String, nullable=False)
    date_partie = Column(DateTime(timezone=True), server_default=func.now())

    utilisateur = relationship("Utilisateur", back_populates="scores")