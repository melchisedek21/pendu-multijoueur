"""Configuration de la base de donnees (SQLite par defaut, PostgreSQL en production via DATABASE_URL)."""

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./pendu.db")
# Certains hebergeurs fournissent encore l'ancien prefixe "postgres://", refuse par SQLAlchemy 2
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """Fournit une session de base de donnees, fermee automatiquement apres usage."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()